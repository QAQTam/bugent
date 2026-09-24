import { StreamingPatchParser } from "./streaming-parser.ts";
import type { Hunk } from "./types.ts";

export interface PatchProgressFile {
  path: string;
  kind: "add" | "delete" | "update" | "move";
  added: number;
  removed: number;
  destination?: string;
}

export interface PatchProgress {
  files: readonly PatchProgressFile[];
  added: number;
  removed: number;
  complete: boolean;
}

interface JsonStringPrefix {
  text: string;
  complete: boolean;
}

function decodeJsonStringPrefix(source: string, start: number): JsonStringPrefix {
  let text = "";
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '"') return { text, complete: true };
    if (char !== "\\") {
      text += char;
      continue;
    }

    index += 1;
    if (index >= source.length) break;
    const escaped = source[index]!;
    switch (escaped) {
      case '"':
      case "\\":
      case "/":
        text += escaped;
        break;
      case "b":
        text += "\b";
        break;
      case "f":
        text += "\f";
        break;
      case "n":
        text += "\n";
        break;
      case "r":
        text += "\r";
        break;
      case "t":
        text += "\t";
        break;
      case "u": {
        const hex = source.slice(index + 1, index + 5);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { text, complete: false };
        }
        text += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        text += escaped;
        break;
    }
  }
  return { text, complete: false };
}

/**
 * 从 OpenAI function arguments 的部分文本中提取 `patch` 字段。
 *
 * openai-chat 会把 apply_patch 包成 `{"patch":"..."}`，而支持 custom tool 的
 * adapter 会直接发送 patch 文本。两种形式都在这里归一化，且只解码当前完整
 * 的 JSON 字符串前缀，因此不会被半截转义序列误导。
 */
export function extractPatchText(rawArgs: string): string | undefined {
  const trimmed = rawArgs.trimStart();
  if (trimmed.startsWith("*** Begin Patch")) return trimmed;

  const match = /"patch"\s*:\s*"/.exec(rawArgs);
  if (match !== null) {
    const decoded = decodeJsonStringPrefix(rawArgs, match.index + match[0].length);
    return decoded.text;
  }

  if (trimmed.startsWith('"')) {
    const decoded = decodeJsonStringPrefix(trimmed, 1);
    return decoded.text;
  }
  return undefined;
}

function countAddedContents(contents: string): number {
  if (contents.length === 0) return 0;
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function toProgressFiles(hunks: readonly Hunk[]): PatchProgressFile[] {
  return hunks.map((hunk) => {
    if (hunk.type === "add") {
      const added = countAddedContents(hunk.contents);
      return { path: hunk.path, kind: "add", added, removed: 0 };
    }
    if (hunk.type === "delete") {
      return { path: hunk.path, kind: "delete", added: 0, removed: 0 };
    }

    let added = 0;
    let removed = 0;
    for (const chunk of hunk.chunks) {
      added += chunk.newLines.length;
      removed += chunk.oldLines.length;
    }
    return {
      path: hunk.path,
      kind: hunk.movePath === undefined ? "update" : "move",
      added,
      removed,
      ...(hunk.movePath !== undefined ? { destination: hunk.movePath } : {}),
    };
  });
}

export function patchProgress(
  hunks: readonly Hunk[],
  complete: boolean,
): PatchProgress {
  const files = toProgressFiles(hunks);
  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    complete,
  };
}

/** 累积 arguments 增量，并给出可供 TUI 实时渲染的 patch 统计。 */
export class PatchStreamProgress {
  #parser = new StreamingPatchParser();
  #patchText = "";
  #lastError: unknown;

  get patchText(): string {
    return this.#patchText;
  }

  hunks(): Hunk[] {
    return this.#parser.hunks();
  }

  push(rawArgs: string): PatchProgress | undefined {
    const patchText = extractPatchText(rawArgs);
    if (patchText === undefined || patchText.length === 0) return undefined;
    const delta = patchText.slice(this.#patchText.length);
    this.#patchText = patchText;
    if (delta.length === 0) return patchProgress(this.#parser.hunks(), false);

    try {
      this.#parser.pushDelta(delta);
      this.#lastError = undefined;
    } catch (error) {
      // 半截 patch 暂时不完整；最终 finish() 会给出真实错误。
      this.#lastError = error;
    }
    return patchProgress(this.#parser.hunks(), false);
  }

  finish(): PatchProgress {
    if (this.#patchText.length === 0) {
      throw this.#lastError ?? new Error("apply_patch arguments 中没有 patch");
    }
    this.#parser.finish();
    return patchProgress(this.#parser.hunks(), true);
  }
}
