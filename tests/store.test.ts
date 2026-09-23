import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/core/session.ts";
import { runUserTurn } from "../src/core/loop.ts";
import { PermissionGate } from "../src/permission/gate.ts";
import { PermissionPolicy } from "../src/permission/policy.ts";
import { ScriptedPrompter } from "../src/permission/prompt.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import { createBashTool, createShellRunner } from "../src/tools/bash.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import { AuditTrail } from "../src/store/audit.ts";
import { defaultDatabasePath, SessionStore } from "../src/store/repository.ts";
import { openDatabase, schemaVersion, SCHEMA_VERSION } from "../src/store/db.ts";

const stores: SessionStore[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // 已关闭则忽略
    }
  }
  stores.length = 0;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function makeStore(): Promise<SessionStore> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-store-"));
  dirs.push(dir);
  const store = new SessionStore({ path: join(dir, "bugent.db") });
  stores.push(store);
  return store;
}

function makeSessionRecord(id: string, overrides: Partial<Parameters<SessionStore["createSession"]>[0]> = {}) {
  return {
    id,
    createdAt: 1000,
    updatedAt: 1000,
    model: "test-model",
    providerId: "test",
    systemPrompt: "SYS",
    cwd: "/tmp",
    ...overrides,
  };
}

describe("P10 · 数据库", () => {
  test("schema 被创建且版本号写入", async () => {
    const store = await makeStore();
    expect(schemaVersion(store.db)).toBe(SCHEMA_VERSION);
  });

  test("重复打开同一文件是幂等的（IF NOT EXISTS）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bugent-store-"));
    dirs.push(dir);
    const path = join(dir, "bugent.db");

    const first = openDatabase({ path });
    first.close();
    const second = openDatabase({ path });
    expect(schemaVersion(second)).toBe(SCHEMA_VERSION);
    second.close();
  });

  test("busy_timeout 被显式设置（并发写的前提）", async () => {
    const store = await makeStore();
    // 回归：曾把 busy_timeout 设在 journal_mode 之后，导致并发建库必然失败
    const row = store.db.query("PRAGMA busy_timeout").get() as { timeout: number } | null;
    expect(row?.timeout).toBe(5000);
  });

  test("默认数据库路径落在项目内的 .bugent 下", () => {
    expect(defaultDatabasePath("/work/proj")).toBe("/work/proj/.bugent/bugent.db");
    expect(defaultDatabasePath("/work/proj/")).toBe("/work/proj/.bugent/bugent.db");
  });
});

