/**
 * Deterministic workspace integrator.
 *
 * Integration is deliberately not delegated to an LLM: a worker patch is only
 * applied when ownership, base revision, workspace cleanliness, digest and
 * `git apply --check` all pass.
 */

import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { probeGit, runGit } from "./git.ts";

export interface ApplyWorkerPatchOptions {
  readonly cwd: string;
  readonly baseRevision: string;
  readonly patchPath: string;
  readonly expectedDigest?: string;
  readonly timeoutMs?: number;
}

export interface ApplyWorkerPatchResult {
  readonly applied: true;
  readonly baseRevision: string;
  readonly patchDigest: string;
  readonly changedFiles: readonly string[];
  readonly rollbackPatch: string;
}

const MAX_PATCH_BYTES = 32 * 1024 * 1024;

function patchChangedFiles(numstat: string): string[] {
  return numstat
    .split("\n")
    .map((line) => line.split("\t")[2]?.trim() ?? "")
    .filter((path) => path.length > 0);
}

export async function applyWorkerPatch(
  options: ApplyWorkerPatchOptions,
): Promise<ApplyWorkerPatchResult> {
  const patchPath = resolve(options.patchPath);
  const info = await stat(patchPath);
  if (!info.isFile()) throw new Error(`integrator: patch 不是文件：${patchPath}`);
  if (info.size > MAX_PATCH_BYTES) {
    throw new Error(`integrator: patch 超过 ${MAX_PATCH_BYTES} bytes 限制`);
  }

  const bytes = await readFile(patchPath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const digest = `sha256:${hasher.digest("hex")}`;
  if (options.expectedDigest !== undefined && options.expectedDigest !== digest) {
    throw new Error(
      `integrator: patch digest 不匹配，期望 ${options.expectedDigest}，实际 ${digest}`,
    );
  }

  const capability = await probeGit(options.cwd, { timeoutMs: options.timeoutMs });
  if (!capability.available || capability.binary === undefined || capability.repoRoot === undefined) {
    throw new Error(`integrator: Git 不可用：${capability.reason ?? "unknown"}`);
  }
  if (!capability.workerReady) {
    throw new Error("integrator: 主工作区不是 clean 状态，拒绝应用 patch");
  }
  if (capability.head !== options.baseRevision) {
    throw new Error(
      `integrator: base revision 已漂移，worker=${options.baseRevision}，当前=${capability.head ?? "unknown"}`,
    );
  }

  const check = await runGit(
    ["apply", "--check", "--binary", "--whitespace=nowarn", patchPath],
    capability.repoRoot,
    { binary: capability.binary, timeoutMs: options.timeoutMs },
  );
  if (check.code !== 0) {
    throw new Error(`integrator: git apply --check 失败：${check.stderr.trim() || check.stdout.trim()}`);
  }

  const numstat = await runGit(
    ["apply", "--numstat", "--binary", "--whitespace=nowarn", patchPath],
    capability.repoRoot,
    { binary: capability.binary, timeoutMs: options.timeoutMs },
  );
  if (numstat.code !== 0) {
    throw new Error(`integrator: 无法解析 patch 文件列表：${numstat.stderr.trim()}`);
  }

  const apply = await runGit(
    ["apply", "--binary", "--whitespace=nowarn", patchPath],
    capability.repoRoot,
    { binary: capability.binary, timeoutMs: options.timeoutMs },
  );
  if (apply.code !== 0) {
    throw new Error(`integrator: git apply 失败：${apply.stderr.trim() || apply.stdout.trim()}`);
  }

  return {
    applied: true,
    baseRevision: capability.head,
    patchDigest: digest,
    changedFiles: patchChangedFiles(numstat.stdout),
    rollbackPatch: patchPath,
  };
}
