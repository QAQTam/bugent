import { describe, expect, test } from "bun:test";
import type { AgentCapability, AgentKind, AgentResult } from "../src/agent/model.ts";
import { compileAgentSandboxSpec } from "../src/agent/sandbox.ts";
import {
  canTransitionAgentStatus,
  createAgentSupervisor,
  type AgentExecutionContext,
  type AgentExecutor,
  type AgentSpec,
} from "../src/agent/supervisor.ts";

const ROOT = "/tmp/bugent-agent-supervisor";

function result(agentId: string, status: AgentResult["status"] = "completed"): AgentResult {
  return {
    agentId,
    status,
    summary: status,
    artifacts: [],
  };
}

function makeSpec(
  agentId: string,
  kind: AgentKind,
  options: {
    parentId?: string;
    rootId?: string;
    sessionId?: string;
    taskId?: string;
    authority?: "none" | "read-only" | "workspace-write" | "full";
    capabilities?: readonly AgentCapability[];
    workspaceAccess?: "none" | "read" | "write";
  } = {},
): AgentSpec {
  const authority = options.authority;
  const capabilities = options.capabilities;
  const sandbox = compileAgentSandboxSpec(
    {
      agentId,
      kind,
      ...(authority !== undefined ? { authority } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      workspace: {
        root: ROOT,
        ...(options.workspaceAccess !== undefined ? { access: options.workspaceAccess } : {}),
      },
    },
    "linux",
  );
  const taskId = options.taskId ?? `task-${agentId}`;
  return {
    identity: {
      agentId,
      ...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
      rootId: options.rootId ?? agentId,
      kind,
      sessionId: options.sessionId ?? `session-${agentId}`,
      taskId,
      createdAt: 1,
    },
    task: {
      id: taskId,
      title: `task ${agentId}`,
      instructions: `do ${agentId}`,
    },
    budget: {
      maxTurns: 10,
      maxToolCalls: 20,
      maxInputTokens: 10_000,
      maxOutputTokens: 4_000,
      maxWallClockMs: 60_000,
    },
    sandbox,
  };
}

describe("P7-B · AgentSupervisor / Handle / EventBus", () => {
  test("spawn runs an executor and resolves the structured result", async () => {
    let complete!: (value: AgentResult) => void;
    const executor: AgentExecutor = {
      run(context: AgentExecutionContext) {
        expect(context.spec.identity.agentId).toBe("worker-1");
        context.report("halfway");
        return new Promise<AgentResult>((resolve) => {
          complete = resolve;
        });
      },
    };
    const supervisor = createAgentSupervisor({ executor });
    const handle = await supervisor.spawn(makeSpec("worker-1", "worker"));

    expect(handle.status).toBe("running");
    expect(supervisor.events.list("worker-1").map((event) => event.type)).toEqual([
      "agent.started",
      "agent.state_changed",
      "agent.message",
    ]);

    complete(result("worker-1"));
    const final = await supervisor.wait("worker-1");
    expect(final.status).toBe("completed");
    expect(handle.result?.summary).toBe("completed");
    expect(supervisor.events.list("worker-1").at(-2)?.type).toBe("agent.state_changed");
    expect(supervisor.events.list("worker-1").at(-1)?.type).toBe("agent.completed");
    await supervisor.dispose();
  });

  test("handle.send and followup route ordered messages to receive()", async () => {
    const received: string[] = [];
    const executor: AgentExecutor = {
      async run(context) {
        const first = await context.receive();
        received.push(`${first?.seq}:${first?.type}`);
        const second = await context.receive();
        received.push(`${second?.seq}:${second?.type}`);
        return result("reviewer-1");
      },
    };
    const supervisor = createAgentSupervisor({ executor });
    const handle = await supervisor.spawn(makeSpec("reviewer-1", "reviewer"));

    await handle.send({ type: "task.question", payload: { question: "which base?" } });
    await handle.followup("inspect the current branch");
    const final = await supervisor.wait("reviewer-1");

    expect(final.status).toBe("completed");
    expect(received).toEqual(["1:task.question", "2:task.assigned"]);
    expect(supervisor.messages("reviewer-1").map((message) => message.seq)).toEqual([1, 2]);
    await supervisor.dispose();
  });

  test("sendToParent routes data to the parent without forging control messages", async () => {
    const parentReceived: string[] = [];
    const executor: AgentExecutor = {
      async run(context) {
        if (context.spec.identity.kind === "main") {
          const message = await context.receive();
          parentReceived.push(`${message?.from}:${message?.type}`);
          return result("main-1");
        }
        await context.sendToParent({
          type: "task.result",
          payload: { summary: "review complete" },
        });
        return result("reviewer-1");
      },
    };
    const supervisor = createAgentSupervisor({ executor });
    await supervisor.spawn(makeSpec("main-1", "main"));
    await supervisor.spawn(
      makeSpec("reviewer-1", "reviewer", {
        parentId: "main-1",
        rootId: "main-1",
      }),
    );

    await supervisor.wait("reviewer-1");
    await supervisor.wait("main-1");
    expect(parentReceived).toEqual(["reviewer-1:task.result"]);
    expect(supervisor.messages("reviewer-1").at(-1)?.from).toBe("reviewer-1");
    await supervisor.dispose();
  });

  test("cancel aborts the executor signal and wins over a late result", async () => {
    let signal: AbortSignal | undefined;
    let finish!: (value: AgentResult) => void;
    const executor: AgentExecutor = {
      run(context) {
        signal = context.signal;
        return new Promise<AgentResult>((resolve) => {
          finish = resolve;
        });
      },
    };
    const supervisor = createAgentSupervisor({ executor });
    const handle = await supervisor.spawn(makeSpec("reviewer-1", "reviewer"));

    await handle.cancel();
    expect(signal?.aborted).toBe(true);
    expect(handle.status).toBe("aborted");
    expect((await supervisor.wait("reviewer-1")).summary).toBe("agent cancelled");

    finish(result("reviewer-1"));
    await Bun.sleep(0);
    expect(handle.status).toBe("aborted");
    await supervisor.dispose();
  });

  test("parent-child authority attenuation is enforced by the supervisor", async () => {
    const supervisor = createAgentSupervisor();
    await supervisor.spawn(
      makeSpec("main-1", "main", {
        authority: "read-only",
        capabilities: ["fs.read"],
        workspaceAccess: "read",
      }),
    );

    await expect(
      supervisor.spawn(
        makeSpec("child-1", "worker", {
          parentId: "main-1",
          rootId: "main-1",
          authority: "workspace-write",
          capabilities: ["fs.read", "fs.write", "process.exec"],
        }),
      ),
    ).rejects.toThrow(/authority/);
    await supervisor.dispose();
  });

  test("child capability attenuation and unique session are enforced", async () => {
    const supervisor = createAgentSupervisor();
    await supervisor.spawn(
      makeSpec("main-1", "main", {
        authority: "full",
        capabilities: ["fs.read", "fs.write", "process.exec"],
      }),
    );

    await expect(
      supervisor.spawn(
        makeSpec("child-1", "worker", {
          parentId: "main-1",
          rootId: "main-1",
          authority: "workspace-write",
          capabilities: ["fs.read", "fs.write", "process.exec", "mcp.use"],
        }),
      ),
    ).rejects.toThrow(/capability/);

    await expect(
      supervisor.spawn(
        makeSpec("child-2", "worker", {
          parentId: "main-1",
          rootId: "main-1",
          authority: "workspace-write",
          capabilities: ["fs.read", "fs.write", "process.exec"],
          sessionId: "session-main-1",
        }),
      ),
    ).rejects.toThrow(/不能复用父 session/);
    await supervisor.dispose();
  });

  test("an external parent must be declared explicitly and still attenuates", async () => {
    const supervisor = createAgentSupervisor();
    const child = makeSpec("reviewer-ext", "reviewer", {
      parentId: "main-ext",
      rootId: "main-ext",
    });

    await expect(supervisor.spawn(child)).rejects.toThrow(/父 agent 不存在/);

    const handle = await supervisor.spawn({
      ...child,
      externalParent: {
        agentId: "main-ext",
        rootId: "main-ext",
        authority: "read-only",
        capabilities: ["fs.read", "process.exec"],
        depth: 0,
        maxDepth: 1,
      },
    });
    expect(handle.parentId).toBe("main-ext");
    expect(handle.status).toBe("running");
    await supervisor.dispose();
  });

  test("maxDepth is enforced recursively", async () => {
    const supervisor = createAgentSupervisor();
    await supervisor.spawn(makeSpec("main-1", "main"));
    await supervisor.spawn(
      makeSpec("reviewer-1", "reviewer", {
        parentId: "main-1",
        rootId: "main-1",
      }),
    );

    await expect(
      supervisor.spawn(
        makeSpec("explorer-1", "explorer", {
          parentId: "reviewer-1",
          rootId: "main-1",
        }),
      ),
    ).rejects.toThrow(/maxDepth/);
    await supervisor.dispose();
  });

  test("event bus sequences per agent and supports filtered subscriptions", async () => {
    const seen: string[] = [];
    const executor: AgentExecutor = {
      run: async () => result("worker-1"),
    };
    const supervisor = createAgentSupervisor({ executor });
    const unsubscribe = supervisor.events.subscribe((event) => {
      seen.push(`${event.agentId}:${event.seq}:${event.type}`);
    }, "worker-1");

    const handle = await supervisor.spawn(makeSpec("worker-1", "worker"));
    await supervisor.wait(handle.id);
    unsubscribe();
    await supervisor.spawn(makeSpec("worker-2", "worker"));
    await supervisor.wait("worker-2");

    expect(supervisor.events.list("worker-1").map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(supervisor.events.list("worker-2").map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(seen).toHaveLength(4);
    await supervisor.dispose();
  });

  test("dispose cancels all non-terminal descendants", async () => {
    const pending: AgentExecutor = {
      run: () => new Promise<AgentResult>(() => {}),
    };
    const supervisor = createAgentSupervisor({ executor: pending });
    await supervisor.spawn(makeSpec("main-1", "main"));
    await supervisor.spawn(
      makeSpec("reviewer-1", "reviewer", {
        parentId: "main-1",
        rootId: "main-1",
      }),
    );

    await supervisor.dispose();
    expect(supervisor.get("main-1")).toBeUndefined();
    expect(supervisor.get("reviewer-1")).toBeUndefined();
  });

  test("state transition table is explicit and terminal states stay terminal", () => {
    expect(canTransitionAgentStatus("starting", "running")).toBe(true);
    expect(canTransitionAgentStatus("running", "blocked")).toBe(true);
    expect(canTransitionAgentStatus("blocked", "running")).toBe(true);
    expect(canTransitionAgentStatus("completed", "running")).toBe(false);
    expect(canTransitionAgentStatus("aborted", "running")).toBe(false);
  });
});
