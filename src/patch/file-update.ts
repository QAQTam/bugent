import { seekSequence } from "./seek-sequence.ts";
import type {
  ApplyPatchFileUpdateMode,
  Replacement,
  UpdateFileChunk,
} from "./types.ts";

type LineEnding = "\n" | "\r\n" | "\r";

interface SourceLine {
  text: string;
  ending?: LineEnding;
}

interface SourceFile {
  lines: SourceLine[];
  preferredEnding: LineEnding;
}

export interface DerivedFileContents {
  originalContents: string;
  newContents: string;
}

function parseSourceFile(contents: string): SourceFile {
  const lines: SourceLine[] = [];
  let preferredEnding: LineEnding | undefined;
  let lineStart = 0;
  let cursor = 0;

  while (cursor < contents.length) {
    const char = contents[cursor]!;
    let ending: LineEnding | undefined;
    let endingLength = 0;
    if (char === "\r" && contents[cursor + 1] === "\n") {
      ending = "\r\n";
      endingLength = 2;
    } else if (char === "\r") {
      ending = "\r";
      endingLength = 1;
    } else if (char === "\n") {
      ending = "\n";
      endingLength = 1;
    }
    if (ending === undefined) {
      cursor += 1;
      continue;
    }
    preferredEnding ??= ending;
    lines.push({ text: contents.slice(lineStart, cursor), ending });
    cursor += endingLength;
    lineStart = cursor;
  }

  if (lineStart < contents.length) {
    lines.push({ text: contents.slice(lineStart) });
  }

  return { lines, preferredEnding: preferredEnding ?? "\n" };
}

function lineTexts(file: SourceFile): string[] {
  return file.lines.map((line) => line.text);
}

function applySourceReplacements(file: SourceFile, replacements: readonly Replacement[]): void {
  const sourceLines = [...file.lines];
  const next: SourceLine[] = [];
  let sourceIndex = 0;

  for (const [startIndex, oldLength, newLines] of replacements) {
    while (sourceIndex < startIndex) {
      next.push(sourceLines[sourceIndex]!);
      sourceIndex += 1;
    }
    sourceIndex += oldLength;
    for (const text of newLines) {
      next.push({ text, ending: file.preferredEnding });
    }
  }
  while (sourceIndex < sourceLines.length) {
    next.push(sourceLines[sourceIndex]!);
    sourceIndex += 1;
  }

  for (const line of next) line.ending ??= file.preferredEnding;
  file.lines = next;
}

function sourceContents(file: SourceFile): string {
  return file.lines.map((line) => line.text + (line.ending ?? "")).join("");
}

export function computeReplacements(
  originalLines: readonly string[],
  path: string,
  chunks: readonly UpdateFileChunk[],
  mode: ApplyPatchFileUpdateMode = "normalize-lf",
): Replacement[] {
  const replacements: Replacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false, mode);
      if (contextIndex === undefined) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`);
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex =
        mode === "normalize-lf" && originalLines.at(-1) === ""
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push([insertionIndex, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let startIndex = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, mode);
    if (startIndex === undefined && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.at(-1) === "") newSlice = newSlice.slice(0, -1);
      startIndex = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, mode);
    }
    if (startIndex === undefined) {
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
    }

    if (mode === "normalize-lf") {
      replacements.push([startIndex, pattern.length, newSlice]);
      lineIndex = startIndex + pattern.length;
      continue;
    }

    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextLineIndices) {
      if (oldContext >= pattern.length || newContext >= newSlice.length) break;
      if (oldStart !== oldContext || newStart !== newContext) {
        replacements.push([
          startIndex + oldStart,
          oldContext - oldStart,
          newSlice.slice(newStart, newContext),
        ]);
      }
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== newSlice.length) {
      replacements.push([
        startIndex + oldStart,
        pattern.length - oldStart,
        newSlice.slice(newStart),
      ]);
    }
    lineIndex = startIndex + pattern.length;
  }

  return replacements.sort((a, b) => a[0] - b[0]);
}

export function applyReplacements(
  lines: readonly string[],
  replacements: readonly Replacement[],
): string[] {
  const next = [...lines];
  for (const [startIndex, oldLength, newLines] of [...replacements].reverse()) {
    next.splice(startIndex, oldLength, ...newLines);
  }
  return next;
}

export function deriveNewContentsFromChunks(
  originalContents: string,
  path: string,
  chunks: readonly UpdateFileChunk[],
  mode: ApplyPatchFileUpdateMode = "normalize-lf",
): DerivedFileContents {
  if (mode === "preserve-line-endings") {
    const file = parseSourceFile(originalContents);
    const replacements = computeReplacements(lineTexts(file), path, chunks, mode);
    applySourceReplacements(file, replacements);
    return { originalContents, newContents: sourceContents(file) };
  }

  const originalLines = originalContents.split("\n");
  if (originalLines.at(-1) === "") originalLines.pop();
  const replacements = computeReplacements(originalLines, path, chunks, mode);
  const newLines = applyReplacements(originalLines, replacements);
  if (newLines.at(-1) !== "") newLines.push("");
  return { originalContents, newContents: newLines.join("\n") };
}
