import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { relativeTo, resolveWithin } from "../tools/paths.ts";
import type { WorkspaceFileEdit } from "../core/workspace.ts";
import { deriveNewContentsFromChunks } from "./file-update.ts";
import { parsePatch, type ParseMode } from "./parser.ts";
import type { ApplyPatchArgs, ApplyPatchFileUpdateMode, Hunk } from "./types.ts";

/** BUG-018：patch 目标文件的全文缓冲上限（读前先 stat，防 OOM）。 */
export const MAX_PATCH_TARGET_BYTES = 64 * 1024 * 1024;

export interface ApplyPatchToWorkspaceOptions {
  readonly parseMode?: ParseMode;
  readonly updateFileMode?: ApplyPatchFileUpdateMode;
  /**
   * 路径解析器。默认 `resolveWithin(cwd, path)` —— 只能落在工作区内。
   *
   * 调用方在**本次调用获准越界**时传入更宽的解析器（见
   * `src/tools/paths.ts` 的 `resolveForWrite`），否则 patch 里的越界路径
   * 会在解析这一步直接抛错，永远走不到闸门。
   */
  readonly resolvePath?: (path: string) => string;
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

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

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
  // BUG-018：patch 是全文缓冲 + 全文写回 —— 先看尺寸再读，别把 agent 进程
  // OOM 在一个几 GB 的日志上。上限与 write_file 的 MAX_WRITE_BYTES 同档。
  if (fileStat.size > MAX_PATCH_TARGET_BYTES) {
    throw new Error(
      `refusing to patch a ${fileStat.size}-byte file (limit ${MAX_PATCH_TARGET_BYTES}): ${path}`,
    );
  }
  const bytes = await readFile(path);
  if (bytes.includes(0)) throw new Error(`refusing to modify a binary file: ${path}`);
  let text: string;
  try {
    text = UTF8_STRICT.decode(bytes);
  } catch {
    // 宽松解码会把非 UTF-8 字节变成 U+FFFD，写回即整文件静默损坏。
    throw new Error(
      `refusing to modify a non-UTF-8 file (decoding losslessly is required, otherwise the file would be corrupted): ${path}`,
    );
  }
  return { exists: true, text, mode: fileStat.mode & 0o777 };
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

  // 默认按文件原有换行风格回写（Windows CRLF 仓库上不再被整体重写成 LF，
  // 模型也不必依赖 seek 的 trimEnd 模糊匹配才能命中 CRLF 行）。
  const updateMode = options.updateFileMode ?? "preserve-line-endings";
  const resolveTarget = options.resolvePath ?? ((path: string) => resolveWithin(cwd, path));
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
    if (current === undefined) throw new Error(`${operation} failed: file not found ${relativeTo(cwd, path).replaceAll("\\", "/")}`);
    return current;
  };

  for (const hunk of args.hunks) {
    const source = resolveTarget(hunk.path);
    if (hunk.type === "add") {
      // Add File 不能静默覆盖已存在的文件（.env / config.json 清成模板就是
      // 一次数据损失）。本 patch 自己先删/先建过这条路径的除外。
      if (!states.has(source)) {
        const existing = await load(source);
        if (existing.exists) {
          throw new Error(
            `Add File failed: file already exists ${relativeTo(cwd, source)} —— 修改已有文件请用 *** Update File:`,
          );
        }
      }
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
      const destination = resolveTarget(hunk.movePath);
      if (destination === source) {
        // states.set(destination, ...) 先写、states.set(source, undefined) 后写，
        // 同路径时后者把前者清成"删除"—— patch 跑完文件就没了。
        throw new Error(
          `Update File + Move to the same path would delete it: ${relativeTo(cwd, source)} —— Move to 需要一个不同的目标路径`,
        );
      }
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
    if (!original.exists && after !== undefined) added.push(relativeTo(cwd, path).replaceAll("\\", "/"));
    else if (original.exists && after === undefined) deleted.push(relativeTo(cwd, path).replaceAll("\\", "/"));
    else if (original.exists && after !== undefined && original.text !== after) {
      modified.push(relativeTo(cwd, path).replaceAll("\\", "/"));
    } else if (!original.exists && after === undefined) {
      continue;
    }
    edits.push({
      path: relativeTo(cwd, path).replaceAll("\\", "/"),
      before: original.text,
      after: after ?? "",
      beforeExists: original.exists,
      afterExists: after !== undefined,
      reversible: true,
    });
  }

  const stagedTemps = new Map<string, string>();
  /*
   * BUG-012：提交期边界复核。staging/rename 会穿透中间目录的符号链接，
   * 并行工具批可以在"resolve 之后、提交之前"把目录换成指向工作区外的链接。
   * 授权放宽（自定义 resolvePath）时不再核对 —— 边界由授权负责。
   */
  const verifyInsideWorkspace = (target: string): void => {
    if (options.resolvePath !== undefined) return;
    let real: string | undefined;
    try {
      real = realpathSync(target);
    } catch {
      return; // 目标不存在：rename/unlink 会给出自己的错误
    }
    resolveWithin(cwd, real);
  };
  try {
    for (const [path, after] of states) {
      if (after === undefined) continue;
      await mkdir(dirname(path), { recursive: true });
      verifyInsideWorkspace(dirname(path));
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
        verifyInsideWorkspace(dirname(path));
        await unlink(path);
      } else {
        const temp = stagedTemps.get(path);
        if (temp === undefined) throw new Error(`internal: missing staged temp for ${path}`);
        verifyInsideWorkspace(dirname(path));
        await rename(temp, path);
        verifyInsideWorkspace(path);
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