import { describe, expect, test } from "bun:test";
import type { AgentResult } from "../src/agent/model.ts";
import { compileAgentSandboxSpec } from "../src/agent/sandbox.ts";
import type { AgentExecutor, AgentSpec } from "../src/agent/supervisor.ts";
import { createInProcessTransport } from "../src/agent/transport.ts";

function spec(agentId: string): AgentSpec {
  const taskId = `task-${agentId}`;
  return {
    identity: {
      agentId,
      rootId: agentId,
      kind: "reviewer",
      sessionId: `session-${agentId}`,
      taskId,
      createdAt: 1,
    },
    task: { id: taskId, title: "review", instructions: "review it" },
    budget: {
      maxTurns: 5,
      maxToolCalls: 10,
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      maxWallClockMs: 1000,
    },
    sandbox: compileAgentSandboxSpec(
      { agentId, kind: "reviewer", workspace: { root: "/tmp/bugent-transport" } },
      "linux",
    ),
  };
}

describe("P7-C · InProcessTransport", () => {
  test("routes start/send/wait/subscribe/cancel through the supervisor", async () => {
    const seen: string[] = [];
    const executor: AgentExecutor = {
      async run(context) {
        const message = await context.receive();
        return {
          agentId: context.spec.identity.agentId,
          status: "completed",
          summary: String(message?.payload),
          artifacts: [],
        };
      },
    };
    const transport = createInProcessTransport({ executor });
    const handle = await transport.start(spec("reviewer-1"));
    const unsubscribe = transport.subscribe(handle, (event) => {
      seen.push(event.type);
    });

    await transport.send(handle, { type: "task.assigned", payload: "look" });
    const result = await transport.wait(handle);
    unsubscribe();

    expect(result.summary).toBe("look");
    expect(transport.supervisor.events.list(handle.id)[0]?.type).toBe("agent.started");
    expect(seen).toContain("agent.message");
    expect(seen).toContain("agent.completed");
    expect(transport.get("reviewer-1")).toBe(handle);
    expect(transport.list()).toHaveLength(1);
    await transport.dispose();
  });

  test("close is an idempotent cancellation boundary", async () => {
    let signal: AbortSignal | undefined;
    const executor: AgentExecutor = {
      run(context) {
        signal = context.signal;
        return new Promise<AgentResult>(() => {});
      },
    };
    const transport = createInProcessTransport({ executor });
    const handle = await transport.start(spec("reviewer-1"));

    await transport.close(handle, "not needed");
    await transport.close(handle, "again");

    expect(signal?.aborted).toBe(true);
    expect(handle.status).toBe("aborted");
    expect((await transport.wait("reviewer-1")).summary).toBe("not needed");
    await transport.dispose();
  });
});
