import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../src/core/open-session.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import { mainBranchId, SessionStore } from "../src/store/repository.ts";
import { schemaVersion, SCHEMA_VERSION } from "../src/store/db.ts";
import { newSessionId } from "../src/util/id.ts";

const stores: SessionStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const store of stores) store.close();
  stores.length = 0;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function makeStore(): SessionStore {
  const store = new SessionStore({ path: ":memory:" });
  stores.push(store);
  return store;
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

describe("分支式 msgid", () => {
  test("新 session 自动创建 main 分支", () => {
    const store = makeStore();
    const sessionId = newSessionId();
    const session = open(store, sessionId);

    expect(session.branchId).toBe(mainBranchId(sessionId));
    expect(store.getSession(sessionId)?.activeBranchId).toBe(mainBranchId(sessionId));
    expect(store.listBranches(sessionId)).toHaveLength(1);
    expect(store.listBranches(sessionId)[0]?.headMsgid).toBe(0);
    expect(store.loadBranchPath(sessionId, mainBranchId(sessionId)).map((m) => m.msgid)).toEqual([0]);
  });

  test("fork 后新分支继续使用 session 全局递增 msgid", () => {
    const store = makeStore();
    const sessionId = newSessionId();
    const first = open(store, sessionId);
    first.appendUser("u1");
    first.appendAssistant("a1");

    const fork = store.createBranch(sessionId, 2, {
      ...(first.branchId !== undefined ? { parentBranchId: first.branchId } : {}),
      title: "fork",
    });
    store.setActiveBranch(sessionId, fork);

    const second = open(store, sessionId);
    expect(second.branchId).toBe(fork);
    expect(second.messages.map((m) => m.msgid)).toEqual([0, 1, 2]);

    second.appendUser("u2-fork");
    second.appendAssistant("a2-fork");

    expect(second.messages.map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4]);
    expect(second.messages[3]?.parentMsgId).toBe(2);
    expect(store.loadBranchPath(sessionId, mainBranchId(sessionId)).map((m) => m.msgid)).toEqual([
      0, 1, 2,
    ]);
    expect(store.loadBranchPath(sessionId, fork).map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4]);
    expect(store.loadMessages(sessionId).map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4]);
  });

  test("从旧节点 fork 时，新分支 parent 指向 fork 点而不是旧 head", () => {
    const store = makeStore();
    const sessionId = newSessionId();
    const first = open(store, sessionId);
    first.appendUser("u1");
    first.appendAssistant("a1");
    first.appendUser("u2");

    const fork = store.createBranch(sessionId, 1, {
      ...(first.branchId !== undefined ? { parentBranchId: first.branchId } : {}),
    });
    store.setActiveBranch(sessionId, fork);

    const second = open(store, sessionId);
    second.appendAssistant("a1-fork");

    expect(second.messages.map((m) => m.msgid)).toEqual([0, 1, 4]);
    expect(second.messages[2]?.parentMsgId).toBe(1);
    expect(store.loadBranchPath(sessionId, mainBranchId(sessionId)).map((m) => m.msgid)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  test("v1 线性历史自动迁移为 main 分支", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bugent-branch-migrate-"));
    dirs.push(dir);
    const path = join(dir, "legacy.db");

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
        cwd TEXT
      );
      CREATE TABLE messages (
        session_id TEXT NOT NULL,
        msgid INTEGER NOT NULL,
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
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
      INSERT INTO sessions
        (id, created_at, updated_at, model, provider_id, system_prompt, title, cwd)
        VALUES ('legacy', 1, 2, 'm', 'p', 'SYS', NULL, '/tmp');
      INSERT INTO messages
        (session_id, msgid, role, origin, created_at, tool_call_id, parts, tool_calls)
        VALUES
          ('legacy', 0, 'system', 'system', 1, NULL, '[{"type":"text","text":"SYS"}]', NULL),
          ('legacy', 1, 'user', 'user', 2, NULL, '[{"type":"text","text":"hello"}]', NULL);
    `);
    legacy.close();

    const store = new SessionStore({ path });
    stores.push(store);
    expect(schemaVersion(store.db)).toBe(SCHEMA_VERSION);
    expect(store.getSession("legacy")?.activeBranchId).toBe("legacy:main");
    expect(store.loadBranchPath("legacy", "legacy:main").map((m) => m.msgid)).toEqual([0, 1]);
    expect(store.loadBranchPath("legacy", "legacy:main")[1]?.parentMsgId).toBe(0);
  });
});
