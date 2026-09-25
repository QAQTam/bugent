/**
 * Git capability probe and worktree backend.
 *
 * This module is intentionally Git-only for the first worker implementation.
 * If Git or a usable repository is missing, callers fail closed; they must not
 * fall back to writing the main workspace.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface GitCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface GitCapability {
  readonly available: boolean;
  readonly workerReady: boolean;
  readonly binary: string | undefined;
  readonly version: string | undefined;
  readonly repoRoot: string | undefined;
  readonly head: string | undefined;
  readonly dirty: boolean;
  readonly reason: string | undefined;
  readonly installHint: string | undefined;
}

export interface GitWorktreeLease {
  readonly agentId: string;
  readonly sourceRoot: string;
  readonly path: string;
  readonly baseRevision: string;
  readonly locked: boolean;
}

export interface WorktreeDiff {
  readonly patch: string;
  readonly digest: string;
  readonly changedFiles: readonly string[];
  readonly artifactPath: string;
}

export interface GitWorktreeManagerOptions {
  /** Defaults to ~/.bugent/worktrees. */
  readonly worktreeRoot?: string;
  /** Defaults to ~/.bugent/agent-artifacts. */
  readonly artifactRoot?: string;
  readonly timeoutMs?: number;
}

export interface ProbeGitOptions {
  /** Test/override hook. Defaults to Bun.which("git"). */
  readonly binary?: string;
  readonly timeoutMs?: number | undefined;
}

const MINIMUM_GIT_VERSION = [2, 5] as const;

function installHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return "winget install --id Git.Git -e --source winget";
  }
  if (platform === "darwin") {
    return "xcode-select --install 或 brew install git";
  }
  return "install git with your system package manager (for example: sudo apt install git)";
}

function outputText(value: ReadableStream<Uint8Array> | undefined): Promise<string> {
  return value === undefined ? Promise.resolve("") : new Response(value).text();
}

