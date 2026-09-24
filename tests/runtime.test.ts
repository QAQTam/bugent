import { afterEach, describe, expect, test } from "bun:test";
import { createSessionRuntime, type SessionInteraction } from "../src/core/runtime.ts";
import type { McpManager } from "../src/mcp/manager.ts";
import type { SkillManager } from "../src/skills/manager.ts";
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
  test("session 级 sandbox_mode 会持久化并在重建 runtime 时恢复", () => {
    const store = makeStore();
    const first = makeRuntime(store, "read-only");
    expect(store.getSession(first.id)?.sandboxMode).toBe("read-only");

    const restored = createSessionRuntime({
      sessionId: first.id,
      client: createMockClient({ script: [] }),
      model: "test-model",
      providerId: "test",
      systemPrompt: "SYS",
      cwd: "/tmp",
      store,
      policy: new PermissionPolicy({ default: "allow" }),
      interaction,
    });

    expect(restored.mode).toBe("read-only");
  });

  test("session 级 provider/model 会写回 session 记录", () => {
    const store = makeStore();
    const first = makeRuntime(store, "workspace-write");
    expect(store.getSession(first.id)?.providerId).toBe("test");
    expect(store.getSession(first.id)?.model).toBe("test-model");

    createSessionRuntime({
      sessionId: first.id,
      client: createMockClient({ script: [] }),
      model: "new-model",
      providerId: "new-provider",
      providerConfig: {
        id: "new-provider",
        endpoint: "openai-chat",
        baseUrl: "http://127.0.0.1:9999/v1",
      },
      systemPrompt: "SYS",
      cwd: "/tmp",
      store,
      policy: new PermissionPolicy({ default: "allow" }),
      interaction,
    });

    expect(store.getSession(first.id)?.providerId).toBe("new-provider");
    expect(store.getSession(first.id)?.model).toBe("new-model");
    expect(store.getSession(first.id)?.providerConfig?.baseUrl).toBe("http://127.0.0.1:9999/v1");
  });

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

  test("createSessionRuntime 会挂接共享 MCP registry，并在 manifest 变化时排队 developer delta", () => {
    const store = makeStore();
    const first = makeRuntime(store, "workspace-write");
    first.session.appendUser("u1");
    first.session.appendAssistant("a1");

    let attachedRegistry: unknown;
    let detachedRegistry: unknown;
    let attachedIds: readonly string[] | undefined;
    let manifestIds: readonly string[] | undefined;
    const manager = {
      manifest: (ids?: readonly string[]) => {
        manifestIds = ids;
        return "# MCP servers\n\n## fake\n\n- `mcp__fake__echo`";
      },
      status: () => ({ servers: [] }),
      deltaFrom: (previous: string, ids?: readonly string[]) =>
        previous === "# MCP servers\n\n(none)" && ids?.includes("fake")
          ? "# MCP manifest update\n\n- `mcp__fake__echo`"
          : undefined,
      attach: (registry: unknown, ids?: readonly string[]) => {
        attachedRegistry = registry;
        attachedIds = ids;
        return ["mcp__fake__echo"];
      },
      detach: (registry: unknown) => {
        detachedRegistry = registry;
      },
    } as unknown as McpManager;

    const restored = createSessionRuntime({
      sessionId: first.id,
      client: createMockClient({ script: [] }),
      model: "test-model",
      providerId: "test",
      systemPrompt: "SYS",
      cwd: "/tmp",
      store,
      mode: "workspace-write",
      policy: new PermissionPolicy({ default: "allow" }),
      interaction,
      mcpManager: manager,
      mcpServerIds: ["fake"],
    });

    expect(restored.mcpTools).toEqual(["mcp__fake__echo"]);
    expect(attachedRegistry).toBe(restored.tools);
    expect(attachedIds).toEqual(["fake"]);
    expect(manifestIds).toEqual(["fake"]);
    expect(
      restored.session.messages.some(
        (message) =>
          message.injectionSource === "mcp" &&
          message.parts.some((part) => part.type === "text" && part.text.includes("MCP manifest update")),
      ),
    ).toBe(true);

    restored.dispose();
    expect(detachedRegistry).toBe(restored.tools);
  });

  test("createSessionRuntime 会挂接共享 skills registry，并把 catalog 变化排成 skill delta", () => {
    const store = makeStore();
    const first = makeRuntime(store, "workspace-write");
    first.session.appendUser("u1");
    first.session.appendAssistant("a1");

    let attachedRegistry: unknown;
    let detachedRegistry: unknown;
    const manager = {
      manifest: () => "# Skills\n\n- `skill__review__load`: Review code.",
      status: () => ({ skills: [{ name: "review", tool: "skill__review__load" }] }),
      deltaFrom: (previous: string) =>
        previous === "# Skills\n\n(none)"
          ? "# Skills manifest update\n\n- `skill__review__load`: Review code."
          : undefined,
      attach: (registry: unknown) => {
        attachedRegistry = registry;
        return ["skill__review__load"];
      },
      detach: (registry: unknown) => {
        detachedRegistry = registry;
      },
    } as unknown as SkillManager;

    const restored = createSessionRuntime({
      sessionId: first.id,
      client: createMockClient({ script: [] }),
      model: "test-model",
      providerId: "test",
      systemPrompt: "SYS",
      cwd: "/tmp",
      store,
      mode: "workspace-write",
      policy: new PermissionPolicy({ default: "allow" }),
      interaction,
      skillManager: manager,
    });

    expect(restored.skillTools).toEqual(["skill__review__load"]);
    expect(restored.skillStatus).toEqual({
      skills: [{ name: "review", tool: "skill__review__load" }],
    });
    expect(attachedRegistry).toBe(restored.tools);
    expect(
      restored.session.messages.some(
        (message) =>
          message.injectionSource === "skill" &&
          message.parts.some(
            (part) => part.type === "text" && part.text.includes("Skills manifest update"),
          ),
      ),
    ).toBe(true);

    restored.dispose();
    expect(detachedRegistry).toBe(restored.tools);
  });
});
