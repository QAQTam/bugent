import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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

  test("v2 数据库会自动补 workspace 与 reasoning 列", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bugent-store-migrate-"));
    dirs.push(dir);
    const path = join(dir, "v2.db");

    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model TEXT NOT NULL,
        provider_id TEXT,
        system_prompt TEXT NOT NULL,
        title TEXT,
        cwd TEXT,
        active_branch_id TEXT
      );
      CREATE TABLE messages (
        session_id TEXT NOT NULL,
        msgid INTEGER NOT NULL,
        parent_msgid INTEGER,
        role TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        tool_call_id TEXT,
        parts TEXT NOT NULL,
        tool_calls TEXT,
        PRIMARY KEY (session_id, msgid)
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        turn INTEGER,
        msgid INTEGER,
        payload TEXT NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '2');
    `);
    legacy.close();

    const upgraded = openDatabase({ path });
    const columns = upgraded.query("PRAGMA table_info(messages)").all() as { name: string }[];
    const sessionColumns = upgraded.query("PRAGMA table_info(sessions)").all() as { name: string }[];
    const tables = upgraded
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain("workspace");
    expect(columns.map((column) => column.name)).toContain("reasoning");
    expect(sessionColumns.map((column) => column.name)).toContain("sandbox_mode");
    expect(sessionColumns.map((column) => column.name)).toContain("provider_config");
    expect(tables.map((table) => table.name)).toContain("session_providers");
    expect(schemaVersion(upgraded)).toBe(SCHEMA_VERSION);
    upgraded.close();
  });

  test("v6 数据库会把 sessions.provider_config 回填到 session_providers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bugent-store-migrate-v6-"));
    dirs.push(dir);
    const path = join(dir, "v6.db");

    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        model TEXT NOT NULL,
        provider_id TEXT,
        system_prompt TEXT NOT NULL,
        title TEXT,
        cwd TEXT,
        active_branch_id TEXT,
        sandbox_mode TEXT,
        provider_config TEXT
      );
      INSERT INTO sessions
        (id, created_at, updated_at, model, provider_id, system_prompt, sandbox_mode, provider_config)
      VALUES
        ('s1', 1, 1, 'm', 'local', 'SYS', 'workspace-write',
         '{"id":"local","endpoint":"openai-chat","baseUrl":"http://127.0.0.1:8787/v1"}');
      INSERT INTO meta (key, value) VALUES ('schema_version', '6');
    `);
    legacy.close();

    const upgraded = openDatabase({ path });
    const row = upgraded
      .query("SELECT provider_id, config FROM session_providers WHERE session_id = 's1'")
      .get();
    expect(row).toEqual({
      provider_id: "local",
      config: JSON.stringify({
        id: "local",
        endpoint: "openai-chat",
        baseUrl: "http://127.0.0.1:8787/v1",
      }),
    });
    expect(schemaVersion(upgraded)).toBe(SCHEMA_VERSION);
    upgraded.close();
  });

  test("busy_timeout 被显式设置（并发写的前提）", async () => {
    const store = await makeStore();
    // 回归：曾把 busy_timeout 设在 journal_mode 之后，导致并发建库必然失败
    const row = store.db.query("PRAGMA busy_timeout").get() as { timeout: number } | null;
    expect(row?.timeout).toBe(5000);
  });

  test("默认数据库路径落在 ~/.bugent 下（与 config.toml 同目录）", () => {
    expect(defaultDatabasePath("/home/tester")).toBe("/home/tester/.bugent/sessions.db");
    expect(defaultDatabasePath("/home/tester/")).toBe("/home/tester/.bugent/sessions.db");
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

  test("session 级 sandbox_mode 可以持久化和更新", async () => {
    const store = await makeStore();
    store.createSession(makeSessionRecord("s1", { sandboxMode: "read-only" }));
    expect(store.getSession("s1")?.sandboxMode).toBe("read-only");

    store.setSandboxMode("s1", "no-sandbox");
    expect(store.getSession("s1")?.sandboxMode).toBe("no-sandbox");
  });

  test("session 级 provider profiles 持久化，并强制剔除 apiKey", async () => {
    const store = await makeStore();
    store.createSession(makeSessionRecord("s1"));
    store.setProviderConfig("s1", {
      id: "local",
      endpoint: "openai-chat",
      baseUrl: "http://127.0.0.1:8787/v1",
      headers: { "x-test": "1" },
      extraBody: { reasoning_effort: "high" },
      reasoningReplay: "both",
      proxy: false,
    });
    store.setProviderConfig("s1", {
      id: "backup",
      endpoint: "mock",
    });

    expect(store.getProviderConfig("s1", "local")).toEqual({
      id: "local",
      endpoint: "openai-chat",
      baseUrl: "http://127.0.0.1:8787/v1",
      headers: { "x-test": "1" },
      extraBody: { reasoning_effort: "high" },
      reasoningReplay: "both",
      proxy: false,
    });
    expect(store.listProviderConfigs("s1").map((config) => config.id)).toEqual(["backup", "local"]);

    store.deleteProviderConfig("s1", "backup");
    expect(store.listProviderConfigs("s1").map((config) => config.id)).toEqual(["local"]);

    store.setModelProvider("s1", "test-model", "local");
    expect(store.getSession("s1")?.providerConfig?.baseUrl).toBe("http://127.0.0.1:8787/v1");

    store.setProviderConfig("s1", {
      id: "local",
      endpoint: "openai-chat",
      apiKey: "must-not-persist",
    } as never);
    expect(store.getProviderConfig("s1", "local")).not.toHaveProperty("apiKey");
    expect(
      store.db
        .query("SELECT config FROM session_providers WHERE session_id = 's1' AND provider_id = 'local'")
        .get(),
    ).toEqual({
      config: JSON.stringify({ id: "local", endpoint: "openai-chat" }),
    });
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

    expect(restored.map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(restored.map((m) => m.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(restored[4]?.toolCalls).toEqual([{ id: "c1", name: "bash", args: { command: "ls" } }]);
    expect(restored[5]?.toolCallId).toBe("c1");
    expect(store.countMessages("s1")).toBe(6);
  });

  test("tool result 的工作区 patch 元数据可以落盘并恢复", async () => {
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

    session.appendAssistant("", [{ id: "c1", name: "edit_file", args: {} }]);
    session.appendToolResult("c1", "edited", [
      {
        path: "a.txt",
        before: "one\n",
        after: "two\n",
        beforeExists: true,
        afterExists: true,
      },
    ]);

    const restored = store.loadMessages("s1").at(-1);
    expect(restored?.workspace?.files).toHaveLength(1);
    expect(restored?.workspace?.files[0]).toMatchObject({
      path: "a.txt",
      beforeExists: true,
      afterExists: true,
      reversible: true,
    });
    expect(restored?.workspace?.files[0]?.reverse.ops.length).toBeGreaterThan(0);
  });

  test("assistant reasoning 可以落盘并恢复", async () => {
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

    session.appendAssistant("答案", undefined, "先想一下");

    const restored = store.loadMessages("s1").at(-1);
    expect(restored?.reasoning).toBe("先想一下");
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

    expect(restored.messages.map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4]);

    restored.appendUser("第二句");
    expect(restored.messages.map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(store.countMessages("s1")).toBe(6);
    expect(store.loadMessages("s1")[5]?.msgid).toBe(5);
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

  test("appendMessageAndTouch 原子更新消息与会话时间", async () => {
    const store = await makeStore();
    store.createSession(makeSessionRecord("s1"));

    store.appendMessageAndTouch(
      "s1",
      {
        msgid: 1,
        role: "user",
        origin: "user",
        parts: [{ type: "text", text: "hello" }],
        createdAt: 2222,
      },
      2222,
    );

    expect(store.countMessages("s1")).toBe(1);
    expect(store.loadMessages("s1")[0]?.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(store.getSession("s1")?.updatedAt).toBe(2222);
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
      mode: "workspace-write",
      at: 42,
    });
    audit.sessionConfig({
      action: "provider_model_mode",
      providerId: "local",
      model: "m",
      mode: "read-only",
    });
    audit.turnEnd({ steps: 2, reason: "stop" });

    const kinds = store.listEvents("s1").map((e) => e.kind);
    expect(kinds).toEqual([
      "turn_start",
      "tool_call",
      "tool_result",
      "permission",
      "session_config",
      "turn_end",
    ]);

    const permission = store.listEvents("s1").find((e) => e.kind === "permission");
    expect(permission?.payload).toMatchObject({ tool: "bash", decision: "ask", allowed: true });
    const config = store.listEvents("s1").find((e) => e.kind === "session_config");
    expect(config?.payload).toMatchObject({ providerId: "local", model: "m", mode: "read-only" });
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
      new PermissionGate({
        policy: new PermissionPolicy({ default: "ask" }),
        mode: "workspace-write",
        prompter,
        onDecision: (d) => audit.permission(d),
      }),
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
