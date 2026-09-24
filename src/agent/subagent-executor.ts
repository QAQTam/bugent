/**
 * AgentKind executor router.
 *
 * Transport stays generic; this router chooses the concrete execution profile
 * after the supervisor has validated identity, authority and capabilities.
 */

import type { ModelClient } from "../provider/types.ts";
import { createReadOnlyAgentExecutor } from "./read-only-executor.ts";
import { GitWorktreeManager } from "./git.ts";
import { createWorkerAgentExecutor } from "./worker-executor.ts";
import type { AgentExecutor } from "./supervisor.ts";

export interface SubagentExecutorOptions {
  readonly client: ModelClient;
  readonly model: string;
  readonly worktrees?: GitWorktreeManager;
  readonly maxSteps?: number;
}

export function createSubagentExecutor(options: SubagentExecutorOptions): AgentExecutor {
  const readOnly = createReadOnlyAgentExecutor({
    client: options.client,
    model: options.model,
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
  });
  const worktrees = options.worktrees ?? new GitWorktreeManager();
  const worker = createWorkerAgentExecutor({
    client: options.client,
    model: options.model,
    worktrees,
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
  });

  return {
    run(context) {
      if (context.spec.identity.kind === "reviewer" || context.spec.identity.kind === "explorer") {
        return readOnly.run(context);
      }
      if (context.spec.identity.kind === "worker") {
        return worker.run(context);
      }
      throw new Error(`subagent executor 不支持 kind=${context.spec.identity.kind}`);
    },
  };
}
