/**
 * Isolated worker executor.
 *
 * A worker never receives the main workspace path as its tool cwd. It runs in a
 * Git worktree, exports a patch, and leaves integration to the parent.
 */

import { randomUUID } from "node:crypto";
import { AgentSession } from "../core/session.ts";
import { runUserTurn } from "../core/loop.ts";
import type { ModelClient } from "../provider/types.ts";
import { createBashTool } from "../tools/bash.ts";
import { createApplyPatchTool } from "../tools/apply-patch.ts";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
} from "../tools/files.ts";
import { ToolRegistry } from "../tools/types.ts";
import { createSandboxedShellRunner, isSandboxAvailable } from "../sandbox/bwrap.ts";
import {
  GitWorktreeManager,
  probeGit,
  type GitCapability,
} from "./git.ts";
import { SUBAGENT_MAX_STEPS } from "./model.ts";
import type { AgentExecutor, AgentExecutionContext } from "./supervisor.ts";

export interface WorkerAgentExecutorOptions {
  readonly client: ModelClient;
  readonly model: string;
  readonly worktrees: GitWorktreeManager;
  readonly maxSteps?: number;
  readonly probe?: (cwd: string) => Promise<GitCapability>;
}

export interface WorkerAgentOutput {
  readonly text: string;
  readonly steps: number;
  readonly finishReason: string;
  readonly baseRevision: string;
  readonly diffHash: string;
  readonly changedFiles: readonly string[];
  readonly patchArtifact: string;
  readonly worktreePath: string;
}

const WORKER_SYSTEM = [
  "You are an isolated implementation worker.",
  "All file tools and commands run inside a dedicated Git worktree.",
  "Do not attempt to access or modify the parent workspace.",
  "Network is disabled. Do not request credentials or permission escalation.",
  "Implement the assigned task, run relevant checks, and report what changed.",
].join("\n");

function summary(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return "worker completed with empty output";
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 499)}…`;
}

function promptFor(
  context: AgentExecutionContext,
  worktree: string,
  baseRevision: string,
): string {
  return [
    `Task: ${context.spec.task.title}`,
    "",
    context.spec.task.instructions,
    "",
    `Isolated worktree: ${worktree}`,
    `Base revision: ${baseRevision}`,
    "",
    "Work only in the isolated worktree.",
    "Return a concise report: changes made, tests run, failures, and remaining risks.",
  ].join("\n");
}

function workerRegistry(cwd: string): ToolRegistry {
  const registry = new ToolRegistry()
    .register(createReadFileTool())
    .register(createWriteFileTool())
    .register(createEditFileTool())
    .register(createApplyPatchTool());
  if (isSandboxAvailable()) {
    registry.register(
      createBashTool(
        createSandboxedShellRunner({
          workspaceWrite: true,
          allowNetwork: false,
        }),
      ),
    );
  }
  return registry;
}

export function createWorkerAgentExecutor(
  options: WorkerAgentExecutorOptions,
): AgentExecutor {
  const probe = options.probe ?? probeGit;

  return {
    async run(context: AgentExecutionContext) {
      if (context.spec.identity.kind !== "worker") {
        throw new Error(`worker executor only supports worker, received ${context.spec.identity.kind}`);
      }
      if (context.spec.sandbox.workspace.isolation !== "worktree") {
        throw new Error("worker executor requires workspace.isolation=worktree");
      }
      if (
        context.spec.sandbox.authority !== "workspace-write" &&
        context.spec.sandbox.authority !== "full"
      ) {
        throw new Error(`worker executor requires a writable authority, received ${context.spec.sandbox.authority}`);
      }
      if (!context.spec.sandbox.capabilities.includes("fs.write")) {
        throw new Error("worker executor requires the fs.write capability");
      }
      if (context.signal.aborted) {
        return {
          agentId: context.spec.identity.agentId,
          status: "aborted",
          summary: "worker aborted before start",
          artifacts: [],
        };
      }

      const sourceRoot = context.spec.sandbox.workspace.root;
      const capability = await probe(sourceRoot);
      if (!capability.available || !capability.workerReady) {
        throw new Error(
          `worker isolation unavailable: ${capability.reason ?? "missing Git capability"}. ` +
            "A Git worktree isolates changes, exports a patch, and keeps subagents from touching the parent workspace. " +
            (capability.installHint !== undefined ? ` Install hint: ${capability.installHint}` : ""),
        );
      }

      const lease = await options.worktrees.create(capability, context.spec.identity.agentId);
      let diff:
        | Awaited<ReturnType<GitWorktreeManager["diff"]>>
        | undefined;
      try {
        context.report("worker worktree ready", {
          path: lease.path,
          baseRevision: lease.baseRevision,
        });
        const session = new AgentSession({
          id: `agent-worker-${randomUUID()}`,
          system: WORKER_SYSTEM,
          mcpManifest: "# MCP servers\n\n(none)",
          skillsManifest: "# Skills\n\n(none)",
          client: options.client,
          model: options.model,
        });
        const registry = workerRegistry(lease.path);
        context.report("worker started", {
          tools: registry.list().map((tool) => tool.name),
        });

        const turn = await runUserTurn(session, promptFor(context, lease.path, lease.baseRevision), {
          tools: registry,
          cwd: lease.path,
          signal: context.signal,
          maxSteps: options.maxSteps ?? SUBAGENT_MAX_STEPS,
          hooks: {
            onToolCall: (call) => {
              context.report(`tool call: ${call.name}`, { toolCallId: call.id });
            },
            onRequestCapability: async () => false,
            onAskUser: async () => undefined,
            onExtensionRoleFallback: async () => false,
          },
        });
        diff = await options.worktrees.diff(lease, capability);

        const status = context.signal.aborted
          ? "aborted"
          : turn.reason === "error"
            ? "error"
            : "completed";
        const output: WorkerAgentOutput = {
          text: turn.text,
          steps: turn.steps,
          finishReason: turn.reason,
          baseRevision: lease.baseRevision,
          diffHash: diff.digest,
          changedFiles: diff.changedFiles,
          patchArtifact: diff.artifactPath,
          worktreePath: lease.path,
        };
        return {
          agentId: context.spec.identity.agentId,
          ...(context.spec.identity.taskId !== undefined
            ? { taskId: context.spec.identity.taskId }
            : {}),
          status,
          summary: summary(turn.text),
          artifacts: [
            {
              artifactId: `${context.spec.identity.agentId}:diff`,
              kind: "patch",
              path: diff.artifactPath,
              digest: diff.digest,
              mediaType: "text/x-diff",
            },
          ],
          data: output,
        };
      } finally {
        await options.worktrees.cleanup(lease, capability);
      }
    },
  };
}
