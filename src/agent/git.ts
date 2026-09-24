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
  return "使用系统包管理器安装 git（例如 sudo apt install git）";
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
    return unavailable("未找到 Git");
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
      macShim ? "系统 Git 需要先安装 Xcode Command Line Tools" : "无法执行 Git",
      {
        binary,
        installHint: macShim ? "xcode-select --install" : installHint(),
      },
    );
  }

  const parsedVersion = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (parsedVersion === undefined) {
    return unavailable("无法识别 Git 版本", {
      binary,
      installHint: installHint(),
    });
  }
  const version = `${parsedVersion[0]}.${parsedVersion[1]}.${parsedVersion[2]}`;
  if (!versionAtLeast(parsedVersion, MINIMUM_GIT_VERSION)) {
    return unavailable(`Git ${version} 太旧，至少需要 2.5`, {
      binary,
      version,
    });
  }

  const rootResult = await runGit(["rev-parse", "--show-toplevel"], cwd, {
    binary,
    timeoutMs: options.timeoutMs,
  });
  if (rootResult.code !== 0) {
    return unavailable("当前目录不是 Git 工作树", {
      binary,
      version,
      installHint: "可在项目目录执行 git init，但必须先得到用户明确确认",
    });
  }
  const repoRoot = resolve(rootResult.stdout.trim());

  const bareResult = await runGit(["rev-parse", "--is-bare-repository"], repoRoot, {
    binary,
    timeoutMs: options.timeoutMs,
  });
  if (bareResult.stdout.trim() === "true") {
    return unavailable("bare repository 不能创建 worker worktree", {
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
    return unavailable("Git 仓库还没有初始 commit", {
      binary,
      version,
      repoRoot,
      installHint: "先创建初始 commit，再启用 worker 隔离",
    });
  }
  const head = headResult.stdout.trim();

  const worktreeResult = await runGit(["worktree", "list", "--porcelain"], repoRoot, {
    binary,
    timeoutMs: options.timeoutMs,
  });
  if (worktreeResult.code !== 0) {
    return unavailable("当前 Git 不支持 worktree", {
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
    return unavailable("无法读取 Git 工作区状态", {
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
    reason: dirty ? "工作区有未提交修改；worker 默认不启动" : undefined,
    installHint: undefined,
  };
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (safe.length === 0 || safe === "." || safe === "..") {
    throw new Error("git worktree: agentId 无法转换为安全目录名");
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
      throw new Error(`worker 隔离不可用：${capability.reason ?? "Git capability 缺失"}`);
    }
    if (capability.dirty) {
      throw new Error("worker 隔离不可用：Git 工作区有未提交修改，请先 commit 或 stash");
    }
    if (capability.head === undefined) {
      throw new Error("worker 隔离不可用：仓库没有 HEAD");
    }

    const segment = safeSegment(agentId);
    const path = join(this.worktreeRoot, segment);
    if (!isWithin(this.worktreeRoot, path)) {
      throw new Error("git worktree: 目标路径越界");
    }
    await mkdir(this.worktreeRoot, { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      throw new Error(`git worktree: 目标路径已存在：${path}`);
    }

    const add = await runGit(
      ["worktree", "add", "--detach", path, capability.head],
      capability.repoRoot,
      { binary: capability.binary, timeoutMs: this.#timeoutMs },
    );
    if (add.code !== 0) {
      throw new Error(`git worktree add 失败：${add.stderr.trim() || add.stdout.trim()}`);
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
    if (capability.binary === undefined) throw new Error("git worktree diff: Git binary 缺失");
    const addIntent = await runGit(["add", "-N", "--", "."], lease.path, {
      binary: capability.binary,
      timeoutMs: this.#timeoutMs,
    });
    if (addIntent.code !== 0) {
      throw new Error(`git add -N 失败：${addIntent.stderr.trim()}`);
    }
    const diff = await runGit(
      ["diff", "--binary", "--no-ext-diff", "--no-color", "--", "."],
      lease.path,
      { binary: capability.binary, timeoutMs: this.#timeoutMs },
    );
    if (diff.code !== 0) {
      throw new Error(`git diff 失败：${diff.stderr.trim()}`);
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
