import { afterEach, describe, expect, test } from "bun:test";
import { createSessionRuntime, type SessionInteraction } from "../src/core/runtime.ts";
import { PermissionPolicy } from "../src/permission/policy.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import { SessionStore } from "../src/store/repository.ts";
import { currentTodoList } from "../src/tools/todo.ts";
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

const interaction: SessionInteraction = {
  askPermission: async () => true,
  confirmModeChange: async () => true,
};

function makeRuntime(store: SessionStore, mode: "read-only" | "workspace-write" | "no-sandbox") {
  return createSessionRuntime({
    sessionId: newSessionId(),
    client: createMockClient({ script: [] }),
    model: "test-model",
    providerId: "test",
    systemPrompt: "SYS",
    cwd: "/tmp",
    store,
    mode,
    policy: new PermissionPolicy({ default: "allow" }),
    interaction,
  });
}

describe("SessionRuntime 隔离", () => {
  test("每个 session 有独立 UUID、tools、gate、sandbox 和 audit", () => {
    const store = makeStore();
    const a = makeRuntime(store, "read-only");
    const b = makeRuntime(store, "workspace-write");

    expect(a.id).not.toBe(b.id);
    expect(a.id).toHaveLength(36);
    expect(a.tools).not.toBe(b.tools);
    expect(a.gate).not.toBe(b.gate);
    expect(a.sandboxNote).toContain("只读");
    expect(b.sandboxNote).toContain("可写");
    expect(a.sandboxNote).not.toBe(b.sandboxNote);

    a.gate.setMode("no-sandbox");
    expect(a.gate.mode).toBe("no-sandbox");
    expect(a.mode).toBe("no-sandbox");
    expect(b.gate.mode).toBe("workspace-write");
    expect(b.mode).toBe("workspace-write");
  });

  test("messages、events 和 todo 不会跨 session 溢出", () => {
    const store = makeStore();
    const a = makeRuntime(store, "workspace-write");
    const b = makeRuntime(store, "workspace-write");

    a.session.appendUser("A-user");
    b.session.appendUser("B-user");
    a.session.appendAssistant("", [
      { id: "todo-a", name: "todo_write", args: { todos: [{ content: "A-todo", status: "pending" }] } },
    ]);
    b.session.appendAssistant("", [
      { id: "todo-b", name: "todo_write", args: { todos: [{ content: "B-todo", status: "pending" }] } },
    ]);

    expect(store.loadMessages(a.id).map((m) => m.parts[0]?.type === "text" && m.parts[0].text)).toContain(
      "A-user",
    );
    expect(store.loadMessages(b.id).map((m) => m.parts[0]?.type === "text" && m.parts[0].text)).toContain(
      "B-user",
    );
    expect(currentTodoList(a.session.messages).todos[0]?.content).toBe("A-todo");
    expect(currentTodoList(b.session.messages).todos[0]?.content).toBe("B-todo");

    a.audit!.turnStart();
    b.audit!.turnStart();
    expect(store.listEvents(a.id).map((e) => e.kind)).toEqual(["turn_start"]);
    expect(store.listEvents(b.id).map((e) => e.kind)).toEqual(["turn_start"]);
  });

  test("createSessionRuntime 可以恢复到指定分支", () => {
    const store = makeStore();
    const runtime = makeRuntime(store, "workspace-write");
    runtime.session.appendUser("u1");
    runtime.session.appendAssistant("a1");
    runtime.session.appendUser("u2");

    const fork = store.createBranch(runtime.id, 1, {
      ...(runtime.session.branchId !== undefined
        ? { parentBranchId: runtime.session.branchId }
        : {}),
      title: "fork",
    });

    const restored = createSessionRuntime({
      sessionId: runtime.id,
      branchId: fork,
      client: createMockClient({ script: [] }),
      model: "test-model",
      providerId: "test",
      systemPrompt: "SYS",
      cwd: "/tmp",
      store,
      mode: "workspace-write",
      policy: new PermissionPolicy({ default: "allow" }),
      interaction,
    });

    expect(restored.session.branchId).toBe(fork);
    expect(restored.session.messages.map((message) => message.msgid)).toEqual([0, 1]);
  });
});
