import { StreamingPatchParser } from "./streaming-parser.ts";
import type { Hunk } from "./types.ts";
import { decodeJsonStringPrefix } from "../core/partial-json.ts";

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
  #lastError: unknown;
  #lastProgress: PatchProgress | undefined;
  /**
   * 增量提取状态（PERF-004）：
   *   - `search`  还没找到 patch 文本起点，每个增量在新后缀里找；
   *   - `raw`     arguments 本身就是 patch 文本（custom tool 形式）；
   *   - `json`    patch 是 JSON 字符串值（`{"patch":"..."}` 或裸引号串），
   *               用可续位的 decodeJsonStringPrefix 只解码新增后缀。
   * 旧实现每个增量都对**全量 rawArgs** 跑正则 + 全量解码 + 全量 slice，
   * O(L²)；500KB 的 patch 会把 UI 线程拖死。
   */
  #mode: "search" | "raw" | "json" = "search";
  #valueStart = 0;
  #consumed = 0;
  #decodedAny = false;

  hunks(): Hunk[] {
    return this.#parser.hunks();
  }

  push(rawArgs: string): PatchProgress | undefined {
    if (this.#mode === "search") {
      this.#findPatchStart(rawArgs);
      if (this.#mode === "search") return undefined;
    }

    let delta: string;
    if (this.#mode === "raw") {
      delta = rawArgs.slice(this.#valueStart + this.#consumed);
      this.#consumed = rawArgs.length - this.#valueStart;
    } else {
      const scan = decodeJsonStringPrefix(rawArgs, this.#valueStart + this.#consumed);
      delta = scan.text;
      this.#consumed = scan.consumed - this.#valueStart;
    }

    if (delta.length > 0) this.#decodedAny = true;
    if (delta.length === 0) return this.#lastProgress;

    try {
      this.#parser.pushDelta(delta);
      this.#lastError = undefined;
    } catch (error) {
      // 半截 patch 暂时不完整；最终 finish() 会给出真实错误。
      this.#lastError = error;
    }
    this.#lastProgress = patchProgress(this.#parser.liveHunks(), false);
    return this.#lastProgress;
  }

  /** 只在还没找到起点时运行；找到后每个增量只碰自己的新后缀。 */
  #findPatchStart(rawArgs: string): void {
    // 先试整体形式（custom tool 直接发 patch 文本）
    const trimmed = rawArgs.trimStart();
    const lead = rawArgs.length - trimmed.length;
    if (trimmed.startsWith("*** Begin Patch")) {
      this.#mode = "raw";
      this.#valueStart = lead;
      this.#consumed = 0;
      return;
    }

    // `{"patch":"..."}` 形式：键出现得早，正则只在找不到时反复跑全量；
    // 找到一次即固化起点。
    const match = /"patch"\s*:\s*"/.exec(rawArgs);
    if (match !== null) {
      this.#mode = "json";
      this.#valueStart = match.index + match[0].length;
      this.#consumed = 0;
      return;
    }

    if (trimmed.startsWith('"')) {
      this.#mode = "json";
      this.#valueStart = lead + 1;
      this.#consumed = 0;
    }
  }

  finish(): PatchProgress {
    if (!this.#decodedAny) {
      throw this.#lastError ?? new Error("apply_patch arguments 中没有 patch");
    }
    this.#parser.finish();
    return patchProgress(this.#parser.hunks(), true);
  }
}
