/**
 * 文件工具 —— Phase 7。
 *
 *   read_file   读文件（带行号，支持 offset/limit，有大小上限）
 *   write_file  原子写（先写临时文件再 rename）
 *   edit_file   精确字符串替换，找不到或不唯一时**报错而不是猜**
 *
 * 写路径默认只能落在工作区内（`resolveWithin`）；只有**本次调用获准越界**
 * （`ctx.grant.writeOutside`，由闸门按次授权）才放宽到整个文件系统。
 *
 * read_file 不受限制 —— 三档都允许自由读工作区之外。
 */

import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { JSONSchema } from "../provider/types.ts";
import type { ResourceClaim } from "./locks.ts";
import type { Tool, ToolCtx } from "./types.ts";
import { atomicWriteWithin } from "./atomic-write.ts";
import { MAX_PATCH_TARGET_BYTES } from "../patch/apply.ts";
import {
  ANYWHERE,
  PathEscapeError,
  relativeTo,
  resolveForWrite,
  resolveReadable,
  resolveWithin,
} from "./paths.ts";
import { compactDiff, diffLines, diffStat, formatDiff, type DiffLine } from "./diff.ts";

export const MAX_READ_LINES = 500;

/* ------------------------------------------------------------------ */
/* 路径解析：读 / 写两条不同的宽度                                       */
/* ------------------------------------------------------------------ */

/**
 * 写路径解析。默认锁在工作区内；只有本次调用获准越界时才放宽。
 *
 * 注意这里读的是 `ctx.grant`（**本次调用**的授权），不是档位 —— 档位只决定
 * 闸门要不要问，不决定工具自己能走多远。
 */
function resolveWriteTarget(ctx: ToolCtx, rawPath: string): string {
  return resolveForWrite(ctx.cwd, rawPath, ctx.grant?.writeOutside === true);
}

/**
 * 逐次判断这次写是不是越出工作区，供闸门在**调用前**决定要不要按次问用户。
 *
 * 只把 `PathEscapeError` 当作"越界"：参数不是字符串之类的错误留给 run 自己
 * 报，否则会问一个没有意义的授权。
 */
function writesOutsideWorkspace(input: unknown, ctx: ToolCtx): boolean {
  const raw = (input as { path?: unknown } | null | undefined)?.path;
  if (typeof raw !== "string") return false;
  try {
    resolveWithin(ctx.cwd, raw);
    return false;
  } catch (error) {
    return error instanceof PathEscapeError;
  }
}

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
      entry = `${entry.slice(0, options.maxChars)}…[line too long, truncated]`;
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
  let absolute: string;
  try {
    absolute = resolveWithin(ctx.cwd, rawPath);
  } catch {
    // 工作区外的目标：锁粒度退化成整个 workspace。
    // **不能在这里抛** —— resources() 在闸门之前跑，抛了就等于让
    // "按次授权写工作区外"永远走不到闸门那一步。
    return [{ key: "workspace", access }];
  }
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
    path: { type: "string", description: "Path relative to the workspace root." },
    offset: { type: "number", description: "First line to read (1-based). Defaults to 1." },
    limit: {
      type: "number",
      description: `Maximum number of lines to read. Defaults to ${MAX_READ_LINES}.`,
    },
  },
  required: ["path"],
};

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

