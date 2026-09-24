/**
 * 文件工具 —— Phase 7。
 *
 *   read_file   读文件（带行号，支持 offset/limit，有大小上限）
 *   write_file  原子写（先写临时文件再 rename）
 *   edit_file   精确字符串替换，找不到或不唯一时**报错而不是猜**
 *
 * 所有路径都过 resolveWithin()，逃不出工作目录。
 */

import { statSync } from "node:fs";
import { chmod, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JSONSchema } from "../provider/types.ts";
import type { ResourceClaim } from "./locks.ts";
import type { Tool, ToolCtx } from "./types.ts";
import { relativeTo, resolveWithin } from "./paths.ts";
import { compactDiff, diffLines, formatDiff, type DiffLine } from "./diff.ts";

export const MAX_READ_LINES = 500;

export interface ReadWindow {
  /** 形如 `"12\t内容"` 的行。 */
  entries: string[];
  /** 已读到的最后一个行号。 */
  lastLine: number;
  /** 是否读到了文件末尾（决定能不能报告总行数）。 */
  reachedEnd: boolean;
  /** 是否因为扫描上限而提前停下。 */
  hitScanLimit: boolean;
  /** 是否有单行超长被截断。 */
  clippedLine: boolean;
  /** 文件总行数 —— 只有 reachedEnd 时才准确。 */
  totalLines: number;
}

/**
 * 流式读取一个行窗口。
 *
 * 为什么不用 `Bun.file().text()`：那会把整个文件读进内存再截断。
 * 对 1GB 的文件，用户可能只想看前 50 行，读完整份既慢又浪费内存。
 * 流式读够就停，代价与"要看多少"成正比，而不是与"文件多大"成正比。
 */
async function readWindow(
  path: string,
  options: { startLine: number; maxLines: number; maxChars: number; maxScanBytes: number },
): Promise<ReadWindow> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();

  const entries: string[] = [];
  let pending = "";
  let lineNumber = 0;
  let chars = 0;
  let scanned = 0;
  let reachedEnd = false;
  let hitScanLimit = false;
  let clippedLine = false;

  const hasRoom = (): boolean => entries.length < options.maxLines && chars < options.maxChars;

  const consume = (line: string): void => {
    lineNumber += 1;
    if (lineNumber < options.startLine || !hasRoom()) return;

    let entry = `${lineNumber}\t${line}`;
    if (entry.length > options.maxChars) {
      entry = `${entry.slice(0, options.maxChars)}…[本行超长，已截断]`;
      clippedLine = true;
    }
    entries.push(entry);
    chars += entry.length + 1;
  };

  try {
    while (hasRoom()) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }
      if (value === undefined) continue;

      // 二进制检测放在流里做 —— 不能等读完再查 NUL，那样大二进制文件会先撑爆内存
      if (value.includes(0)) {
        throw new Error("__BINARY__");
      }

      scanned += value.byteLength;
      pending += decoder.decode(value, { stream: true });

      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (!hasRoom()) break;
        newline = pending.indexOf("\n");
      }

      if (scanned >= options.maxScanBytes) {
        hitScanLimit = true;
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  // 读到末尾时把最后一段（没有换行结尾的行）也收进来
  if (reachedEnd) {
    pending += decoder.decode();
    if (pending.length > 0) consume(pending);
  }

  return {
    entries,
    lastLine: lineNumber,
    reachedEnd,
    hitScanLimit,
    clippedLine,
    totalLines: reachedEnd ? lineNumber : -1,
  };
}
/** 回传给模型的字符上限（与行数上限谁先到算谁）。 */
export const MAX_READ_CHARS = 9000;
/**
 * 单次读取最多**扫过**多少字节。
 *
 * 注意这不再是"文件大小上限"，而是"愿意扫多远"：
 * 读 1GB 日志的前 50 行只需要扫几十 KB，完全可以。
 * 只有当你 offset 到一个很靠后的位置时才会撞上这个限制。
 */
export const MAX_READ_SCAN_BYTES = 8 * 1024 * 1024;
export const MAX_WRITE_BYTES = 8 * 1024 * 1024;