export async function runGit(
  args: readonly string[],
  cwd: string,
  options: {
    readonly binary?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
  } = {},
): Promise<GitCommandResult> {
  const binary = options.binary ?? "git";
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([binary, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        GIT_PAGER: "cat",
        ...(options.env ?? {}),
      },
    });
  } catch (error) {
    return {
      code: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, options.timeoutMs ?? 10_000);

  try {
    const [stdout, stderr, code] = await Promise.all([
      outputText(proc.stdout),
      outputText(proc.stderr),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function parseVersion(versionOutput: string): [number, number, number] | undefined {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/i.exec(versionOutput);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number],
): boolean {
  return actual[0] > minimum[0] || (actual[0] === minimum[0] && actual[1] >= minimum[1]);
}

function unavailable(
  reason: string,
  partial: Partial<GitCapability> = {},
): GitCapability {
  return {
    available: false,
    workerReady: false,
    binary: partial.binary,
    version: partial.version,
    repoRoot: partial.repoRoot,
    head: partial.head,
    dirty: partial.dirty ?? false,
    reason,
    installHint: partial.installHint ?? installHint(),
  };
}

export async function probeGit(
  cwd: string,
  options: ProbeGitOptions = {},
): Promise<GitCapability> {
  const binary = options.binary ?? Bun.which("git") ?? undefined;
  if (binary === undefined) {
    return unavailable("Git not found");
  }

  const versionResult = await runGit(["--version"], cwd, {
    binary,
    timeoutMs: options.timeoutMs,
  });
  if (versionResult.code !== 0) {
    const stderr = `${versionResult.stderr}\n${versionResult.stdout}`.toLowerCase();
    const macShim =
      process.platform === "darwin" &&
      (stderr.includes("xcode-select") || stderr.includes("command line developer tools"));
    return unavailable(
      macShim ? "system Git needs Xcode Command Line Tools first" : "cannot execute Git",
      {
        binary,
        installHint: macShim ? "xcode-select --install" : installHint(),
      },
    );
  }

  const parsedVersion = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (parsedVersion === undefined) {
    return unavailable("cannot determine the Git version", {
      binary,
      installHint: installHint(),
    });
  }
  const version = `${parsedVersion[0]}.${parsedVersion[1]}.${parsedVersion[2]}`;
  if (!versionAtLeast(parsedVersion, MINIMUM_GIT_VERSION)) {
    return unavailable(`Git ${version} is too old; 2.5 or newer is required`, {
      binary,
      version,
    });
  }

  const rootResult = await runGit(["rev-parse", "--show-toplevel"], cwd, {
    binary,
    timeoutMs: options.timeoutMs,
  });
  if (rootResult.code !== 0) {
    return unavailable("the current directory is not a Git work tree", {
      binary,
      version,
      installHint: "git init is possible, but only with explicit user confirmation",
    });
  }
  const repoRoot = resolve(rootResult.stdout.trim());

  const bareResult = await runGit(["rev-parse", "--is-bare-repository"], repoRoot, {
    binary,
    timeoutMs: options.timeoutMs,
  });
  if (bareResult.stdout.trim() === "true") {
    return unavailable("a bare repository cannot host a worker worktree", {
      binary,
      version,
      repoRoot,
    });
  }

  const headResult = await runGit(["rev-parse", "--verify", "HEAD^{commit}"], repoRoot, {
    binary,
    timeoutMs: options.timeoutMs,
  });
  if (headResult.code !== 0) {
    return unavailable("the Git repository has no initial commit yet", {
      binary,
      version,
      repoRoot,
      installHint: "create an initial commit before enabling worker isolation",
    });
  }
  const head = headResult.stdout.trim();

  const worktreeResult = await runGit(["worktree", "list", "--porcelain"], repoRoot, {
    binary,
    timeoutMs: options.timeoutMs,
  });
  if (worktreeResult.code !== 0) {
    return unavailable("this Git build does not support worktrees", {
      binary,
      version,
      repoRoot,
      head,
    });
  }

  const statusResult = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    repoRoot,
    {
      binary,
      timeoutMs: options.timeoutMs,
      env: { GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (statusResult.code !== 0) {
    return unavailable("cannot read the Git worktree status", {
      binary,
      version,
      repoRoot,
      head,
    });
  }
  const dirty = statusResult.stdout.trim().length > 0;

  return {
    available: true,
    workerReady: !dirty,
    binary,
    version,
    repoRoot,
    head,
    dirty,
    reason: dirty ? "the workspace has uncommitted changes; workers stay off by default" : undefined,
    installHint: undefined,
  };
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (safe.length === 0 || safe === "." || safe === "..") {
    throw new Error("git worktree: agentId cannot be turned into a safe directory name");
  }
  return safe;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class GitWorktreeManager {
  readonly worktreeRoot: string;
  readonly artifactRoot: string;
  readonly #timeoutMs: number;

  constructor(options: GitWorktreeManagerOptions = {}) {
    this.worktreeRoot = resolve(options.worktreeRoot ?? join(homedir(), ".bugent", "worktrees"));
    this.artifactRoot = resolve(options.artifactRoot ?? join(homedir(), ".bugent", "agent-artifacts"));
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async create(capability: GitCapability, agentId: string): Promise<GitWorktreeLease> {
    if (!capability.available || capability.binary === undefined || capability.repoRoot === undefined) {
      throw new Error(`worker isolation unavailable: ${capability.reason ?? "missing Git capability"}`);
    }
    if (capability.dirty) {
      throw new Error("worker isolation unavailable: the Git workspace has uncommitted changes; commit or stash first");
    }
    if (capability.head === undefined) {
      throw new Error("worker isolation unavailable: the repository has no HEAD");
    }

    const segment = safeSegment(agentId);
    const path = join(this.worktreeRoot, segment);
    if (!isWithin(this.worktreeRoot, path)) {
      throw new Error("git worktree: target path escapes the workspace");
    }
    await mkdir(this.worktreeRoot, { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      throw new Error(`git worktree: target path already exists: ${path}`);
    }

    const add = await runGit(
      ["worktree", "add", "--detach", path, capability.head],
      capability.repoRoot,
      { binary: capability.binary, timeoutMs: this.#timeoutMs },
    );
    if (add.code !== 0) {
      throw new Error(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
    }

    const lock = await runGit(
      ["worktree", "lock", "--reason", `bugent agent ${agentId}`, path],
      capability.repoRoot,
      { binary: capability.binary, timeoutMs: this.#timeoutMs },
    );
    return {
      agentId,
      sourceRoot: capability.repoRoot,
      path,
      baseRevision: capability.head,
      locked: lock.code === 0,
    };
  }

  async diff(lease: GitWorktreeLease, capability: GitCapability): Promise<WorktreeDiff> {
    if (capability.binary === undefined) throw new Error("git worktree diff: Git binary is missing");
    const addIntent = await runGit(["add", "-N", "--", "."], lease.path, {
      binary: capability.binary,
      timeoutMs: this.#timeoutMs,
    });
    if (addIntent.code !== 0) {
      throw new Error(`git add -N failed: ${addIntent.stderr.trim()}`);
    }
    const diff = await runGit(
      ["diff", "--binary", "--no-ext-diff", "--no-color", "--", "."],
      lease.path,
      { binary: capability.binary, timeoutMs: this.#timeoutMs },
    );
    if (diff.code !== 0) {
      throw new Error(`git diff failed: ${diff.stderr.trim()}`);
    }
    const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], lease.path, {
      binary: capability.binary,
      timeoutMs: this.#timeoutMs,
    });
    const changedFiles = status.stdout
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((line) => line.length > 0);

    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(diff.stdout);
    const digest = `sha256:${hasher.digest("hex")}`;
    const artifactPath = join(this.artifactRoot, safeSegment(lease.agentId), "diff.patch");
    await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
    await writeFile(artifactPath, diff.stdout, { mode: 0o600 });

    return {
      patch: diff.stdout,
      digest,
      changedFiles,
      artifactPath,
    };
  }

  async cleanup(lease: GitWorktreeLease, capability: GitCapability): Promise<void> {
    if (capability.binary === undefined || capability.repoRoot === undefined) return;
    if (lease.locked) {
      await runGit(["worktree", "unlock", lease.path], capability.repoRoot, {
        binary: capability.binary,
        timeoutMs: this.#timeoutMs,
      });
    }
    const removed = await runGit(
      ["worktree", "remove", "--force", lease.path],
      capability.repoRoot,
      { binary: capability.binary, timeoutMs: this.#timeoutMs },
    );
    if (removed.code !== 0) {
      if (isWithin(this.worktreeRoot, lease.path) && existsSync(lease.path)) {
        await rm(lease.path, { recursive: true, force: true });
      }
      await runGit(["worktree", "prune"], capability.repoRoot, {
        binary: capability.binary,
        timeoutMs: this.#timeoutMs,
      });
    }
  }
}
