import { describe, expect, test } from "bun:test";
import { parsePatch } from "../src/patch/parser.ts";
import { StreamingPatchParser } from "../src/patch/streaming-parser.ts";
import { seekSequence } from "../src/patch/seek-sequence.ts";
import { deriveNewContentsFromChunks } from "../src/patch/file-update.ts";
import type { UpdateFileChunk } from "../src/patch/types.ts";

function chunk(
  oldLines: string[],
  newLines: string[],
  options: Partial<Omit<UpdateFileChunk, "oldLines" | "newLines">> = {},
): UpdateFileChunk {
  return {
    oldLines,
    newLines,
    contextLineIndices: [],
    isEndOfFile: false,
    ...options,
  };
}

describe("apply_patch parser compatibility", () => {
  test("parses add, delete, update, move and context", () => {
    const parsed = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: path/add.py",
        "+abc",
        "+def",
        "*** Delete File: path/delete.py",
        "*** Update File: path/update.py",
        "*** Move to: path/update2.py",
        "@@ def f():",
        "-    pass",
        "+    return 123",
        "*** End Patch",
      ].join("\n"),
    );

    expect(parsed.hunks).toEqual([
      { type: "add", path: "path/add.py", contents: "abc\ndef\n" },
      { type: "delete", path: "path/delete.py" },
      {
        type: "update",
        path: "path/update.py",
        movePath: "path/update2.py",
        chunks: [
          {
            changeContext: "def f():",
            oldLines: ["    pass"],
            newLines: ["    return 123"],
            contextLineIndices: [],
            isEndOfFile: false,
          },
        ],
      },
    ]);
  });

  test("preserves EOF marker and rejects empty update hunks", () => {
    const parsed = parsePatch(
      "*** Begin Patch\n*** Update File: file.txt\n@@\n+quux\n*** End of File\n\n*** End Patch",
    );
    expect(parsed.hunks[0]).toMatchObject({
      type: "update",
      path: "file.txt",
      chunks: [{ oldLines: [], newLines: ["quux"], isEndOfFile: true }],
    });

    expect(() =>
      parsePatch("*** Begin Patch\n*** Update File: test.py\n*** End Patch", "strict"),
    ).toThrow(/empty/);
  });

  test("accepts lenient heredoc wrappers", () => {
    const body =
      "*** Begin Patch\n*** Update File: file2.py\n import foo\n+bar\n*** End Patch";
    const parsed = parsePatch(`<<'EOF'\n${body}\nEOF\n`);
    expect(parsed.patch).toBe(body);
    expect(parsed.hunks[0]).toMatchObject({
      type: "update",
      path: "file2.py",
      chunks: [
        {
          oldLines: ["import foo"],
          newLines: ["import foo", "bar"],
          contextLineIndices: [[0, 0]],
        },
      ],
    });
  });
});

describe("streaming parser compatibility", () => {
  test("streams complete lines and keeps partial line buffered", () => {
    const parser = new StreamingPatchParser();
    parser.pushDelta("*** Begin Patch\n*** Add File: file.txt\n+hel");
    expect(parser.hunks()).toEqual([
      { type: "add", path: "file.txt", contents: "" },
    ]);

    const hunks = parser.pushDelta("lo\n*** End Patch\n");
    expect(hunks).toEqual([
      { type: "add", path: "file.txt", contents: "hello\n" },
    ]);
  });

  test("handles CRLF and final line without newline", () => {
    const parser = new StreamingPatchParser();
    parser.pushDelta(
      "*** Begin Patch\r\n*** Update File: file.txt\r\n@@\r\n-old\r\n+new\r\n*** End Patch",
    );
    const hunks = parser.finish();
    expect(hunks).toEqual([
      {
        type: "update",
        path: "file.txt",
        chunks: [
          {
            oldLines: ["old"],
            newLines: ["new"],
            contextLineIndices: [],
            isEndOfFile: false,
          },
        ],
      },
    ]);
  });
});

describe("seek_sequence compatibility", () => {
  test("falls back from exact to rstrip, trim and unicode normalization", () => {
    expect(seekSequence(["foo", "bar"], ["bar"], 0, false)).toBe(1);
    expect(seekSequence(["foo   ", "bar\t\t"], ["foo", "bar"], 0, false)).toBe(0);
    expect(seekSequence(["    foo   ", "   bar\t"], ["foo", "bar"], 0, false)).toBe(0);
    expect(seekSequence(["const x = “ok” — done"], ['const x = "ok" - done'], 0, false)).toBe(0);
  });

  test("EOF matching starts from the end", () => {
    expect(seekSequence(["x", "same", "same"], ["same"], 0, true)).toBe(2);
  });
});

describe("apply_patch update compatibility", () => {
  test("applies multiple chunks in source order", () => {
    const result = deriveNewContentsFromChunks(
      "a\nb\nc\nd\n",
      "file.txt",
      [chunk(["b"], ["B"]), chunk(["d"], ["D"])],
    );
    expect(result.newContents).toBe("a\nB\nc\nD\n");
  });

  test("preserves CRLF line endings", () => {
    const result = deriveNewContentsFromChunks(
      "a\r\nb\r\n",
      "file.txt",
      [chunk(["b"], ["B", "C"])],
      "preserve-line-endings",
    );
    expect(result.newContents).toBe("a\r\nB\r\nC\r\n");
  });

  test("matches EOF chunks near the end", () => {
    const result = deriveNewContentsFromChunks(
      "a\nb\n",
      "file.txt",
      [chunk(["b"], ["B"], { isEndOfFile: true })],
    );
    expect(result.newContents).toBe("a\nB\n");
  });
});
