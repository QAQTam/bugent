/** Codex-compatible apply_patch data model. */

export const BEGIN_PATCH_MARKER = "*** Begin Patch";
export const END_PATCH_MARKER = "*** End Patch";
export const ADD_FILE_MARKER = "*** Add File: ";
export const DELETE_FILE_MARKER = "*** Delete File: ";
export const UPDATE_FILE_MARKER = "*** Update File: ";
export const MOVE_TO_MARKER = "*** Move to: ";
export const EOF_MARKER = "*** End of File";
export const CHANGE_CONTEXT_MARKER = "@@ ";
export const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
export const ENVIRONMENT_ID_MARKER = "*** Environment ID:";

export type ApplyPatchFileUpdateMode = "normalize-lf" | "preserve-line-endings";

export interface UpdateFileChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  contextLineIndices: Array<readonly [number, number]>;
  isEndOfFile: boolean;
}

export interface AddFileHunk {
  type: "add";
  path: string;
  contents: string;
}

export interface DeleteFileHunk {
  type: "delete";
  path: string;
}

export interface UpdateFileHunk {
  type: "update";
  path: string;
  movePath?: string;
  chunks: UpdateFileChunk[];
}

export type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

export interface ApplyPatchArgs {
  patch: string;
  hunks: Hunk[];
  environmentId?: string;
}

export type Replacement = readonly [
  startIndex: number,
  oldLength: number,
  newLines: readonly string[],
];

export class PatchParseError extends Error {
  readonly lineNumber: number | undefined;

  constructor(message: string, lineNumber?: number) {
    super(lineNumber === undefined ? `invalid patch: ${message}` : `invalid hunk at line ${lineNumber}, ${message}`);
    this.name = "PatchParseError";
    this.lineNumber = lineNumber;
  }
}

export function cloneChunk(chunk: UpdateFileChunk): UpdateFileChunk {
  return {
    ...(chunk.changeContext !== undefined ? { changeContext: chunk.changeContext } : {}),
    oldLines: [...chunk.oldLines],
    newLines: [...chunk.newLines],
    contextLineIndices: chunk.contextLineIndices.map(([a, b]) => [a, b] as const),
    isEndOfFile: chunk.isEndOfFile,
  };
}

export function cloneHunk(hunk: Hunk): Hunk {
  if (hunk.type === "add") return { ...hunk };
  if (hunk.type === "delete") return { ...hunk };
  return {
    type: "update",
    path: hunk.path,
    ...(hunk.movePath !== undefined ? { movePath: hunk.movePath } : {}),
    chunks: hunk.chunks.map(cloneChunk),
  };
}
