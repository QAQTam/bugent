import {
  BEGIN_PATCH_MARKER,
  END_PATCH_MARKER,
  PatchParseError,
  type ApplyPatchArgs,
} from "./types.ts";
import { StreamingPatchParser } from "./streaming-parser.ts";

export type ParseMode = "strict" | "lenient";

function splitPatchLines(patch: string): string[] {
  const trimmed = patch.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\r?\n/);
}

function checkStrictBoundaries(lines: readonly string[]): void {
  const first = lines[0]?.trim();
  const last = lines.at(-1)?.trim();
  if (first !== BEGIN_PATCH_MARKER) {
    throw new PatchParseError(`The first line of the patch must be '${BEGIN_PATCH_MARKER}'`);
  }
  if (last !== END_PATCH_MARKER) {
    throw new PatchParseError(`The last line of the patch must be '${END_PATCH_MARKER}'`);
  }
}

function checkLenientBoundaries(lines: readonly string[]): string[] {
  try {
    checkStrictBoundaries(lines);
    return [...lines];
  } catch (strictError) {
    const first = lines[0];
    const last = lines.at(-1);
    if (
      lines.length >= 4 &&
      (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
      last?.endsWith("EOF")
    ) {
      const inner = lines.slice(1, -1);
      checkStrictBoundaries(inner);
      return inner;
    }
    throw strictError;
  }
}

export function parsePatch(patch: string, mode: ParseMode = "lenient"): ApplyPatchArgs {
  const lines = splitPatchLines(patch);
  const patchLines = mode === "strict" ? (checkStrictBoundaries(lines), lines) : checkLenientBoundaries(lines);
  const canonical = patchLines.join("\n");
  const parser = new StreamingPatchParser();
  parser.pushDelta(canonical);
  const hunks = parser.finish();
  return {
    patch: canonical,
    hunks,
    ...(parser.environmentId !== undefined ? { environmentId: parser.environmentId } : {}),
  };
}