export function createReadFileTool(): Tool<ReadFileInput, string> {
  return {
    name: "read_file",
    description: "Read a text file from the workspace; returns numbered lines.",
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

      // 读是自由的：三档都允许读工作区之外（档位不限制读）。
      const absolute = resolveReadable(ctx.cwd, rawPath, [ANYWHERE]);
      const display = relativeTo(ctx.cwd, absolute);

      // 目录单独判断：否则 size 是 0，会掉进"文件不存在"分支，报错完全误导
      if (statSync(absolute, { throwIfNoEntry: false })?.isDirectory() === true) {
        throw new Error(`not a file, this is a directory: ${display}. Use bash ls to see what is inside`);
      }

      const file = Bun.file(absolute);
      if (!(await file.exists())) {
        throw new Error(`file not found: ${display}`);
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
          throw new Error(`refusing to read a binary file: ${display}`);
        }
        throw error;
      }

      if (window.entries.length === 0 && window.reachedEnd) {
        if (offset > 1) {
          throw new Error(`offset ${offset} is beyond the file's ${window.totalLines} lines`);
        }
        return `# ${display} (empty file)`;
      }

      const numbered = window.entries.join("\n");
      const lastLine = window.lastLine;
      const totalKnown = window.totalLines >= 0;

      const notes: string[] = [];
      if (totalKnown) {
        if (lastLine < window.totalLines) {
          notes.push(`${window.totalLines - lastLine} more lines not shown; continue with offset=${lastLine + 1}`);
        }
      } else {
        if (window.hitScanLimit) {
          if (window.entries.length === 0 && offset > 1) {
            // BUG-022：扫描窗永远从文件头开始，大 offset 到不了——旧的提示
            // 会让模型拿着一个永远不前进的 offset 死循环。
            notes.push(
              `offset ${offset} is beyond the ${MAX_READ_SCAN_BYTES}-byte scan window; ` +
                "this tool always scans from the start of the file",
            );
            notes.push(
              `use bash to read deep into large files, e.g. sed -n '${offset},${
                offset + MAX_READ_LINES
              }p' -- ${JSON.stringify(display)}`,
            );
          } else {
            notes.push(`file is large; stopped after scanning ${MAX_READ_SCAN_BYTES} bytes`);
            notes.push(`continue with offset=${lastLine + 1}`);
          }
        } else {
          notes.push(`continue with offset=${lastLine + 1}`);
        }
      }
      if (window.clippedLine) notes.push("one line was too long and has been truncated");

      const header = totalKnown
        ? `# ${display} (${window.totalLines} lines${
            notes.length > 0 ? `, showing ${offset}-${lastLine}` : ""
          }）`
        : `# ${display} (showing ${offset}-${lastLine}, not yet at end of file)`;
      const footer = notes.length > 0 ? `\n\n[${notes.join("；")}]` : "";

      // 展示元数据：TUI 直接读它，不必从上面那个头部反解（--resume 时才回退到反解）。
      // 口径与头部一致：整份读完就是 `1-N`，否则是实际读到的窗口。
      ctx.onPresentation?.({
        kind: "file",
        path: display,
        range: totalKnown && notes.length === 0 ? `1-${window.totalLines}` : `${offset}-${lastLine}`,
      });

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
    path: { type: "string", description: "Path relative to the workspace root. Parent directories are created." },
    content: { type: "string", description: "Full file content." },
  },
  required: ["path", "content"],
};

