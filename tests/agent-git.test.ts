import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitWorktreeManager,
  probeGit,
  runGit,
  type GitCapability,
} from "../src/agent/git.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix = "bugent-git-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function initRepo(): Promise<string> {
  const dir = await tempDir();
  const git = Bun.which("git");
  if (git === null) throw new Error("git unavailable");
  const run = async (args: string[]) => {
    const result = await runGit(args, dir, { binary: git });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  };
  await run(["init"]);
  await run(["config", "user.email", "bugent@example.invalid"]);
  await run(["config", "user.name", "bugent test"]);
  await writeFile(join(dir, "tracked.txt"), "base\n", "utf8");
  await run(["add", "tracked.txt"]);
  await run(["commit", "-m", "initial"]);
  return dir;
}

describe("Git capability probe", () => {
  test("missing binary fails closed", async () => {
    const dir = await tempDir();
    const capability = await probeGit(dir, {
      binary: join(dir, "does-not-exist-git"),
    });

    expect(capability.available).toBe(false);
    expect(capability.workerReady).toBe(false);
    expect(capability.reason).toBeDefined();
  });

  test("non-git directory reports an actionable reason", async () => {
    const dir = await tempDir();
    const capability = await probeGit(dir);

    expect(capability.available).toBe(false);
    expect(capability.workerReady).toBe(false);
    expect(capability.reason).toMatch(/Git|worktree|directory/);
  });

  test("clean repository is worker-ready; dirty repository is not", async () => {
    if (Bun.which("git") === null) return;
    const repo = await initRepo();

    const clean = await probeGit(repo);
    expect(clean.available).toBe(true);
    expect(clean.workerReady).toBe(true);
    expect(clean.head).toMatch(/^[0-9a-f]{40}$/);

    await writeFile(join(repo, "tracked.txt"), "dirty\n", "utf8");
    const dirty = await probeGit(repo);
    expect(dirty.available).toBe(true);
    expect(dirty.workerReady).toBe(false);
    expect(dirty.dirty).toBe(true);
  });
});

describe("Git worktree backend", () => {
  test("creates an isolated worktree, exports a patch, and leaves source untouched", async () => {
    if (Bun.which("git") === null) return;
    const repo = await initRepo();
    const capability: GitCapability = await probeGit(repo);
    const worktreeRoot = await tempDir("bugent-worktrees-");
    const artifactRoot = await tempDir("bugent-artifacts-");
    const manager = new GitWorktreeManager({ worktreeRoot, artifactRoot });
    const lease = await manager.create(capability, "worker-1");

    expect(existsSync(lease.path)).toBe(true);
    await writeFile(join(lease.path, "tracked.txt"), "worker change\n", "utf8");
    await writeFile(join(lease.path, "new.txt"), "new file\n", "utf8");

    const diff = await manager.diff(lease, capability);
    expect(diff.patch).toContain("worker change");
    expect(diff.patch).toContain("new file");
    expect(diff.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(diff.changedFiles).toContain("tracked.txt");
    expect(diff.changedFiles).toContain("new.txt");
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("base\n");

    await manager.cleanup(lease, capability);
    expect(existsSync(lease.path)).toBe(false);
  });

  test("dirty workspace refuses worktree creation", async () => {
    if (Bun.which("git") === null) return;
    const repo = await initRepo();
    await writeFile(join(repo, "tracked.txt"), "dirty\n", "utf8");
    const capability = await probeGit(repo);
    const worktreeRoot = await tempDir("bugent-worktrees-dirty-");
    const artifactRoot = await tempDir("bugent-artifacts-dirty-");
    const manager = new GitWorktreeManager({ worktreeRoot, artifactRoot });

    await expect(manager.create(capability, "worker-1")).rejects.toThrow(/uncommitted changes/);
  });
});