/** 文件工具的锁粒度：解析到工作区内的相对路径，避免同一文件被不同写法绕过。 */
function fileResource(
  input: unknown,
  ctx: ToolCtx,
  access: "read" | "write",
): readonly ResourceClaim[] {
  const rawPath = (input as { path?: unknown } | null)?.path;
  if (typeof rawPath !== "string") return [];
  const absolute = resolveWithin(ctx.cwd, rawPath);
  const relative = relativeTo(ctx.cwd, absolute).replaceAll("\\", "/");
  return [{ key: `workspace/${relative}`, access }];
}

/* ------------------------------------------------------------------ */
/* read_file                                                           */
/* ------------------------------------------------------------------ */

export interface ReadFileInput {
  path?: unknown;
  /** 起始行号，1-based。 */
  offset?: unknown;
  /** 最多读多少行。 */
  limit?: unknown;
}

export const READ_FILE_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "相对工作目录的文件路径" },
    offset: { type: "number", description: "起始行号（1-based），默认 1" },
    limit: { type: "number", description: `最多读取行数，默认 ${MAX_READ_LINES}` },
  },
  required: ["path"],
};

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} 必须是字符串`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} 必须是正整数`);
  }
  return value;
}

export function createReadFileTool(): Tool<ReadFileInput, string> {
  return {
    name: "read_file",
    description: [
      "读取工作目录下的文本文件，返回带行号的内容。",
      "大文件用 offset / limit 分段读取。",
    ].join(" "),
    parameters: READ_FILE_PARAMETERS,

    resources(input, ctx) {
      return fileResource(input, ctx, "read");
    },

    describe(input: unknown) {
      const path = typeof (input as ReadFileInput | null)?.path === "string" ? (input as ReadFileInput).path : "";
      return { resource: String(path), summary: `读取文件 ${path}` };
    },

    async run(input: ReadFileInput, ctx: ToolCtx): Promise<string> {
      // 先校验入参再碰文件系统：参数错了就该立刻报错，不该被"文件不存在"掩盖
      const rawPath = requireString(input.path, "path");
      const offset = optionalPositiveInt(input.offset, "offset") ?? 1;
      const limit = Math.min(
        optionalPositiveInt(input.limit, "limit") ?? MAX_READ_LINES,
        MAX_READ_LINES,
      );

      const absolute = resolveWithin(ctx.cwd, rawPath);
      const display = relativeTo(ctx.cwd, absolute);

      // 目录单独判断：否则 size 是 0，会掉进"文件不存在"分支，报错完全误导
      if (statSync(absolute, { throwIfNoEntry: false })?.isDirectory() === true) {
        throw new Error(`这是一个目录，不是文件：${display}。用 bash 的 ls 查看里面有什么`);
      }

      const file = Bun.file(absolute);
      if (!(await file.exists())) {
        throw new Error(`文件不存在：${display}`);
      }

      let window: ReadWindow;
      try {
        window = await readWindow(absolute, {
          startLine: offset,
          maxLines: limit,
          maxChars: MAX_READ_CHARS,
          maxScanBytes: MAX_READ_SCAN_BYTES,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "__BINARY__") {
          throw new Error(`拒绝读取二进制文件：${display}`);
        }
        throw error;
      }

      if (window.entries.length === 0 && window.reachedEnd) {
        if (offset > 1) {
          throw new Error(`offset ${offset} 超出文件总行数 ${window.totalLines}`);
        }
        return `# ${display}（空文件）`;
      }

      const numbered = window.entries.join("\n");
      const lastLine = window.lastLine;
      const totalKnown = window.totalLines >= 0;

      const notes: string[] = [];
      if (totalKnown) {
        if (lastLine < window.totalLines) {
          notes.push(`还有 ${window.totalLines - lastLine} 行未显示，用 offset=${lastLine + 1} 继续读`);
        }
      } else {
        if (window.hitScanLimit) {
          notes.push(`文件很大，已扫描 ${MAX_READ_SCAN_BYTES} 字节后停下`);
        }
        notes.push(`用 offset=${lastLine + 1} 继续往后读`);
      }
      if (window.clippedLine) notes.push("其中有单行过长，已被截断");

      const header = totalKnown
        ? `# ${display}（共 ${window.totalLines} 行${
            notes.length > 0 ? `，已显示 ${offset}-${lastLine}` : ""
          }）`
        : `# ${display}（已显示 ${offset}-${lastLine}，未读到文件末尾）`;
      const footer = notes.length > 0 ? `\n\n[${notes.join("；")}]` : "";

      return `${header}\n${numbered}${footer}`;
    },
  };
}

/* ------------------------------------------------------------------ */
/* write_file                                                          */
/* ------------------------------------------------------------------ */

export interface WriteFileInput {
  path?: unknown;
  content?: unknown;
}

export const WRITE_FILE_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "相对工作目录的文件路径（父目录会自动创建）" },
    content: { type: "string", description: "要写入的完整内容" },
  },
  required: ["path", "content"],
};

