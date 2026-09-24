import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeGit, runGit } from "../src/agent/git.ts";
import { applyWorkerPatch } from "../src/agent/integrator.ts";
import { createInProcessTransport } from "../src/agent/transport.ts";
import type { AgentExecutor } from "../src/agent/supervisor.ts";
import {
  APPLY_SUBAGENT_PATCH_TOOL_NAME,
  SPAWN_SUBAGENT_TOOL_NAME,
  WAIT_SUBAGENT_TOOL_NAME,
  createAgentTools,
  type AgentToolsParent,
} from "../src/tools/agent.ts";
import type { Tool, ToolCtx } from "../src/tools/types.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix = "bugent-integrator-"): Promise<string> {
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

async function patchArtifact(root: string, value = "integrated"): Promise<{
  path: string;
  digest: string;
}> {
  const patch = [
    "diff --git a/tracked.txt b/tracked.txt",
    "--- a/tracked.txt",
    "+++ b/tracked.txt",
    "@@ -1 +1 @@",
    "-base",
    `+${value}`,
    "",
  ].join("\n");
  const path = join(root, "diff.patch");
  await writeFile(path, patch, "utf8");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(patch);
  return { path, digest: `sha256:${hasher.digest("hex")}` };
}

function parent(repo: string): AgentToolsParent {
  return {
    agentId: "main-1",
    rootId: "main-1",
    sessionId: "session-main-1",
    authority: "full",
    capabilities: ["fs.read", "fs.write", "process.exec", "agent.spawn"],
  };
}

describe("workspace integrator", () => {
  test("applies a digest-verified patch to a clean repo", async () => {
    if (Bun.which("git") === null) return;
    const repo = await initRepo();
    const capability = await probeGit(repo);
    const artifact = await patchArtifact(await tempDir("bugent-patch-"));

    const result = await applyWorkerPatch({
      cwd: repo,
      baseRevision: capability.head!,
      patchPath: artifact.path,
      expectedDigest: artifact.digest,
    });

    expect(result.applied).toBe(true);
    expect(result.changedFiles).toEqual(["tracked.txt"]);
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("integrated\n");
  });

  test("runs verification commands and keeps the patch when they pass", async () => {
    if (Bun.which("git") === null) return;
    const repo = await initRepo();
    const capability = await probeGit(repo);
    const artifact = await patchArtifact(await tempDir("bugent-patch-verify-"));
    const seen: string[] = [];

    const result = await applyWorkerPatch({
      cwd: repo,
      baseRevision: capability.head!,
      patchPath: artifact.path,
      expectedDigest: artifact.digest,
      verificationCommands: ["check-one", "check-two"],
      verificationRunner: async (command) => {
        seen.push(command);
        return {
          command,
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          aborted: false,
        };
      },
    });

    expect(result.applied).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(seen).toEqual(["check-one", "check-two"]);
    expect(result.verifications).toHaveLength(2);
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("integrated\n");
  });

  test("automatically rolls back when a verification command fails", async () => {
    if (Bun.which("git") === null) return;
    const repo = await initRepo();
    const capability = await probeGit(repo);
    const artifact = await patchArtifact(await tempDir("bugent-patch-rollback-"));

    const result = await applyWorkerPatch({
      cwd: repo,
      baseRevision: capability.head!,
      patchPath: artifact.path,
      expectedDigest: artifact.digest,
      verificationCommands: ["fail-check"],
      verificationRunner: async (command) => ({
        command,
        exitCode: 1,
        stdout: "",
        stderr: "verification failed",
        timedOut: false,
        aborted: false,
      }),
    });

    expect(result.applied).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.failure).toContain("verification failed");
    expect(result.verifications).toHaveLength(1);
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("base\n");
    const status = await runGit(["status", "--porcelain=v1"], repo, {
      binary: Bun.which("git")!,
    });
    expect(status.stdout.trim()).toBe("");
  });

  test("rejects digest mismatch, dirty workspace, and revision drift", async () => {
    if (Bun.which("git") === null) return;
    const repo = await initRepo();
    const capability = await probeGit(repo);
    const artifact = await patchArtifact(await tempDir("bugent-patch-reject-"));

    await expect(
      applyWorkerPatch({
        cwd: repo,
        baseRevision: capability.head!,
        patchPath: artifact.path,
        expectedDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).rejects.toThrow(/digest/);

    await writeFile(join(repo, "tracked.txt"), "dirty\n", "utf8");
    await expect(
      applyWorkerPatch({
        cwd: repo,
        baseRevision: capability.head!,
        patchPath: artifact.path,
        expectedDigest: artifact.digest,
      }),
    ).rejects.toThrow(/clean/);

    await writeFile(join(repo, "tracked.txt"), "base\n", "utf8");
    await runGit(["commit", "--allow-empty", "-m", "drift"], repo, {
      binary: Bun.which("git")!,
    });
    await expect(
      applyWorkerPatch({
        cwd: repo,
        baseRevision: capability.head!,
        patchPath: artifact.path,
        expectedDigest: artifact.digest,
      }),
    ).rejects.toThrow(/漂移/);
  });

  test("apply_subagent_patch only accepts an owned completed worker artifact", async () => {
    if (Bun.which("git") === null) return;
    const repo = await initRepo();
    const capability = await probeGit(repo);
    const artifact = await patchArtifact(await tempDir("bugent-patch-tool-"));
    const executor: AgentExecutor = {
      async run(context) {
        return {
          agentId: context.spec.identity.agentId,
          status: "completed",
          summary: "worker complete",
          artifacts: [
            {
              artifactId: "patch-1",
              kind: "patch",
              path: artifact.path,
              digest: artifact.digest,
              mediaType: "text/x-diff",
            },
          ],
          data: {
            text: "worker complete",
            steps: 1,
            finishReason: "stop",
            baseRevision: capability.head,
            diffHash: artifact.digest,
            changedFiles: ["tracked.txt"],
            patchArtifact: artifact.path,
            worktreePath: "/tmp/removed-worktree",
          },
        };
      },
    };
    const transport = createInProcessTransport({ executor });
    const tools = new Map(
      createAgentTools({
        transport,
        parent: parent(repo),
        cwd: repo,
        verificationRunner: {
          async run() {
            return {
              stdout: "ok",
              stderr: "",
              exitCode: 0,
              timedOut: false,
              aborted: false,
              truncated: false,
              durationMs: 0,
            };
          },
        },
        idFactory: (() => {
          const values = ["worker-1", "task-1", "session-1"];
          return () => values.shift()!;
        })(),
      }).map((tool) => [tool.name, tool] as const),
    );
    const ctx: ToolCtx = {
      cwd: repo,
      signal: new AbortController().signal,
      callId: "call-1",
      sessionId: "session-main-1",
    };

    await tools.get(SPAWN_SUBAGENT_TOOL_NAME)!.run(
      { kind: "worker", task: "change tracked" },
      ctx,
    );
    await tools.get(WAIT_SUBAGENT_TOOL_NAME)!.run({ agent_id: "worker-1" }, ctx);
    const apply = tools.get(APPLY_SUBAGENT_PATCH_TOOL_NAME)!;
    expect(apply.defaultPermission).toBe("ask");
    const result = (await apply.run(
      { agent_id: "worker-1", verify_commands: ["check"] },
      ctx,
    )) as {
      applied: boolean;
      changed_files: string[];
      verifications: unknown[];
    };

    expect(result.applied).toBe(true);
    expect(result.changed_files).toEqual(["tracked.txt"]);
    expect(result.verifications).toHaveLength(1);
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("integrated\n");
    await transport.dispose();
  });
});
