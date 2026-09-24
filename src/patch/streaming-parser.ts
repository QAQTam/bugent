import {
  ADD_FILE_MARKER,
  BEGIN_PATCH_MARKER,
  CHANGE_CONTEXT_MARKER,
  DELETE_FILE_MARKER,
  EMPTY_CHANGE_CONTEXT_MARKER,
  END_PATCH_MARKER,
  ENVIRONMENT_ID_MARKER,
  EOF_MARKER,
  MOVE_TO_MARKER,
  PatchParseError,
  UPDATE_FILE_MARKER,
  cloneHunk,
  type Hunk,
  type UpdateFileChunk,
} from "./types.ts";

type StreamingParserMode =
  | "not-started"
  | "started-patch"
  | "add-file"
  | "delete-file"
  | { readonly type: "update-file"; readonly hunkLineNumber: number }
  | "ended-patch";

interface StreamingParserState {
  mode: StreamingParserMode;
  hunks: Hunk[];
  environmentId?: string;
}

function emptyChunk(): UpdateFileChunk {
  return {
    oldLines: [],
    newLines: [],
    contextLineIndices: [],
    isEndOfFile: false,
  };
}

function pushContextLine(chunk: UpdateFileChunk, line: string): void {
  chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
  chunk.oldLines.push(line);
  chunk.newLines.push(line);
}

/**
 * Codex-compatible incremental parser. It only consumes complete lines; the
 * trailing partial line stays buffered until the next delta or finish().
 */
export class StreamingPatchParser {
  #lineBuffer = "";
  #lineNumber = 0;
  #state: StreamingParserState = { mode: "not-started", hunks: [] };

  get lineNumber(): number {
    return this.#lineNumber;
  }

  get environmentId(): string | undefined {
    return this.#state.environmentId;
  }

  hunks(): Hunk[] {
    return this.#state.hunks.map(cloneHunk);
  }

