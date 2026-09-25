import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { relativeTo, resolveWithin } from "../tools/paths.ts";
import type { WorkspaceFileEdit } from "../core/workspace.ts";
import { deriveNewContentsFromChunks } from "./file-update.ts";
import { parsePatch, type ParseMode } from "./parser.ts";
import type { ApplyPatchArgs, ApplyPatchFileUpdateMode, Hunk } from "./types.ts";

export interface ApplyPatchToWorkspaceOptions {
  readonly parseMode?: ParseMode;
  readonly updateFileMode?: ApplyPatchFileUpdateMode;
}

export interface ApplyPatchToWorkspaceResult {
  readonly args: ApplyPatchArgs;
  readonly edits: readonly WorkspaceFileEdit[];
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
}

interface ExistingFile {
  readonly exists: boolean;
  readonly text: string;
  readonly mode: number | undefined;
}

async function readExisting(path: string): Promise<ExistingFile> {
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, text: "", mode: undefined };
    }
    throw error;
  }
  if (!fileStat.isFile()) throw new Error(`not a regular file: ${path}`);
  const bytes = await readFile(path);
  if (bytes.includes(0)) throw new Error(`refusing to modify a binary file: ${path}`);
  return { exists: true, text: bytes.toString("utf8"), mode: fileStat.mode & 0o777 };
}

async function atomicWrite(path: string, text: string, mode: number | undefined): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.bugent-patch-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temp, text, { encoding: "utf8", ...(mode !== undefined ? { mode } : {}) });
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function restoreFiles(originals: ReadonlyMap<string, ExistingFile>): Promise<void> {
  for (const [path, original] of originals) {
    if (original.exists) await atomicWrite(path, original.text, original.mode);
    else await unlink(path).catch(() => {});
  }
}

export async function applyPatchToWorkspace(
  patchText: string,
  cwd: string,
  options: ApplyPatchToWorkspaceOptions = {},
): Promise<ApplyPatchToWorkspaceResult> {
  const args = parsePatch(patchText, options.parseMode ?? "lenient");
  if (args.hunks.length === 0) throw new Error("No files were modified.");

  const updateMode = options.updateFileMode ?? "normalize-lf";
  const states = new Map<string, string | undefined>();
  const originals = new Map<string, ExistingFile>();

  const load = async (path: string): Promise<ExistingFile> => {
    const known = originals.get(path);
    if (known !== undefined) return known;
    const original = await readExisting(path);
    originals.set(path, original);
    return original;
  };

  const currentText = async (path: string, operation: string): Promise<string> => {
    const current = states.has(path) ? states.get(path) : (await load(path)).text;
    if (current === undefined) throw new Error(`${operation} failed: file not found ${relativeTo(cwd, path)}`);
    return current;
  };

  for (const hunk of args.hunks) {
    const source = resolveWithin(cwd, hunk.path);
    if (hunk.type === "add") {
      await load(source);
      states.set(source, hunk.contents);
      continue;
    }
    if (hunk.type === "delete") {
      const current = await currentText(source, "Delete File");
      void current;
      states.set(source, undefined);
      continue;
    }

    const current = await currentText(source, "Update File");
    const derived = deriveNewContentsFromChunks(
      current,
      hunk.path,
      hunk.chunks,
      updateMode,
    );
    if (hunk.movePath !== undefined) {
      const destination = resolveWithin(cwd, hunk.movePath);
      await load(destination);
      states.set(destination, derived.newContents);
      states.set(source, undefined);
    } else {
      states.set(source, derived.newContents);
    }
  }

  const edits: WorkspaceFileEdit[] = [];
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const [path, after] of states) {
    const original = await load(path);
    if (!original.exists && after !== undefined) added.push(relativeTo(cwd, path));
    else if (original.exists && after === undefined) deleted.push(relativeTo(cwd, path));
    else if (original.exists && after !== undefined && original.text !== after) {
      modified.push(relativeTo(cwd, path));
    } else if (!original.exists && after === undefined) {
      continue;
    }
    edits.push({
      path: relativeTo(cwd, path),
      before: original.text,
      after: after ?? "",
      beforeExists: original.exists,
      afterExists: after !== undefined,
      reversible: true,
    });
  }

  const stagedTemps = new Map<string, string>();
  try {
    for (const [path, after] of states) {
      if (after === undefined) continue;
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.bugent-patch-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const original = await load(path);
      await writeFile(temp, after, {
        encoding: "utf8",
        ...(original.mode !== undefined ? { mode: original.mode } : {}),
      });
      if (original.mode !== undefined) await chmod(temp, original.mode);
      stagedTemps.set(path, temp);
    }

    for (const [path, after] of states) {
      if (after === undefined) {
        await unlink(path);
      } else {
        const temp = stagedTemps.get(path);
        if (temp === undefined) throw new Error(`internal: missing staged temp for ${path}`);
        await rename(temp, path);
      }
    }
  } catch (error) {
    for (const temp of stagedTemps.values()) await unlink(temp).catch(() => {});
    try {
      await restoreFiles(originals);
    } catch (rollbackError) {
      throw new Error(
        `apply_patch commit failed and rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    throw error;
  }

  return { args, edits, added, modified, deleted };
}

export function applyPatchSummary(result: ApplyPatchToWorkspaceResult): string {
  const parts: string[] = [];
  if (result.added.length > 0) parts.push(`added ${result.added.length}`);
  if (result.modified.length > 0) parts.push(`modified ${result.modified.length}`);
  if (result.deleted.length > 0) parts.push(`deleted ${result.deleted.length}`);
  return parts.length === 0 ? "No changes" : parts.join(", ");
}

export function affectedHunkPaths(hunks: readonly Hunk[]): string[] {
  return hunks.map((hunk) =>
    hunk.type === "update" && hunk.movePath !== undefined ? hunk.movePath : hunk.path,
  );
}
