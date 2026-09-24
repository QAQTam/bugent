import { afterEach, describe, expect, test } from "bun:test";
import { BranchService } from "../src/core/branch-service.ts";
import { openSession } from "../src/core/open-session.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import { SessionStore } from "../src/store/repository.ts";
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

function seed(store: SessionStore): { sessionId: string; branchId: string } {
  const sessionId = newSessionId();
  const session = open(store, sessionId);
  session.appendUser("u1");
  session.appendAssistant("a1");
  session.appendUser("u2");
  session.appendAssistant("a2");
  return { sessionId, branchId: session.branchId! };
}

describe("BranchService", () => {
  test("fork 从目标消息 inclusive 创建并激活新分支", () => {
    const store = makeStore();
    const { sessionId, branchId } = seed(store);
    const service = new BranchService(store);

    const result = service.fork(sessionId, 4);

    expect(result.sourceBranchId).toBe(branchId);
    expect(store.getActiveBranchId(sessionId)).toBe(result.branchId);
    expect(store.loadBranchPath(sessionId, result.branchId).map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4]);
    expect(store.loadBranchPath(sessionId, branchId).map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("undo at 保留目标，undo before 排除目标，原分支都保留", () => {
    const store = makeStore();
    const { sessionId, branchId } = seed(store);
    const service = new BranchService(store);

    const preview = service.previewUndo(sessionId, 5, "at");
    expect(preview.retained.map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(preview.removed.map((m) => m.msgid)).toEqual([6]);

    const at = service.undoTo(sessionId, 5, "at");
    expect(at.branchId).not.toBe(branchId);
    expect(store.loadBranchPath(sessionId, at.branchId).map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4, 5]);

    const before = service.undoTo(sessionId, 5, "before");
    expect(store.loadBranchPath(sessionId, before.branchId).map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4]);
    expect(store.loadBranchPath(sessionId, branchId).map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test("retry 从最近 user 的父节点长分支，并返回原始输入", () => {
    const store = makeStore();
    const { sessionId } = seed(store);
    const service = new BranchService(store);

    const plan = service.planRetry(sessionId, 6);
    expect(plan.userMsgid).toBe(5);
    expect(plan.input).toBe("u2");
    expect(plan.retained.map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4]);
    expect(plan.removed.map((m) => m.msgid)).toEqual([5, 6]);

    const result = service.retryFrom(sessionId, 6);
    expect(store.loadBranchPath(sessionId, result.branchId).map((m) => m.msgid)).toEqual([0, 1, 2, 3, 4]);
  });

  test("拒绝不在当前分支上的消息", () => {
    const store = makeStore();
    const { sessionId } = seed(store);
    const service = new BranchService(store);
    const fork = service.fork(sessionId, 4);
    open(store, sessionId).appendAssistant("fork-a");

    expect(() => service.previewUndo(sessionId, 6)).toThrow("不在当前活动分支");
    expect(store.getActiveBranchId(sessionId)).toBe(fork.branchId);
  });
});
