import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatChunk, ToolCall } from "../src/provider/types.ts";
import { createMockClient, type MockTurn } from "../src/provider/adapters/mock.ts";
import type { AgentKind } from "../src/agent/model.ts";
import { createReadOnlyAgentExecutor } from "../src/agent/read-only-executor.ts";
import { compileAgentSandboxSpec } from "../src/agent/sandbox.ts";
import type { AgentSpec } from "../src/agent/supervisor.ts";
import { createInProcessTransport } from "../src/agent/transport.ts";

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-readonly-agent-"));
  dirs.push(dir);
  await writeFile(join(dir, "README.md"), "# fixture\n", "utf8");
  return dir;
}

function toolCallChunks(call: ToolCall): ChatChunk[] {
  return [
    { type: "tool_call", id: call.id, name: call.name, argsDelta: "" },
    { type: "tool_call", id: call.id, name: call.name, argsDelta: JSON.stringify(call.args) },
    { type: "usage", usage: { input: 1, output: 1 } },
    { type: "done", reason: "tool_calls" },
  ];
}

function spec(agentId: string, kind: AgentKind, root: string): AgentSpec {
  const taskId = `task-${agentId}`;
  return {
    identity: {
      agentId,
      rootId: agentId,
      kind,
      sessionId: `session-${agentId}`,
      taskId,
      createdAt: 1,
    },
    task: {
      id: taskId,
      title: "inspect fixture",
      instructions: "Read README.md and report the heading.",
    },
    budget: {
      maxTurns: 10,
      maxToolCalls: 20,
      maxInputTokens: 20_000,
      maxOutputTokens: 5_000,
      maxWallClockMs: 60_000,
    },
    sandbox: compileAgentSandboxSpec(
      {
        agentId,
        kind,
        ...(kind === "explorer"
          ? { capabilities: ["fs.read"] as const, workspace: { root, access: "read" as const } }
          : { workspace: { root } }),
      },
      "linux",
    ),
  };
}

describe("P7-D · read-only reviewer/explorer executor", () => {
  test("reviewer runs in a fresh session with read-only tools and receives tool results", async () => {
    const cwd = await tempWorkspace();
    let toolNames: string[] = [];
    let sawToolResult = false;
    const script: MockTurn[] = [
      (request) => {
        toolNames = request.tools?.map((tool) => tool.name) ?? [];
        return toolCallChunks({
          id: "read-1",
          name: "read_file",
          args: { path: "README.md" },
        });
      },
      (request) => {
        sawToolResult = request.messages.some(
          (message) => message.role === "tool" && message.toolCallId === "read-1",
        );
        return [
          { type: "text", delta: "README heading: fixture" },
          { type: "usage", usage: { input: 2, output: 2 } },
          { type: "done", reason: "stop" },
        ];
      },
    ];
    const transport = createInProcessTransport({
      executor: createReadOnlyAgentExecutor({
        client: createMockClient({ script }),
        model: "mock-model",
      }),
    });

    const handle = await transport.start(spec("reviewer-1", "reviewer", cwd));
    const result = await transport.wait(handle);

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("README heading");
    expect((result.data as { text?: string } | undefined)?.text).toBe("README heading: fixture");
    expect(toolNames).toContain("read_file");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("edit_file");
    expect(sawToolResult).toBe(true);
    await transport.dispose();
  });

  test("explorer without process.exec only receives fs.read tools", async () => {
    const cwd = await tempWorkspace();
    let toolNames: string[] = [];
    const script: MockTurn[] = [
      (request) => {
        toolNames = request.tools?.map((tool) => tool.name) ?? [];
        return [
          { type: "text", delta: "read-only exploration complete" },
          { type: "done", reason: "stop" },
        ];
      },
    ];
    const transport = createInProcessTransport({
      executor: createReadOnlyAgentExecutor({
        client: createMockClient({ script }),
        model: "mock-model",
      }),
    });

    const result = await transport.wait(
      await transport.start(spec("explorer-1", "explorer", cwd)),
    );

    expect(result.status).toBe("completed");
    expect(toolNames).toEqual(["read_file"]);
    await transport.dispose();
  });

  test("a writable worker cannot use the read-only executor", async () => {
    const cwd = await tempWorkspace();
    const transport = createInProcessTransport({
      executor: createReadOnlyAgentExecutor({
        client: createMockClient({ script: [{ text: "should not run" }] }),
        model: "mock-model",
      }),
    });

    const result = await transport.wait(
      await transport.start(spec("worker-1", "worker", cwd)),
    );

    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/只支持 reviewer\/explorer/);
    await transport.dispose();
  });
});
