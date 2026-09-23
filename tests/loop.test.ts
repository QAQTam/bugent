import { describe, expect, test } from "bun:test";
import { AgentSession } from "../src/core/session.ts";
import { runTurn, runUserTurn } from "../src/core/loop.ts";
import { ProviderRegistry } from "../src/provider/registry.ts";
import { createMockClient, type MockTurn } from "../src/provider/adapters/mock.ts";
import { ToolRegistry, type Tool } from "../src/tools/types.ts";
import { storedText } from "../src/core/message.ts";
import type { ChatChunk } from "../src/provider/types.ts";

function echoTool(sink: string[]): Tool<{ text: string }> {
  return {
    name: "echo",
    description: "回显给定文本",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
    },
    async run(input) {
      sink.push(input.text);
      return `echo:${input.text}`;
    },
  };
}

function newSession(script: MockTurn[]): AgentSession {
  return new AgentSession({
    id: "loop-test",
    system: "SYS",
    client: createMockClient({ script }),
    model: "test-model",
    now: () => 0,
  });
}

describe("P4 · agent loop", () => {
  test("模型要求调用工具时，loop 执行工具并把结果喂回去", async () => {
    const seen: string[] = [];
    const session = newSession([
      { text: "我来调用工具", toolCalls: [{ id: "c1", name: "echo", args: { text: "hi" } }] },
      { text: "完成" },
    ]);
    session.appendUser("跑一下");

    const result = await runTurn(session, {
      tools: new ToolRegistry().register(echoTool(seen)),
      cwd: "/tmp",
    });

    expect(seen).toEqual(["hi"]);
    expect(result.text).toBe("完成");
    expect(result.steps).toBe(2);
    expect(result.reason).toBe("stop");

    expect(session.messages.map((m) => `${m.msgid}:${m.role}`)).toEqual([
      "0:system",
      "1:user",
      "2:assistant",
      "3:tool",
      "4:assistant",
    ]);
    const toolMessage = session.messages[3];
    expect(toolMessage?.toolCallId).toBe("c1");
    expect(storedText(toolMessage!)).toBe("echo:hi");
  });

  test("未知工具不会让 loop 崩溃，而是把错误喂回模型", async () => {
    const session = newSession([
      { toolCalls: [{ id: "c1", name: "not_exist", args: {} }] },
      { text: "我换个方式" },
    ]);
    session.appendUser("跑一下");

    const result = await runTurn(session, { tools: new ToolRegistry(), cwd: "/tmp" });

    expect(result.steps).toBe(2);
    const toolMessage = session.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(storedText(toolMessage!)).toContain("未知工具");
  });

  test("工具抛异常时被转成错误文本，不会炸穿 loop", async () => {
    const boom: Tool = {
      name: "boom",
      description: "总是抛错",
      parameters: { type: "object", properties: {} },
      async run() {
        throw new Error("炸了");
      },
    };

    const session = newSession([{ toolCalls: [{ id: "c1", name: "boom", args: {} }] }, { text: "知道了" }]);
    session.appendUser("跑一下");

    const result = await runTurn(session, { tools: new ToolRegistry().register(boom), cwd: "/tmp" });

    expect(result.text).toBe("知道了");
    const toolMessage = session.messages.find((m) => m.role === "tool");
    expect(storedText(toolMessage!)).toBe("Error: 炸了");
  });

  test("没有注册工具时，明确告知模型而不是空转", async () => {
    const session = newSession([{ toolCalls: [{ id: "c1", name: "echo", args: {} }] }]);
    session.appendUser("跑一下");

    const result = await runTurn(session, { cwd: "/tmp" });

    expect(result.toolCalls).toHaveLength(1);
    const toolMessage = session.messages.find((m) => m.role === "tool");
    expect(storedText(toolMessage!)).toContain("没有注册任何工具");
  });

  test("maxSteps 能拦住工具调用死循环", async () => {
    const loopTurn = (): ChatChunk[] => [
      { type: "tool_call", id: "c1", name: "echo", argsDelta: '{"text":"x"}' },
      { type: "done", reason: "tool_calls" },
    ];
    const script: MockTurn[] = Array.from({ length: 5 }, () => ({ chunks: loopTurn() }));

    const session = newSession(script);
    session.appendUser("跑一下");

    await expect(
      runTurn(session, { tools: new ToolRegistry().register(echoTool([])), cwd: "/tmp", maxSteps: 3 }),
    ).rejects.toThrow(/死循环/);
  });

  test("多步工具调用：每一步都追加消息，前缀只增不改", async () => {
    const seen: string[] = [];
    const session = newSession([
      { toolCalls: [{ id: "c1", name: "echo", args: { text: "one" } }] },
      { toolCalls: [{ id: "c2", name: "echo", args: { text: "two" } }] },
      { text: "都做完了" },
    ]);
    session.appendUser("跑两下");

    const result = await runTurn(session, {
      tools: new ToolRegistry().register(echoTool(seen)),
      cwd: "/tmp",
    });

    expect(seen).toEqual(["one", "two"]);
    expect(result.steps).toBe(3);
    expect(session.messages.map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("P4 · runUserTurn 契约", () => {
  test("runUserTurn 负责把用户消息写进 session", async () => {
    const session = newSession([{ text: "ok" }]);

    await runUserTurn(session, "你好", { cwd: "/tmp" });

    expect(session.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(storedText(session.messages[1]!)).toBe("你好");
  });

  test("回归：模型必须能读到用户输入（TUI 曾因漏写 session 只回显空串）", async () => {
    const registry = new ProviderRegistry().register({ id: "mock", endpoint: "mock" });
    const client = registry.resolve({ provider: "mock", model: "echo" });
    const session = new AgentSession({ id: "regression", system: "SYS", client, model: "echo" });

    const result = await runUserTurn(session, "你好 bugent", { cwd: "/tmp" });

    expect(result.text).toContain("你好 bugent");
  });
});