  #error(message: string, lineNumber = this.#lineNumber): never {
    throw new PatchParseError(message, lineNumber);
  }

  #lastUpdateHunk(): Extract<Hunk, { type: "update" }> | undefined {
    const last = this.#state.hunks.at(-1);
    return last?.type === "update" ? last : undefined;
  }

  #ensureUpdateHunkIsNotEmpty(line: string): void {
    const hunk = this.#lastUpdateHunk();
    if (hunk === undefined) return;
    const mode = this.#state.mode;
    if (typeof mode === "object" && mode.type === "update-file") {
      if (hunk.chunks.length === 0) {
        this.#error(`Update file hunk for path '${hunk.path}' is empty`, mode.hunkLineNumber);
      }
      const last = hunk.chunks.at(-1);
      if (last !== undefined && last.oldLines.length === 0 && last.newLines.length === 0) {
        if (line.trim() === END_PATCH_MARKER) {
          this.#error("Update hunk does not contain any lines");
        }
        this.#error(
          `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        );
      }
    }
  }

  #handleHunkHeadersAndEndPatch(trimmed: string): boolean {
    if (this.#state.mode === "started-patch" && trimmed.startsWith(ENVIRONMENT_ID_MARKER)) {
      if (this.#state.environmentId !== undefined) {
        this.#error("apply_patch environment_id cannot be specified more than once");
      }
      const environmentId = trimmed.slice(ENVIRONMENT_ID_MARKER.length).trim();
      if (environmentId.length === 0) {
        this.#error("apply_patch environment_id cannot be empty");
      }
      this.#state.environmentId = environmentId;
      return true;
    }

    if (trimmed === END_PATCH_MARKER) {
      this.#ensureUpdateHunkIsNotEmpty(trimmed);
      this.#state.mode = "ended-patch";
      return true;
    }

    if (trimmed.startsWith(ADD_FILE_MARKER)) {
      this.#ensureUpdateHunkIsNotEmpty(trimmed);
      this.#state.hunks.push({
        type: "add",
        path: trimmed.slice(ADD_FILE_MARKER.length),
        contents: "",
      });
      this.#state.mode = "add-file";
      return true;
    }

    if (trimmed.startsWith(DELETE_FILE_MARKER)) {
      this.#ensureUpdateHunkIsNotEmpty(trimmed);
      this.#state.hunks.push({
        type: "delete",
        path: trimmed.slice(DELETE_FILE_MARKER.length),
      });
      this.#state.mode = "delete-file";
      return true;
    }

    if (trimmed.startsWith(UPDATE_FILE_MARKER)) {
      this.#ensureUpdateHunkIsNotEmpty(trimmed);
      this.#state.hunks.push({
        type: "update",
        path: trimmed.slice(UPDATE_FILE_MARKER.length),
        chunks: [],
      });
      this.#state.mode = { type: "update-file", hunkLineNumber: this.#lineNumber };
      return true;
    }

    return false;
  }

  #processLine(line: string): void {
    const trimmed = line.trim();
    const mode = this.#state.mode;

    if (mode === "not-started") {
      if (trimmed === BEGIN_PATCH_MARKER) {
        this.#state.mode = "started-patch";
        return;
      }
      this.#error("The first line of the patch must be '*** Begin Patch'");
    }

    if (mode === "started-patch") {
      if (this.#handleHunkHeadersAndEndPatch(trimmed)) return;
      this.#error(
        `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
      );
    }

    if (mode === "add-file") {
      if (this.#handleHunkHeadersAndEndPatch(trimmed)) return;
      if (line.startsWith("+")) {
        const hunk = this.#state.hunks.at(-1);
        if (hunk?.type !== "add") this.#error("internal add-file state mismatch");
        hunk.contents += `${line.slice(1)}\n`;
        return;
      }
      this.#error(
        `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
      );
    }

    if (mode === "delete-file") {
      if (this.#handleHunkHeadersAndEndPatch(trimmed)) return;
      this.#error(
        `'${trimmed}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
      );
    }

    if (typeof mode === "object" && mode.type === "update-file") {
      const updateLine = line.trimEnd();
      if (this.#handleHunkHeadersAndEndPatch(updateLine.trim())) return;
      const hunk = this.#lastUpdateHunk();
      if (hunk === undefined) this.#error("internal update-file state mismatch");

      const lastChunk = hunk.chunks.at(-1);
      if (lastChunk?.isEndOfFile === true) {
        if (updateLine.length === 0) return;
        if (
          updateLine !== EMPTY_CHANGE_CONTEXT_MARKER &&
          !updateLine.startsWith(CHANGE_CONTEXT_MARKER)
        ) {
          this.#error(
            `Expected update hunk to start with a @@ context marker, got: '${line}'`,
          );
        }
      }

      if (
        hunk.chunks.length === 0 &&
        hunk.movePath === undefined &&
        updateLine.startsWith(MOVE_TO_MARKER)
      ) {
        hunk.movePath = updateLine.slice(MOVE_TO_MARKER.length);
        return;
      }

      const isContextMarker =
        updateLine === EMPTY_CHANGE_CONTEXT_MARKER ||
        updateLine.startsWith(CHANGE_CONTEXT_MARKER);
      if (
        isContextMarker &&
        lastChunk !== undefined &&
        lastChunk.oldLines.length === 0 &&
        lastChunk.newLines.length === 0
      ) {
        this.#error(
          `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        );
      }

      if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER) {
        hunk.chunks.push(emptyChunk());
        return;
      }

      if (updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
        hunk.chunks.push({
          ...emptyChunk(),
          changeContext: updateLine.slice(CHANGE_CONTEXT_MARKER.length),
        });
        return;
      }

      if (updateLine === EOF_MARKER) {
        if (lastChunk === undefined || (lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0)) {
          this.#error("Update hunk does not contain any lines");
        }
        lastChunk.isEndOfFile = true;
        return;
      }

      if (line.length === 0) {
        if (hunk.chunks.length === 0) hunk.chunks.push(emptyChunk());
        pushContextLine(hunk.chunks.at(-1)!, "");
        return;
      }

      const chunk = hunk.chunks.at(-1) ?? (hunk.chunks.push(emptyChunk()), hunk.chunks.at(-1)!);
      if (line.startsWith(" ")) {
        pushContextLine(chunk, line.slice(1));
        return;
      }
      if (line.startsWith("+")) {
        chunk.newLines.push(line.slice(1));
        return;
      }
      if (line.startsWith("-")) {
        chunk.oldLines.push(line.slice(1));
        return;
      }

      this.#error(
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      );
    }

    if (mode === "ended-patch") {
      if (trimmed.length > 0) {
        this.#error(`Unexpected content after '${END_PATCH_MARKER}': '${line}'`);
      }
      return;
    }

    this.#error(`unsupported parser mode: ${String(mode)}`);
  }

  pushDelta(delta: string): Hunk[] {
    for (const char of delta) {
      if (char === "\n") {
        let line = this.#lineBuffer;
        this.#lineBuffer = "";
        if (line.endsWith("\r")) line = line.slice(0, -1);
        this.#lineNumber += 1;
        this.#processLine(line);
      } else {
        this.#lineBuffer += char;
      }
    }
    return this.hunks();
  }

  finish(): Hunk[] {
    if (this.#lineBuffer.length > 0) {
      const line = this.#lineBuffer;
      this.#lineBuffer = "";
      this.#lineNumber += 1;
      this.#processLine(line);
    }
    if (this.#state.mode !== "ended-patch") {
      this.#error(`The last line of the patch must be '${END_PATCH_MARKER}'`);
    }
    return this.hunks();
  }
}
