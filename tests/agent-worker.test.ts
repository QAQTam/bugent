import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAgentSandboxSpec } from "../src/agent/sandbox.ts";
import type { AgentSpec } from "../src/agent/supervisor.ts";
import { GitWorktreeManager, runGit } from "../src/agent/git.ts";
import { createWorkerAgentExecutor } from "../src/agent/worker-executor.ts";
import { createInProcessTransport } from "../src/agent/transport.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix = "bugent-worker-"): Promise<string> {
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

function workerSpec(agentId: string, root: string): AgentSpec {
  const taskId = `task-${agentId}`;
  const capabilities = ["fs.read", "fs.write", "process.exec"] as const;
  const sandbox = compileAgentSandboxSpec(
    {
      agentId,
      kind: "worker",
      authority: "workspace-write",
      capabilities,
      workspace: { root, access: "write", isolation: "worktree" },
      parent: { authority: "full", capabilities },
    },
    "linux",
  );
  return {
    identity: {
      agentId,
      parentId: "main-1",
      rootId: "main-1",
      kind: "worker",
      sessionId: `session-${agentId}`,
      taskId,
      createdAt: 1,
    },
    task: {
      id: taskId,
      title: "change tracked file",
      instructions: "Change tracked.txt from base to worker.",
    },
    budget: {
      maxTurns: 10,
      maxToolCalls: 20,
      maxInputTokens: 10_000,
      maxOutputTokens: 4_000,
      maxWallClockMs: 60_000,
    },
    sandbox,
    externalParent: {
      agentId: "main-1",
      rootId: "main-1",
      authority: "full",
      capabilities,
      depth: 0,
      maxDepth: 1,
    },
  };
}

describe("isolated worker executor", () => {
  test("runs in a worktree, exports a patch, and leaves the source workspace unchanged", async () => {
    if (Bun.which("git") === null) return;
    const repo = await initRepo();
    const worktreeRoot = await tempDir("bugent-worker-worktrees-");
    const artifactRoot = await tempDir("bugent-worker-artifacts-");
    const worktrees = new GitWorktreeManager({ worktreeRoot, artifactRoot });
    const client = createMockClient({
      script: [
        {
          toolCalls: [
            {
              id: "edit-1",
              name: "edit_file",
              args: { path: "tracked.txt", old_string: "base", new_string: "worker" },
            },
          ],
        },
        { text: "changed tracked.txt" },
      ],
    });
    const transport = createInProcessTransport({
      executor: createWorkerAgentExecutor({
        client,
        model: "mock",
        worktrees,
      }),
    });

    const result = await transport.wait(await transport.start(workerSpec("worker-1", repo)));
    const output = result.data as {
      changedFiles: readonly string[];
      patchArtifact: string;
      worktreePath: string;
      diffHash: string;
    };

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("changed tracked.txt");
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("base\n");
    expect(output.changedFiles).toEqual(["tracked.txt"]);
    expect(output.diffHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(existsSync(output.patchArtifact)).toBe(true);
    expect(await readFile(output.patchArtifact, "utf8")).toContain("+worker");
    expect(existsSync(output.worktreePath)).toBe(false);
    expect(result.artifacts[0]?.kind).toBe("patch");
    await transport.dispose();
  });

  test("missing Git returns actionable install guidance", async () => {
    const root = await tempDir("bugent-worker-no-git-");
    const transport = createInProcessTransport({
      executor: createWorkerAgentExecutor({
        client: createMockClient({ script: [{ text: "should not run" }] }),
        model: "mock",
        worktrees: new GitWorktreeManager({
          worktreeRoot: await tempDir("bugent-worker-no-git-worktrees-"),
          artifactRoot: await tempDir("bugent-worker-no-git-artifacts-"),
        }),
        probe: async () => ({
          available: false,
          workerReady: false,
          binary: undefined,
          version: undefined,
          repoRoot: undefined,
          head: undefined,
          dirty: false,
          reason: "Git not found",
          installHint: "winget install --id Git.Git -e --source winget",
        }),
      }),
    });

    const result = await transport.wait(await transport.start(workerSpec("worker-1", root)));
    expect(result.status).toBe("error");
    expect(result.summary).toContain("Git not found");
    expect(result.summary).toContain("isolates changes");
    expect(result.summary).toContain("winget install");
    await transport.dispose();
  });

  test("dirty source workspace fails closed before creating a worker", async () => {
    if (Bun.which("git") === null) return;
    const repo = await initRepo();
    await writeFile(join(repo, "tracked.txt"), "dirty\n", "utf8");
    const worktrees = new GitWorktreeManager({
      worktreeRoot: await tempDir("bugent-worker-dirty-worktrees-"),
      artifactRoot: await tempDir("bugent-worker-dirty-artifacts-"),
    });
    const transport = createInProcessTransport({
      executor: createWorkerAgentExecutor({
        client: createMockClient({ script: [{ text: "should not run" }] }),
        model: "mock",
        worktrees,
      }),
    });

    const result = await transport.wait(await transport.start(workerSpec("worker-1", repo)));
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/uncommitted changes/);
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("dirty\n");
    await transport.dispose();
  });
});