describe("P10 · 会话与消息持久化", () => {
  test("会话可以创建、查询、列出", async () => {
    const store = await makeStore();
    store.createSession(makeSessionRecord("s1"));
    store.createSession(makeSessionRecord("s2", { updatedAt: 2000 }));

    expect(store.hasSession("s1")).toBe(true);
    expect(store.getSession("s1")?.model).toBe("test-model");
    expect(store.listSessions().map((s) => s.id)).toEqual(["s2", "s1"]); // 按 updatedAt 倒序
  });

  test("消息按 msgid 顺序读回，且内容完整", async () => {
    const store = await makeStore();
    store.createSession(makeSessionRecord("s1"));

    const session = new AgentSession({
      id: "s1",
      system: "SYS",
      client: createMockClient({ script: [] }),
      model: "test-model",
      now: () => 500,
      onMessage: (message) => store.appendMessage("s1", message),
    });

    session.appendUser("你好");
    session.appendAssistant("回复", [{ id: "c1", name: "bash", args: { command: "ls" } }]);
    session.appendToolResult("c1", "a.txt");

    const restored = store.loadMessages("s1");

    expect(restored.map((m) => m.msgid)).toEqual([0, 1, 2, 3]);
    expect(restored.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(restored[2]?.toolCalls).toEqual([{ id: "c1", name: "bash", args: { command: "ls" } }]);
    expect(restored[3]?.toolCallId).toBe("c1");
    expect(store.countMessages("s1")).toBe(4);
  });

  test("恢复后的 session 能继续追加，且 msgid 从历史最大值接着走", async () => {
    const store = await makeStore();
    store.createSession(makeSessionRecord("s1"));

    const first = new AgentSession({
      id: "s1",
      system: "SYS",
      client: createMockClient({ script: [] }),
      model: "test-model",
      now: () => 1,
      onMessage: (m) => store.appendMessage("s1", m),
    });
    first.appendUser("第一句");
    first.appendAssistant("第一次回复");

    // 模拟重启
    const restored = new AgentSession({
      id: "s1",
      system: "SYS",
      client: createMockClient({ script: [] }),
      model: "test-model",
      now: () => 2,
      restore: store.loadMessages("s1"),
      onMessage: (m) => store.appendMessage("s1", m),
    });

    expect(restored.messages.map((m) => m.msgid)).toEqual([0, 1, 2]);

    restored.appendUser("第二句");
    expect(restored.messages.map((m) => m.msgid)).toEqual([0, 1, 2, 3]);
    expect(store.countMessages("s1")).toBe(4);
    expect(store.loadMessages("s1")[3]?.msgid).toBe(3);
  });

  test("恢复的消息仍然是冻结的（只追加铁律不被破坏）", async () => {
    const store = await makeStore();
    store.createSession(makeSessionRecord("s1"));
    store.appendMessage("s1", {
      msgid: 0,
      role: "system",
      origin: "system",
      parts: [{ type: "text", text: "SYS" }],
      createdAt: 0,
    });

    const [message] = store.loadMessages("s1");
    expect(Object.isFrozen(message!)).toBe(true);
    expect(Object.isFrozen(message!.parts)).toBe(true);
  });

  test("删除会话会级联删除消息与事件", async () => {
    const store = await makeStore();
    store.createSession(makeSessionRecord("s1"));
    store.appendMessage("s1", {
      msgid: 0,
      role: "system",
      origin: "system",
      parts: [{ type: "text", text: "SYS" }],
      createdAt: 0,
    });
    store.appendEvent({ sessionId: "s1", at: 1, kind: "turn_start", payload: {} });

    store.db.exec("DELETE FROM sessions WHERE id = 's1'");

    expect(store.countMessages("s1")).toBe(0);
    expect(store.listEvents("s1")).toHaveLength(0);
  });
});

describe("P10 · 审计流水", () => {
  test("事件按时间顺序读回，payload 保留结构", async () => {
    const store = await makeStore();
    store.createSession(makeSessionRecord("s1"));

    store.appendEvent({ sessionId: "s1", at: 1, kind: "turn_start", payload: { turn: 1 } });
    store.appendEvent({
      sessionId: "s1",
      at: 2,
      kind: "tool_call",
      turn: 1,
      payload: { name: "bash", args: { command: "ls" } },
    });

    const events = store.listEvents("s1");

    expect(events.map((e) => e.kind)).toEqual(["turn_start", "tool_call"]);
    expect(events[1]?.payload).toEqual({ name: "bash", args: { command: "ls" } });
    expect(events[1]?.turn).toBe(1);
  });

  test("AuditTrail 记录工具调用、结果与权限决策", async () => {
    const store = await makeStore();
    store.createSession(makeSessionRecord("s1"));

    let turn = 0;
    const audit = new AuditTrail({
      store,
      sessionId: () => "s1",
      turn: () => turn,
      now: () => 42,
    });

    audit.turnStart();
    turn = 1;
    audit.hooks().onToolCall?.({ id: "c1", name: "bash", args: { command: "ls" } });
    audit.hooks().onToolResult?.({ id: "c1", name: "bash", args: {} }, { ok: true, output: "a.txt" });
    audit.permission({
      request: { tool: "bash", resource: "ls", summary: "执行命令：ls" },
      decision: "ask",
      allowed: true,
      at: 42,
    });
    audit.turnEnd({ steps: 2, reason: "stop" });

    const kinds = store.listEvents("s1").map((e) => e.kind);
    expect(kinds).toEqual(["turn_start", "tool_call", "tool_result", "permission", "turn_end"]);

    const permission = store.listEvents("s1").find((e) => e.kind === "permission");
    expect(permission?.payload).toMatchObject({ tool: "bash", decision: "ask", allowed: true });
  });

  test("端到端：跑一轮后审计流水里能看到工具调用与权限决策", async () => {
    const store = await makeStore();
    store.createSession(makeSessionRecord("s1"));

    const session = new AgentSession({
      id: "s1",
      system: "SYS",
      client: createMockClient({
        script: [
          { toolCalls: [{ id: "c1", name: "bash", args: { command: "echo audited" } }] },
          { text: "done" },
        ],
      }),
      model: "test-model",
      onMessage: (m) => store.appendMessage("s1", m),
    });

    const audit = new AuditTrail({
      store,
      sessionId: () => session.id,
      turn: () => session.turn,
    });

    const registry = new ToolRegistry().register(createBashTool(createShellRunner()));
    const prompter = new ScriptedPrompter([true]);
    registry.setGate(
      new PermissionGate(new PermissionPolicy({ default: "ask" }), prompter, (d) =>
        audit.permission(d),
      ),
    );

    await runUserTurn(session, "跑一下", {
      tools: registry,
      hooks: audit.hooks(),
      cwd: process.cwd(),
    });

    const events = store.listEvents("s1");
    const kinds = events.map((e) => e.kind);

    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("permission");

    const toolResult = events.find((e) => e.kind === "tool_result");
    expect((toolResult?.payload as { output: string }).output).toContain("audited");
  });
});
