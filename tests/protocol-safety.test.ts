import { afterEach, describe, expect, test } from "bun:test";
import { BranchService } from "../src/core/branch-service.ts";
import { runTurn } from "../src/core/loop.ts";
import { storedText } from "../src/core/message.ts";
import { openSession } from "../src/core/open-session.ts";
import { AgentSession } from "../src/core/session.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import { SessionStore } from "../src/store/repository.ts";
import { ToolRegistry, type Tool } from "../src/tools/types.ts";
import { newSessionId } from "../src/util/id.ts";

const stores: SessionStore[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});

function makeStore(): SessionStore {
  const store = new SessionStore({ path: ":memory:" });
  stores.push(store);
  return store;
}

function makeSession(script: Parameters<typeof createMockClient>[0]["script"] = []): AgentSession {
  return new AgentSession({
    id: "protocol-safety",
    system: "SYS",
    client: createMockClient({ script }),
    model: "test-model",
    now: () => 1,
  });
}

function open(store: SessionStore, sessionId: string) {
  return openSession({
    store,
    sessionId,
    client: createMockClient({ script: [] }),
    model: "test-model",
    providerId: "test",
    systemPrompt: "SYS",
    cwd: "/tmp",
  });
}

function tool(
  name: string,
  run: Tool<Record<string, never>, string>["run"],
): Tool<Record<string, never>, string> {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    describe: () => ({ resource: name, summary: name }),
    run,
  };
}

describe("P4 · tool batch 协议安全", () => {
  test("多个 tool result 最终严格按 assistant tool_calls 顺序落库", () => {
    const session = makeSession();
    session.appendUser("跑三个工具");
    session.appendAssistant("", [
      { id: "c1", name: "one", args: {} },
      { id: "c2", name: "two", args: {} },
      { id: "c3", name: "three", args: {} },
    ]);

    expect(session.appendToolResult("c3", "tr3")).toBeUndefined();
    expect(session.appendToolResult("c2", "tr2")).toBeUndefined();
    expect(storedText(session.appendToolResult("c1", "tr1")!)).toBe("tr1");

    const tools = session.messages.filter((message) => message.role === "tool");
    expect(tools.map((message) => message.toolCallId)).toEqual(["c1", "c2", "c3"]);
    expect(tools.map(storedText)).toEqual(["tr1", "tr2", "tr3"]);
    expect(tools.map((message) => message.msgid)).toEqual([5, 6, 7]);
    expect(session.hasOpenToolBatch()).toBe(false);
  });

  test("batch 内提交 user / injection 不会插入 tool call 与 tool result 之间", async () => {
    const session = makeSession([
      { toolCalls: [{ id: "c1", name: "queue", args: {} }] },
      { text: "完成" },
    ]);
    session.appendUser("开始");

    const queueTool = tool("queue", async () => {
      session.submitUser("排队用户");
      session.enqueueInjection("排队注入", "skill");
      return "tool-ok";
    });

    const result = await runTurn(session, {
      tools: new ToolRegistry().register(queueTool),
      cwd: "/tmp",
    });

    expect(result.text).toBe("完成");
    expect(session.messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
      "assistant",
      "tool",
      "system",
      "assistant",
    ]);
    expect(session.messages[5]?.toolCallId).toBe("c1");
    expect(session.messages[6]?.origin).toBe("inject");
    expect(storedText(session.messages[6]!)).toBe("排队注入");
    expect(session.queuedUserCount).toBe(1);
    expect(session.dequeueUserAfterTurn()).toBe("排队用户");
  });

  test("open batch 中 appendUser 直接失败，submitUser 只排队", () => {
    const session = makeSession();
    session.appendAssistant("", [{ id: "c1", name: "one", args: {} }]);

    expect(() => session.appendUser("插队")).toThrow(/tool batch is open/);
    expect(session.submitUser("排队")).toEqual({ status: "queued", position: 1 });
    expect(session.messages.some((message) => storedText(message) === "插队")).toBe(false);
    expect(session.queuedUserCount).toBe(1);
  });

  test("abort 后按原 tool_calls 顺序补齐 synthetic tool results", async () => {
    const controller = new AbortController();
    const session = makeSession([
      {
        toolCalls: [
          { id: "c1", name: "abort", args: {} },
          { id: "c2", name: "never", args: {} },
          { id: "c3", name: "never", args: {} },
        ],
      },
    ]);
    session.appendUser("中断");

    const abortTool = tool("abort", async () => {
      controller.abort();
      return "tr1";
    });
    let neverRuns = 0;
    const neverTool = tool("never", async () => {
      neverRuns += 1;
      throw new Error("不应执行");
    });

    const result = await runTurn(session, {
      tools: new ToolRegistry().register(abortTool).register(neverTool),
      cwd: "/tmp",
      signal: controller.signal,
    });

    expect(result.reason).toBe("error");
    expect(neverRuns).toBe(0);
    const tools = session.messages.filter((message) => message.role === "tool");
    expect(tools.map((message) => message.toolCallId)).toEqual(["c1", "c2", "c3"]);
    expect(storedText(tools[0]!)).toBe("tr1");
    expect(storedText(tools[1]!)).toMatch(/取消|missing due abort/);
    expect(storedText(tools[2]!)).toMatch(/取消|missing due abort/);
    expect(session.hasOpenToolBatch()).toBe(false);
  });
});

describe("P4 · crash recovery 与 retry", () => {
  test("恢复历史时修复尾部孤立的 tool calls", () => {
    const store = makeStore();
    const sessionId = newSessionId();
    const first = open(store, sessionId);
    first.appendUser("跑三个工具");
    first.appendAssistant("", [
      { id: "c1", name: "one", args: {} },
      { id: "c2", name: "two", args: {} },
      { id: "c3", name: "three", args: {} },
    ]);
    first.appendToolResult("c1", "tr1");

    const restored = open(store, sessionId);

    const tools = restored.messages.filter((message) => message.role === "tool");
    expect(tools.map((message) => message.toolCallId)).toEqual(["c1", "c2", "c3"]);
    expect(storedText(tools[0]!)).toBe("tr1");
    expect(storedText(tools[1]!)).toContain("interrupted session");
    expect(storedText(tools[2]!)).toContain("interrupted session");
    expect(
      store
        .loadBranchPath(sessionId, restored.branchId!)
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["c1", "c2", "c3"]);
  });

  test("retry 创建新分支，原分支不变，新分支只追加一次原 user message", () => {
    const store = makeStore();
    const sessionId = newSessionId();
    const first = open(store, sessionId);
    first.appendUser("u1");
    first.appendAssistant("a1");
    first.appendUser("u2");
    first.appendAssistant("a2");
    const oldBranchId = first.branchId!;

    const service = new BranchService(store);
    const plan = service.retryFrom(sessionId, 6);
    const retried = open(store, sessionId);
    retried.appendUser(plan.input);

    const newPath = store.loadBranchPath(sessionId, retried.branchId!);
    expect(newPath.filter((message) => message.origin === "user").map(storedText)).toEqual([
      "u1",
      "u2",
    ]);
    expect(store.loadBranchPath(sessionId, oldBranchId).map(storedText)).toEqual([
      "SYS",
      "# MCP servers\n\n(none)",
      "# Skills\n\n(none)",
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
  });
});
