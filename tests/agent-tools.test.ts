import { describe, expect, test } from "bun:test";
import type { AgentResult } from "../src/agent/model.ts";
import type { AgentExecutor } from "../src/agent/supervisor.ts";
import { createInProcessTransport } from "../src/agent/transport.ts";
import {
  FOLLOWUP_SUBAGENT_TOOL_NAME,
  GET_SUBAGENT_OUTPUT_TOOL_NAME,
  GET_SUBAGENT_TOOL_NAME,
  INTERRUPT_SUBAGENT_TOOL_NAME,
  LIST_SUBAGENTS_TOOL_NAME,
  SPAWN_SUBAGENT_TOOL_NAME,
  WAIT_SUBAGENT_TOOL_NAME,
  createAgentTools,
  type AgentToolsOptions,
} from "../src/tools/agent.ts";
import type { Tool, ToolCtx } from "../src/tools/types.ts";

const CTX: ToolCtx = {
  cwd: "/tmp/bugent-agent-tools",
  signal: new AbortController().signal,
  callId: "call-1",
  sessionId: "session-main-1",
};

function parent(agentId = "main-1"): AgentToolsOptions["parent"] {
  return {
    agentId,
    rootId: agentId,
    sessionId: "session-main-1",
    authority: "full",
    capabilities: ["fs.read", "process.exec", "agent.spawn"],
  };
}

function toolsFor(
  executor: AgentExecutor,
  options: {
    parent?: AgentToolsOptions["parent"];
    idFactory?: AgentToolsOptions["idFactory"];
    notifications?: AgentToolsOptions["notifications"];
  } = {},
): { tools: Map<string, Tool>; transport: ReturnType<typeof createInProcessTransport> } {
  const transport = createInProcessTransport({ executor });
  const tools = createAgentTools({
    transport,
    parent: options.parent ?? parent(),
    cwd: CTX.cwd,
    ...(options.idFactory !== undefined ? { idFactory: options.idFactory } : {}),
    ...(options.notifications !== undefined ? { notifications: options.notifications } : {}),
  });
  return { tools: new Map(tools.map((tool) => [tool.name, tool])), transport };
}

