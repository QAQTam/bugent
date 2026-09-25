import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/core/session.ts";
import { GoalController } from "../src/goal/controller.ts";
import { LivingHandoffBuilder } from "../src/goal/handoff.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import { GoalRepository } from "../src/store/goal-repository.ts";
import { SessionStore } from "../src/store/repository.ts";
import { createGoalTools } from "../src/tools/goal.ts";
import { ToolRegistry } from "../src/tools/types.ts";

const stores: SessionStore[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  stores.length = 0;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function setup(): Promise<{
  store: SessionStore;
  session: AgentSession;
  controller: GoalController;
  root: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-goal-handoff-"));
  dirs.push(dir);
  const root = join(dir, "handoffs");
  const store = new SessionStore({ path: join(dir, "bugent.db") });
  stores.push(store);
  store.createSession({
    id: "s1",
    createdAt: 1,
    updatedAt: 1,
    model: "test",
    systemPrompt: "SYS",
    cwd: "/tmp",
  });
  const session = new AgentSession({
    id: "s1",
    system: "SYS",
    client: createMockClient({ script: [] }),
    model: "test",
    now: () => 1,
    onMessage: (message) => store.appendMessage("s1", message),
  });
  const controller = new GoalController({
    repository: new GoalRepository(store.db),
    session,
    store,
    cwd: "/tmp",
    handoffRoot: root,
  });
  return { store, session, controller, root };
}

function prepareGoal(controller: GoalController): void {
  controller.authorizeCreate();
  controller.createFromContract({
    rawIntent: "实现 Handoff",
    objective: "实现可恢复的 Goal Handoff",
    successCriteria: ["上下文可恢复"],
  });
  controller.applyPlan({
    phases: [
      {
        id: "p1",
        title: "Handoff",
        objective: "完成 living handoff",
        checkpointIds: ["cp1"],
        dependsOn: [],
        risks: [],
        verification: ["bun test"],
      },
    ],
    checkpoints: [
      {
        id: "cp1",
        order: 1,
        title: "文档",
        deliverable: "HANDOFF.md",
        acceptanceCriteria: ["快照可恢复"],
        evidenceRequired: ["file"],
      },
    ],
  });
  controller.writeTodos({
    checkpointId: "cp1",
    todos: [{ id: "t1", content: "写 Handoff", status: "in_progress" }],
  });
}

describe("Goal P4 · living handoff", () => {
  test("系统事实持续重建，模型 patch 只追加叙事 revision", async () => {
    const { controller, root } = await setup();
    prepareGoal(controller);
    const goal = controller.currentGoal()!;
    const builder = new LivingHandoffBuilder({
      repository: controller.repository,
      sessionId: "s1",
      goalId: goal.id,
      root,
    });

    const first = await builder.sync("system");
    expect(first.revision).toBe(1);
    const firstText = await readFile(builder.canonicalPath, "utf8");
    expect(firstText).toContain("# Goal Handoff: 实现可恢复的 Goal Handoff");
    expect(firstText).toContain("## 3. Checkpoints");
    expect(firstText).toContain("cp1");

    const second = await builder.applyPatches(first.revision, "worker", [
      {
        section: "work_log",
        operation: "append",
        content: "完成 canonical handoff 生成",
        evidence: ["tests/goal-handoff.test.ts"],
      },
    ]);
    expect(second.revision).toBe(2);
    const secondText = await readFile(builder.canonicalPath, "utf8");
    expect(secondText).toContain("完成 canonical handoff 生成");
    expect(secondText).toContain("## 1. Goal Contract");
    await expect(
      builder.applyPatches(first.revision, "worker", [
        { section: "work_log", operation: "append", content: "stale" },
      ]),
    ).rejects.toThrow("base revision is stale");
  });

  test("Context Epoch 从 msgid0 新分支生成不可变 snapshot", async () => {
    const { store, controller } = await setup();
    prepareGoal(controller);

    const epoch = await controller.createContextEpoch("manual");
    expect(store.getActiveBranchId("s1")).toBe(epoch.branchId);
    const branchMessages = store.loadBranchPath("s1", epoch.branchId);
    expect(branchMessages[0]?.msgid).toBe(0);
    expect(branchMessages.map((message) => message.injectionSource)).toEqual([
      undefined,
      "mcp",
      "skill",
      "goal",
      "plan",
      "checkpoint",
      "handoff",
      "handoff",
    ]);

    const snapshot = await controller.getHandoff(epoch.epochId);
    expect(snapshot?.snapshot).toBe(true);
    expect(snapshot?.markdown).toContain("Goal Handoff");
    expect(snapshot?.revision.snapshotHash).toBe(
      controller.repository.requireEpoch(epoch.epochId).handoffSnapshotHash,
    );
  });

  test("handoff_update 工具禁止系统事实章节，允许追加 work log", async () => {
    const { controller } = await setup();
    prepareGoal(controller);
    const registry = new ToolRegistry();
    for (const tool of createGoalTools(controller)) registry.register(tool);
    const ctx = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "s1",
    };

    const initial = await registry.execute(
      { id: "c1", name: "get_handoff", args: {} },
      ctx,
    );
    expect(initial.ok).toBe(true);
    expect(initial.output).toContain('"revision": 1');

    const updated = await registry.execute(
      {
        id: "c2",
        name: "handoff_update",
        args: {
          base_revision: 1,
          patches: [
            {
              section: "work_log",
              operation: "append",
              content: "记录一次恢复点",
            },
          ],
        },
      },
      ctx,
    );
    expect(updated.ok).toBe(true);
    expect(updated.output).toContain('"revision": 2');

    const forbidden = await registry.execute(
      {
        id: "c3",
        name: "handoff_update",
        args: {
          base_revision: 2,
          patches: [
            {
              section: "goal_contract",
              operation: "append",
              content: "篡改事实",
            },
          ],
        },
      },
      ctx,
    );
    expect(forbidden.ok).toBe(false);
  });
});