export function createWriteFileTool(): Tool<WriteFileInput, string> {
  return {
    name: "write_file",
    description: [
      "把内容写入文件，覆盖已有内容。",
      "父目录不存在会自动创建；写入是原子的（临时文件 + rename）。",
      "修改已有文件请优先用 edit_file，避免覆盖掉你没看过的内容。",
    ].join(" "),
    parameters: WRITE_FILE_PARAMETERS,
    // 进程内工具没有内核兜底，必须显式声明需要写权限 ——
    // read-only 档位下闸门会据此拦下（或弹窗请求升档）
    requires: { write: true },

    resources(input, ctx) {
      return fileResource(input, ctx, "write");
    },

    describe(input: unknown) {
      const path = typeof (input as WriteFileInput | null)?.path === "string" ? (input as WriteFileInput).path : "";
      return { resource: String(path), summary: `写入文件 ${path}` };
    },

    async run(input: WriteFileInput, ctx: ToolCtx): Promise<string> {
      const rawPath = requireString(input.path, "path");
      const content = requireString(input.content, "content");

      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_WRITE_BYTES) {
        throw new Error(`内容过大：${bytes} 字节，上限 ${MAX_WRITE_BYTES}`);
      }

      const absolute = resolveWithin(ctx.cwd, rawPath);
      const display = relativeTo(ctx.cwd, absolute);

      // 先读旧内容，写完才能给出 diff（新建文件时旧内容为空）
      const existed = await Bun.file(absolute).exists();
      const fileStat = existed ? await stat(absolute) : undefined;
      const before = existed ? await Bun.file(absolute).text() : "";

      await mkdir(dirname(absolute), { recursive: true });

      // 原子写：先写同目录下的临时文件，再 rename，避免写一半崩掉留下半截文件
      const temp = `${absolute}.bugent-tmp-${process.pid}-${Date.now()}`;
      const mode = fileStat?.mode === undefined ? undefined : fileStat.mode & 0o777;
      try {
        await writeFile(temp, content, {
          encoding: "utf8",
          ...(mode !== undefined ? { mode } : {}),
        });
        if (mode !== undefined) await chmod(temp, mode);
        await rename(temp, absolute);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }

      ctx.onWorkspaceChange?.({
        path: display,
        before,
        after: content,
        beforeExists: existed,
        afterExists: true,
        reversible: true,
      });

      const lineCount = content.split("\n").length;
      const summary = existed
        ? `已覆盖 ${display}（${bytes} 字节，${lineCount} 行）`
        : `已创建 ${display}（${bytes} 字节，${lineCount} 行）`;

      // 新建文件不走 diff：空内容 split 出来是一个空行，会被当成"删了 1 行"，
      // 于是新文件显示成 `+3 -1`。直接全标成新增才对。
      const diff = existed
        ? compactDiff(diffLines(before, content))
        : content.split("\n").map((text): DiffLine => ({ kind: "+", text }));

      return formatDiff(diff, summary);
    },
  };
}

/* ------------------------------------------------------------------ */
/* edit_file                                                           */
/* ------------------------------------------------------------------ */

