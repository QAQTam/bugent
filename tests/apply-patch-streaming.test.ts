import { describe, expect, test } from "bun:test";
import {
  extractPatchText,
  PatchStreamProgress,
  type PatchProgress,
} from "../src/patch/streaming-progress.ts";

const PATCH = [
  "*** Begin Patch",
  "*** Add File: b.txt",
  "+one",
  "+two",
  "*** Update File: a.txt",
  "@@",
  "-old",
  "+new",
  "*** End Patch",
].join("\n");

describe("apply_patch streaming progress", () => {
  test("extracts raw freeform and JSON-wrapped patch text", () => {
    expect(extractPatchText(PATCH)).toBe(PATCH);
    expect(extractPatchText(JSON.stringify({ patch: PATCH }))).toBe(PATCH);
    expect(extractPatchText('{"patch":"line\\n\\u4e2d"')).toBe("line\n中");
  });

  test("keeps incremental JSON decoding stable across arbitrary chunks", () => {
    const raw = JSON.stringify({ patch: PATCH });
    const stream = new PatchStreamProgress();
    let progress: PatchProgress | undefined;
    for (let offset = 0; offset < raw.length; offset += 7) {
      progress = stream.push(raw.slice(0, offset + 7));
    }

    expect(progress?.files.map((file) => file.path)).toEqual(["b.txt", "a.txt"]);
    expect(progress?.added).toBe(3);
    expect(progress?.removed).toBe(1);
    if (progress === undefined) throw new Error("patch progress was not produced");
    expect(stream.hunks().map(hunk => hunk.type)).toEqual(["add", "update"]);
    expect(stream.finish()).toEqual({ ...progress, complete: true });
  });

  test("does not expose a patch before the JSON field appears", () => {
    const stream = new PatchStreamProgress();
    expect(stream.push('{"other":')).toBeUndefined();
    expect(stream.push('{"other":')).toBeUndefined();
  });
});
