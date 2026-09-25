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
  readonly signal?: AbortSignal;
  readonly verificationCommands?: readonly string[];
  readonly verificationRunner?: (
    command: string,
    signal: AbortSignal,
  ) => Promise<VerificationResult>;
}

export interface VerificationResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export interface ApplyWorkerPatchResult {
  readonly applied: boolean;
  readonly rolledBack: boolean;
  readonly baseRevision: string;
  readonly patchDigest: string;
  readonly changedFiles: readonly string[];
  readonly rollbackPatch: string;
  readonly verifications: readonly VerificationResult[];
  readonly failure: string | undefined;
}

export interface AgentIntegrationRecord extends ApplyWorkerPatchResult {
  readonly agentId: string;
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
  if (!info.isFile()) throw new Error(`integrator: patch is not a file: ${patchPath}`);
  if (info.size > MAX_PATCH_BYTES) {
    throw new Error(`integrator: patch exceeds the ${MAX_PATCH_BYTES} byte limit`);
  }

  const bytes = await readFile(patchPath);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const digest = `sha256:${hasher.digest("hex")}`;
  if (options.expectedDigest !== undefined && options.expectedDigest !== digest) {
    throw new Error(
      `integrator: patch digest mismatch, expected ${options.expectedDigest}, got ${digest}`,
    );
  }

  const capability = await probeGit(options.cwd, { timeoutMs: options.timeoutMs });
  if (!capability.available || capability.binary === undefined || capability.repoRoot === undefined) {
    throw new Error(`integrator: Git unavailable: ${capability.reason ?? "unknown"}`);
  }
  if (!capability.workerReady) {
    throw new Error("integrator: the parent workspace is not clean; refusing to apply the patch");
  }
  if (capability.head !== options.baseRevision) {
    throw new Error(
      `integrator: base revision drifted, worker=${options.baseRevision}, current=${capability.head ?? "unknown"}`,
    );
  }
  const baseRevision = capability.head;
  if (baseRevision === undefined) throw new Error("integrator: the repository has no HEAD");
  const repoRoot = capability.repoRoot;
  const gitBinary = capability.binary;

  const check = await runGit(
    ["apply", "--check", "--binary", "--whitespace=nowarn", patchPath],
    repoRoot,
    { binary: gitBinary, timeoutMs: options.timeoutMs },
  );
  if (check.code !== 0) {
    throw new Error(`integrator: git apply --check failed: ${check.stderr.trim() || check.stdout.trim()}`);
  }

  const numstat = await runGit(
    ["apply", "--numstat", "--binary", "--whitespace=nowarn", patchPath],
    repoRoot,
    { binary: gitBinary, timeoutMs: options.timeoutMs },
  );
  if (numstat.code !== 0) {
    throw new Error(`integrator: cannot parse the patch file list: ${numstat.stderr.trim()}`);
  }

  const apply = await runGit(
    ["apply", "--binary", "--whitespace=nowarn", patchPath],
    repoRoot,
    { binary: gitBinary, timeoutMs: options.timeoutMs },
  );
  if (apply.code !== 0) {
    throw new Error(`integrator: git apply failed: ${apply.stderr.trim() || apply.stdout.trim()}`);
  }

  const changedFiles = patchChangedFiles(numstat.stdout);
  const verifications: VerificationResult[] = [];
  const rollback = async (failure: string): Promise<ApplyWorkerPatchResult> => {
    const reverse = await runGit(
      ["apply", "-R", "--binary", "--whitespace=nowarn", patchPath],
      repoRoot,
      { binary: gitBinary, timeoutMs: options.timeoutMs },
    );
    if (reverse.code !== 0) {
      throw new Error(
        `integrator: automatic rollback failed: ${reverse.stderr.trim() || reverse.stdout.trim()}; ` +
          `run git apply -R ${patchPath} manually`,
      );
    }
    const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], repoRoot, {
      binary: gitBinary,
      timeoutMs: options.timeoutMs,
    });
    if (status.code !== 0 || status.stdout.trim().length > 0) {
      throw new Error(
        `integrator: the workspace is still dirty after rollback: ${status.stdout.trim() || status.stderr.trim()}`,
      );
    }
    return {
      applied: false,
      rolledBack: true,
      baseRevision,
      patchDigest: digest,
      changedFiles,
      rollbackPatch: patchPath,
      verifications,
      failure,
    };
  };

  const diffCheck = await runGit(["diff", "--check"], repoRoot, {
    binary: gitBinary,
    timeoutMs: options.timeoutMs,
  });
  if (diffCheck.code !== 0) {
    return rollback(`git diff --check failed: ${diffCheck.stdout.trim() || diffCheck.stderr.trim()}`);
  }

  const commands = options.verificationCommands ?? [];
  if (commands.length > 0 && options.verificationRunner === undefined) {
    return rollback("integrator: verification commands were given but no verificationRunner exists");
  }
  for (const command of commands) {
    if (options.signal?.aborted) {
      return rollback("integrator: verification was cancelled");
    }
    const result = await options.verificationRunner!(command, options.signal ?? new AbortController().signal);
    verifications.push(result);
    if (result.aborted) return rollback(`verification cancelled: ${command}`);
    if (result.timedOut) return rollback(`verification timed out: ${command}`);
    if (result.exitCode !== 0) {
      return rollback(
        `verification failed (exit=${String(result.exitCode)}): ${command}\n${result.stderr || result.stdout}`,
      );
    }
  }

  return {
    applied: true,
    rolledBack: false,
    baseRevision,
    patchDigest: digest,
    changedFiles,
    rollbackPatch: patchPath,
    verifications,
    failure: undefined,
  };
}