export interface EditFileInput {
  path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

export const EDIT_FILE_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "相对工作目录的文件路径" },
    old_string: { type: "string", description: "要被替换的原文（必须与文件内容完全一致，含缩进）" },
    new_string: { type: "string", description: "替换成的新内容" },
    replace_all: { type: "boolean", description: "是否替换所有匹配；默认 false，此时要求唯一匹配" },
  },
  required: ["path", "old_string", "new_string"],
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export function createEditFileTool(): Tool<EditFileInput, string> {
  return {
    name: "edit_file",
    description: [
      "在文件中做精确字符串替换。",
      "old_string 必须与文件内容完全一致（含缩进与换行）。",
      "默认要求唯一匹配；有多处匹配时要么提供更多上下文，要么设 replace_all=true。",
    ].join(" "),
    parameters: EDIT_FILE_PARAMETERS,
    requires: { write: true },

    resources(input, ctx) {
      return fileResource(input, ctx, "write");
    },

    describe(input: unknown) {
      const path = typeof (input as EditFileInput | null)?.path === "string" ? (input as EditFileInput).path : "";
      return { resource: String(path), summary: `编辑文件 ${path}` };
    },

    async run(input: EditFileInput, ctx: ToolCtx): Promise<string> {
      const rawPath = requireString(input.path, "path");
      if (rawPath.length === 0) throw new Error("path 不能为空");
      const oldString = requireString(input.old_string, "old_string");
      const newString = requireString(input.new_string, "new_string");
      if (oldString.length === 0) throw new Error("old_string 不能为空");
      if (oldString === newString) {
        throw new Error("old_string 与 new_string 相同，无需修改");
      }
      if (input.replace_all !== undefined && typeof input.replace_all !== "boolean") {
        throw new Error("replace_all 必须是 boolean");
      }

      const replaceAll = input.replace_all === true;
      const absolute = resolveWithin(ctx.cwd, rawPath);
      const display = relativeTo(ctx.cwd, absolute);

      const fileStat = await stat(absolute).catch(() => undefined);
      if (fileStat === undefined) throw new Error(`文件不存在：${display}`);
      if (!fileStat.isFile()) throw new Error(`不是普通文件：${display}`);

      const original = await Bun.file(absolute).text();
      if (original.includes("\0")) {
        throw new Error(`拒绝编辑二进制文件：${display}`);
      }
      const occurrences = countOccurrences(original, oldString);

      if (occurrences === 0) {
        throw new Error(`在 ${display} 中找不到 old_string，请先 read_file 确认原文`);
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `old_string 在 ${display} 中匹配到 ${occurrences} 处，不唯一。` +
            `请提供更多上下文使其唯一，或设置 replace_all=true`,
        );
      }

      // Do not use String.replace(search, replacement): `$&`, `$1`, `$'`
      // would be interpreted as replacement templates instead of literal text.
      const updated = replaceAll
        ? original.split(oldString).join(newString)
        : (() => {
            const index = original.indexOf(oldString);
            return original.slice(0, index) + newString + original.slice(index + oldString.length);
          })();
      const updatedBytes = Buffer.byteLength(updated, "utf8");
      if (updatedBytes > MAX_WRITE_BYTES) {
        throw new Error(`编辑后内容过大：${updatedBytes} 字节，上限 ${MAX_WRITE_BYTES}`);
      }

      const temp = `${absolute}.bugent-tmp-${process.pid}-${Date.now()}`;
      const mode = fileStat.mode & 0o777;
      try {
        await writeFile(temp, updated, { encoding: "utf8", mode });
        await chmod(temp, mode);
        await rename(temp, absolute);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }

      ctx.onWorkspaceChange?.({
        path: display,
        before: original,
        after: updated,
        beforeExists: true,
        afterExists: true,
        reversible: true,
      });

      const replaced = replaceAll ? occurrences : 1;
      return formatDiff(
        compactDiff(diffLines(original, updated)),
        `已编辑 ${display}（替换 ${replaced} 处）`,
      );
    },
  };
}