describe("agent model tools", () => {
  test("spawn/list/get/wait/output preserve the handle-only contract", async () => {
    const executor: AgentExecutor = {
      async run(context) {
        return {
          agentId: context.spec.identity.agentId,
          status: "completed",
          summary: "review done",
          artifacts: [],
          data: { text: "review body" },
        };
      },
    };
    const { tools, transport } = toolsFor(executor, {
      idFactory: (() => {
        const values = ["agent-1", "task-1", "agent-session-1"];
        return () => values.shift()!;
      })(),
    });

    const spawn = tools.get(SPAWN_SUBAGENT_TOOL_NAME)!;
    expect(spawn.defaultPermission).toBe("ask");
    const spawned = (await spawn.run(
      { kind: "reviewer", task: "review this", title: "Review" },
      CTX,
    )) as Record<string, unknown>;
    expect(spawned.agent_id).toBe("agent-1");
    expect(spawned.task_id).toBe("task-1");
    expect(spawned.capabilities).toEqual(["fs.read", "process.exec"]);

    const listed = (await tools.get(LIST_SUBAGENTS_TOOL_NAME)!.run({}, CTX)) as {
      agents: Record<string, unknown>[];
    };
    expect(listed.agents).toHaveLength(1);

    const waited = (await tools.get(WAIT_SUBAGENT_TOOL_NAME)!.run(
      { agent_id: "agent-1", timeout_ms: 1000 },
      CTX,
    )) as Record<string, unknown>;
    expect(waited.status).toBe("completed");

    const got = (await tools.get(GET_SUBAGENT_TOOL_NAME)!.run(
      { agent_id: "agent-1" },
      CTX,
    )) as Record<string, unknown>;
    expect(got.summary).toBe("review done");

    const output = (await tools.get(GET_SUBAGENT_OUTPUT_TOOL_NAME)!.run(
      { agent_id: "agent-1" },
      CTX,
    )) as Record<string, unknown>;
    expect(output.output).toEqual({ text: "review body" });
    expect(output.trust).toBe("untrusted-data");
    await transport.dispose();
  });

  test("completion notification is a developer-safe summary, not the child output", async () => {
    const notifications: { text: string; source: string }[] = [];
    const executor: AgentExecutor = {
      async run(context) {
        return {
          agentId: context.spec.identity.agentId,
          status: "completed",
          summary: "found one issue",
          artifacts: [],
          data: { text: "SECRET FULL OUTPUT" },
        };
      },
    };
    const { tools, transport } = toolsFor(executor, {
      notifications: {
        enqueueInjection(text, source) {
          notifications.push({ text, source });
        },
      },
      idFactory: (() => {
        const values = ["agent-notify", "task-notify", "agent-session-notify"];
        return () => values.shift()!;
      })(),
    });

    await tools.get(SPAWN_SUBAGENT_TOOL_NAME)!.run(
      { kind: "reviewer", task: "review this" },
      CTX,
    );
    await tools.get(WAIT_SUBAGENT_TOOL_NAME)!.run(
      { agent_id: "agent-notify" },
      CTX,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.source).toBe("agent");
    expect(notifications[0]?.text).toContain("agent-notify");
    expect(notifications[0]?.text).toContain("found one issue");
    expect(notifications[0]?.text).toContain("untrusted-data");
    expect(notifications[0]?.text).not.toContain("SECRET FULL OUTPUT");
    await transport.dispose();
  });

  test("followup delivers a task.assigned message without changing capabilities", async () => {
    const executor: AgentExecutor = {
      async run(context) {
        const message = await context.receive();
        return {
          agentId: context.spec.identity.agentId,
          status: "completed",
          summary: String((message?.payload as { task?: string } | undefined)?.task ?? ""),
          artifacts: [],
        };
      },
    };
    const { tools, transport } = toolsFor(executor, {
      idFactory: (() => {
        const values = ["agent-2", "task-2", "agent-session-2"];
        return () => values.shift()!;
      })(),
    });
    await tools.get(SPAWN_SUBAGENT_TOOL_NAME)!.run(
      { kind: "explorer", task: "initial task" },
      CTX,
    );
    await tools.get(FOLLOWUP_SUBAGENT_TOOL_NAME)!.run(
      { agent_id: "agent-2", task: "second task" },
      CTX,
    );
    const result = await transport.wait("agent-2");

    expect(result.summary).toBe("second task");
    expect(transport.get("agent-2")?.kind).toBe("explorer");
    await transport.dispose();
  });

  test("interrupt uses supervisor cancellation and returns a terminal status", async () => {
    const executor: AgentExecutor = {
      run: () => new Promise<AgentResult>(() => {}),
    };
    const { tools, transport } = toolsFor(executor, {
      idFactory: (() => {
        const values = ["agent-3", "task-3", "agent-session-3"];
        return () => values.shift()!;
      })(),
    });
    await tools.get(SPAWN_SUBAGENT_TOOL_NAME)!.run(
      { kind: "reviewer", task: "long review" },
      CTX,
    );
    await tools.get(INTERRUPT_SUBAGENT_TOOL_NAME)!.run({ agent_id: "agent-3" }, CTX);

    expect(transport.get("agent-3")?.status).toBe("aborted");
    await transport.dispose();
  });

  test("unknown, cross-parent, and writable worker targets fail closed", async () => {
    const executor: AgentExecutor = {
      run: async () => ({ agentId: "unused", status: "completed", summary: "ok", artifacts: [] }),
    };
    const { tools, transport } = toolsFor(executor);
    await expect(
      tools.get(SPAWN_SUBAGENT_TOOL_NAME)!.run({ kind: "worker", task: "write" }, CTX),
    ).rejects.toThrow(/kind/);

    await tools.get(SPAWN_SUBAGENT_TOOL_NAME)!.run(
      { kind: "reviewer", task: "review" },
      CTX,
    );
    const first = transport.list("main-1")[0]!;
    const otherTools = new Map(
      createAgentTools({
        transport,
        parent: parent("main-2"),
        cwd: CTX.cwd,
      }).map((tool) => [tool.name, tool]),
    );
    await expect(
      otherTools.get(GET_SUBAGENT_TOOL_NAME)!.run({ agent_id: first.id }, CTX),
    ).rejects.toThrow(/不属于当前 agent/);

    await transport.dispose();
  });

  test("agent tools require agent.spawn on the parent", () => {
    const transport = createInProcessTransport();
    expect(() =>
      createAgentTools({
        transport,
        parent: {
          agentId: "main-1",
          rootId: "main-1",
          sessionId: "session-main-1",
          authority: "workspace-write",
          capabilities: ["fs.read", "process.exec"],
        },
        cwd: CTX.cwd,
      }),
    ).toThrow(/agent.spawn/);
  });
});
