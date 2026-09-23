/**
 * 文件工具 —— Phase 7。
 *
 *   read_file   读文件（带行号，支持 offset/limit，有大小上限）
 *   write_file  原子写（先写临时文件再 rename）
 *   edit_file   精确字符串替换，找不到或不唯一时**报错而不是猜**
 *
 * 所有路径都过 resolveWithin()，逃不出工作目录。
 */

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JSONSchema } from "../provider/types.ts";
import type { Tool, ToolCtx } from "./types.ts";
import { relativeTo, resolveWithin } from "./paths.ts";

export const MAX_READ_LINES = 2000;
/** 单次读取的硬上限；超过就拒绝，避免把内存打爆。 */
export const MAX_READ_HARD_BYTES = 8 * 1024 * 1024;
export const MAX_WRITE_BYTES = 8 * 1024 * 1024;

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

      const file = Bun.file(absolute);
      if (!(await file.exists())) {
        throw new Error(`文件不存在：${display}`);
      }

      const size = file.size;
      if (size > MAX_READ_HARD_BYTES) {
        throw new Error(
          `文件过大（${size} 字节，上限 ${MAX_READ_HARD_BYTES}），请先用 bash 缩小范围（如 grep / sed）`,
        );
      }

      const text = await file.text();
      if (text.includes("\0")) {
        throw new Error(`拒绝读取二进制文件：${display}`);
      }

      const lines = text.split("\n");

      if (offset > lines.length && lines.length > 0) {
        throw new Error(`offset ${offset} 超出文件总行数 ${lines.length}`);
      }

      const start = offset - 1;
      const slice = lines.slice(start, start + limit);
      const numbered = slice.map((line, index) => `${start + index + 1}\t${line}`).join("\n");

      const lastLine = start + slice.length;
      const truncated = lastLine < lines.length;

      const header = `# ${display}（共 ${lines.length} 行${truncated ? `，已显示 ${offset}-${lastLine}` : ""}）`;
      const footer = truncated
        ? `\n\n[还有 ${lines.length - lastLine} 行未显示，用 offset=${lastLine + 1} 继续读]`
        : "";

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

      await mkdir(dirname(absolute), { recursive: true });

      // 原子写：先写同目录下的临时文件，再 rename，避免写一半崩掉留下半截文件
      const temp = `${absolute}.bugent-tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(temp, content, "utf8");
        await rename(temp, absolute);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }

      const lineCount = content.split("\n").length;
      return `已写入 ${display}（${bytes} 字节，${lineCount} 行）`;
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

    describe(input: unknown) {
      const path = typeof (input as EditFileInput | null)?.path === "string" ? (input as EditFileInput).path : "";
      return { resource: String(path), summary: `编辑文件 ${path}` };
    },

    async run(input: EditFileInput, ctx: ToolCtx): Promise<string> {
      const rawPath = requireString(input.path, "path");
      const oldString = requireString(input.old_string, "old_string");
      const newString = requireString(input.new_string, "new_string");

      if (oldString.length === 0) {
        throw new Error("old_string 不能为空");
      }
      if (oldString === newString) {
        throw new Error("old_string 与 new_string 相同，无需修改");
      }

      const replaceAll = input.replace_all === true;
      const absolute = resolveWithin(ctx.cwd, rawPath);
      const display = relativeTo(ctx.cwd, absolute);

      const file = Bun.file(absolute);
      if (!(await file.exists())) {
        throw new Error(`文件不存在：${display}`);
      }

      const original = await file.text();
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

      const updated = replaceAll
        ? original.split(oldString).join(newString)
        : original.replace(oldString, newString);

      const temp = `${absolute}.bugent-tmp-${process.pid}-${Date.now()}`;
      try {
        await writeFile(temp, updated, "utf8");
        await rename(temp, absolute);
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error;
      }

      const replaced = replaceAll ? occurrences : 1;
      return `已编辑 ${display}（替换 ${replaced} 处）`;
    },
  };
}