export function createWriteFileTool(): Tool<WriteFileInput, string> {
  return {
    name: "write_file",
    description: "Create or overwrite a file with the given content.",
    parameters: WRITE_FILE_PARAMETERS,
    // 进程内工具没有内核兜底，必须显式声明需要写权限 ——
    // 档位默认不批准写时，闸门会据此按次问用户
    requires: { write: true },
    writesOutside: writesOutsideWorkspace,

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
        throw new Error(`content too large: ${bytes} bytes, limit ${MAX_WRITE_BYTES}`);
      }

      const absolute = resolveWriteTarget(ctx, rawPath);
      const display = relativeTo(ctx.cwd, absolute);

      // 先读旧内容，写完才能给出 diff（新建文件时旧内容为空）
      const existed = await Bun.file(absolute).exists();
      const fileStat = existed ? await stat(absolute) : undefined;
      const before = existed ? await Bun.file(absolute).text() : "";

      // 原子写 + TOCTOU 收窄（BUG-012）：临时文件、rename、四次边界复核都在
      // atomicWriteWithin 里；越界授权时复核自动放宽。
      const mode = fileStat?.mode === undefined ? undefined : fileStat.mode & 0o777;
      await atomicWriteWithin(ctx.cwd, ctx.grant?.writeOutside === true, absolute, content, mode);

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
        ? `overwrote ${display} (${bytes} bytes, ${lineCount} lines)`
        : `created ${display} (${bytes} bytes, ${lineCount} lines)`;

      // 新建文件不走 diff：空内容 split 出来是一个空行，会被当成"删了 1 行"，
      // 于是新文件显示成 `+3 -1`。直接全标成新增才对。
      // 行号从 1 起 —— 新文件的每一行都是新增，编号就是它在文件里的行号。
      const diff = existed
        ? compactDiff(diffLines(before, content))
        : content.split("\n").map((text, index): DiffLine => ({ kind: "+", text, after: index + 1 }));

      // 展示元数据：TUI 不必从 diff 文本里反解统计
      const delta = diffStat(diff);
      ctx.onPresentation?.({
        kind: "file",
        path: display,
        added: delta.added,
        removed: delta.removed,
      });

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
    path: { type: "string", description: "Path relative to the workspace root." },
    old_string: { type: "string", description: "Exact text to replace, including indentation." },
    new_string: { type: "string", description: "Replacement text." },
    replace_all: {
      type: "boolean",
      description: "Replace every match. Defaults to false, which requires a unique match.",
    },
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
    description: "Replace one exact string in a file.",
    parameters: EDIT_FILE_PARAMETERS,
    requires: { write: true },
    writesOutside: writesOutsideWorkspace,

    resources(input, ctx) {
      return fileResource(input, ctx, "write");
    },

    describe(input: unknown) {
      const path = typeof (input as EditFileInput | null)?.path === "string" ? (input as EditFileInput).path : "";
      return { resource: String(path), summary: `编辑文件 ${path}` };
    },

    async run(input: EditFileInput, ctx: ToolCtx): Promise<string> {
      const rawPath = requireString(input.path, "path");
      if (rawPath.length === 0) throw new Error("path must not be empty");
      const oldString = requireString(input.old_string, "old_string");
      const newString = requireString(input.new_string, "new_string");
      if (oldString.length === 0) throw new Error("old_string must not be empty");
      if (oldString === newString) {
        throw new Error("old_string and new_string are identical; nothing to change");
      }
      if (input.replace_all !== undefined && typeof input.replace_all !== "boolean") {
        throw new Error("replace_all must be a boolean");
      }

      const replaceAll = input.replace_all === true;
      const absolute = resolveWriteTarget(ctx, rawPath);
      const display = relativeTo(ctx.cwd, absolute);

      const fileStat = await stat(absolute).catch(() => undefined);
      if (fileStat === undefined) throw new Error(`file not found: ${display}`);
      if (!fileStat.isFile()) throw new Error(`not a regular file: ${display}`);
      // BUG-018：edit 是全文读 + 全文写 —— 读之前先看尺寸。
      if (fileStat.size > MAX_PATCH_TARGET_BYTES) {
        throw new Error(
          `refusing to edit a ${fileStat.size}-byte file (limit ${MAX_PATCH_TARGET_BYTES}): ${display}`,
        );
      }

      const original = await Bun.file(absolute).text();
      if (original.includes("\0")) {
        throw new Error(`refusing to edit a binary file: ${display}`);
      }
      const occurrences = countOccurrences(original, oldString);

      if (occurrences === 0) {
        throw new Error(`old_string not found in ${display}; read the file first to confirm the exact text`);
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `old_string matches ${occurrences} times in ${display}.` +
            `Add more context to make it unique, or set replace_all=true`,
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
        throw new Error(`edited content too large: ${updatedBytes} bytes, limit ${MAX_WRITE_BYTES}`);
      }

      // 同 write_file：原子写 + TOCTOU 收窄（BUG-012）
      const mode = fileStat.mode & 0o777;
      await atomicWriteWithin(ctx.cwd, ctx.grant?.writeOutside === true, absolute, updated, mode);

      ctx.onWorkspaceChange?.({
        path: display,
        before: original,
        after: updated,
        beforeExists: true,
        afterExists: true,
        reversible: true,
      });

      const replaced = replaceAll ? occurrences : 1;
      const diff = compactDiff(diffLines(original, updated));

      // 展示元数据：TUI 不必从 diff 文本里反解统计
      const delta = diffStat(diff);
      ctx.onPresentation?.({
        kind: "file",
        path: display,
        added: delta.added,
        removed: delta.removed,
      });

      return formatDiff(diff, `edited ${display} (${replaced} replacements)`);
    },
  };
}
