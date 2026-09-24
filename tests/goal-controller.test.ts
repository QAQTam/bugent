import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/core/session.ts";
import { GoalController } from "../src/goal/controller.ts";
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
}> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-goal-controller-"));
  dirs.push(dir);
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
    now: () => 100,
  });
  return { store, session, controller };
}

describe("Goal P1 · controller", () => {
  test("create_goal 必须由 /goal 授权，成功后注入 developer context", async () => {
    const { session, controller } = await setup();
    expect(() =>
      controller.createFromContract({
        rawIntent: "实现 Goal",
        objective: "实现完整 Goal",
        successCriteria: ["测试通过"],
      }),
    ).toThrow("显式执行 /goal");

    controller.authorizeCreate();
    const goal = controller.createFromContract({
      rawIntent: "实现 Goal",
      objective: "实现完整 Goal",
      successCriteria: ["仓储测试通过", "上下文按安全边界注入"],
      constraints: ["不改旧 msgid"],
      nonGoals: ["不做 WebUI"],
      tokenBudget: 50000,
    });

    expect(goal.phase).toBe("planning");
    expect(goal.successCriteria.map((criterion) => criterion.id)).toEqual(["SC-001", "SC-002"]);
    expect(controller.canCreate()).toBe(false);
    expect(controller.statusLine()).toContain("Pursuing goal");

    const injected = session.messages.find((message) => message.injectionSource === "goal");
    expect(injected).toBeDefined();
    expect(session.buildContext().find((message) => message.role === "developer")).toBeDefined();
    expect(session.buildContext().at(-1)?.role).toBe("developer");
    expect(session.buildContext().at(-1)?.parts).toEqual([
      { type: "text", text: injected?.parts[0]?.type === "text" ? injected.parts[0].text : "" },
    ]);
  });

  test("ensureContext 会补回缺失的 Goal Contract，且保持幂等", async () => {
    const { store, session } = await setup();
    const repository = new GoalRepository(store.db);
    repository.createGoal({
      id: "goal-restored",
      sessionId: "s1",
      rawIntent: "恢复 Goal",
      objective: "恢复后继续执行",
      successCriteria: [
        { id: "SC-1", text: "上下文恢复", evidenceRequired: ["test"] },
      ],
      phase: "draft",
    });
    const restored = new AgentSession({
      id: "s1",
      system: "SYS",
      client: createMockClient({ script: [] }),
      model: "test",
      restore: store.loadMessages("s1"),
      nextMsgId: store.nextMsgId("s1"),
      onMessage: (message) => store.appendMessage("s1", message),
    });
    const controller = new GoalController({ repository, session: restored });

    controller.ensureContext();
    controller.ensureContext();
    const goalMessages = restored.messages.filter(
      (message) => message.injectionSource === "goal",
    );
    expect(goalMessages).toHaveLength(1);
    expect(goalMessages[0]?.parts[0]).toMatchObject({ type: "text" });
    expect(session.messages).toHaveLength(3);
  });

  test("pause/resume 是用户控制；模型 complete 仍受 final audit 门禁", async () => {
    const { controller } = await setup();
    controller.authorizeCreate();
    const goal = controller.createFromContract({
      rawIntent: "实现 Goal",
      objective: "实现完整 Goal",
      successCriteria: ["测试通过"],
    });

    expect(controller.pause("用户暂停").status).toBe("paused");
    expect(controller.statusLine()).toContain("Goal paused");
    expect(controller.resume().status).toBe("active");
    expect(() => controller.updateStatus("complete")).toThrow("final_audit");
    expect(controller.updateStatus("blocked", "等待外部依赖").status).toBe("blocked");
    expect(controller.currentGoal()?.id).toBe(goal.id);
  });
});

describe("Goal P1 · tools", () => {
  test("create_goal 只有一次性授权，普通调用和重复调用都失败", async () => {
    const { controller } = await setup();
    const registry = new ToolRegistry();
    for (const tool of createGoalTools(controller)) registry.register(tool);
    const ctx = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "s1",
    };
    const input = {
      raw_intent: "实现 Goal",
      objective: "实现完整 Goal",
      success_criteria: ["测试通过"],
      risk_level: "high",
    };

    const denied = await registry.execute({ id: "c1", name: "create_goal", args: input }, ctx);
    expect(denied.ok).toBe(false);
    expect(denied.output).toContain("显式执行 /goal");

    controller.authorizeCreate();
    const created = await registry.execute({ id: "c2", name: "create_goal", args: input }, ctx);
    expect(created.ok).toBe(true);
    expect(created.output).toContain('"created": true');
    expect(controller.currentGoal()?.riskPolicy.requireUserApproval).toBe(true);

    const repeated = await registry.execute({ id: "c3", name: "create_goal", args: input }, ctx);
    expect(repeated.ok).toBe(false);
    expect(repeated.output).toContain("没有一次性创建授权");
  });

  test("get_goal/update_goal 返回持久状态", async () => {
    const { controller } = await setup();
    const registry = new ToolRegistry();
    for (const tool of createGoalTools(controller)) registry.register(tool);
    const ctx = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "s1",
    };

    const empty = await registry.execute({ id: "c1", name: "get_goal", args: {} }, ctx);
    expect(empty.ok).toBe(true);
    expect(empty.output).toContain('"goal": null');

    controller.authorizeCreate();
    await registry.execute(
      {
        id: "c2",
        name: "create_goal",
        args: {
          raw_intent: "实现 Goal",
          objective: "实现完整 Goal",
          success_criteria: ["测试通过"],
        },
      },
      ctx,
    );

    const paused = await registry.execute(
      { id: "c3", name: "update_goal", args: { status: "paused", reason: "用户暂停" } },
      ctx,
    );
    expect(paused.ok).toBe(true);
    expect(paused.output).toContain('"status": "paused"');

    controller.resume();
    const complete = await registry.execute(
      { id: "c4", name: "update_goal", args: { status: "complete" } },
      ctx,
    );
    expect(complete.ok).toBe(false);
    expect(complete.output).toContain("final_audit");
  });
});
