import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/core/session.ts";
import { GoalController } from "../src/goal/controller.ts";
import type { ReviewRunner } from "../src/goal/review.ts";
import type { ReviewResult } from "../src/goal/types.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import { GoalRepository } from "../src/store/goal-repository.ts";
import { SessionStore } from "../src/store/repository.ts";
import { createGoalTools } from "../src/tools/goal.ts";
import { createTodoWriteTool } from "../src/tools/todo.ts";
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

async function setup(options: { reviewRunner?: ReviewRunner; cwd?: string } = {}): Promise<{
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
    cwd: options.cwd ?? "/tmp",
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
    cwd: options.cwd ?? "/tmp",
    ...(options.reviewRunner !== undefined ? { reviewRunner: options.reviewRunner } : {}),
    now: () => 100,
  });
  return { store, session, controller };
}

function prepareExecutingCheckpoint(controller: GoalController): void {
  controller.authorizeCreate();
  controller.createFromContract({
    rawIntent: "实现 Goal",
    objective: "实现完整 Goal",
    successCriteria: ["测试通过"],
  });
  controller.applyPlan({
    phases: [
      {
        id: "phase-1",
        title: "基础",
        objective: "完成持久化",
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
        title: "仓储",
        deliverable: "GoalRepository",
        acceptanceCriteria: ["测试通过"],
        evidenceRequired: ["test"],
      },
    ],
  });
  controller.writeTodos({
    checkpointId: "cp1",
    todos: [
      {
        id: "t1",
        content: "写测试",
        status: "completed",
        completionEvidence: ["bun test tests/goal-controller.test.ts"],
      },
    ],
  });
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

  test("Plan 与 Checkpoint 原子创建，Todo 只属于当前 Checkpoint", async () => {
    const { session, controller } = await setup();
    controller.authorizeCreate();
    controller.createFromContract({
      rawIntent: "实现 Goal",
      objective: "实现完整 Goal",
      successCriteria: ["测试通过"],
    });

    const applied = controller.applyPlan({
      phases: [
        {
          id: "phase-1",
          title: "基础",
          objective: "完成持久化",
          checkpointIds: ["cp1", "cp2"],
          dependsOn: [],
          risks: [],
          verification: ["bun test"],
        },
      ],
      checkpoints: [
        {
          id: "cp1",
          order: 1,
          title: "仓储",
          deliverable: "GoalRepository",
          acceptanceCriteria: ["迁移与仓储测试通过"],
          evidenceRequired: ["test"],
        },
        {
          id: "cp2",
          order: 2,
          title: "接线",
          deliverable: "工具与运行时",
          acceptanceCriteria: ["组合测试通过"],
          evidenceRequired: ["test"],
          dependsOn: ["cp1"],
        },
      ],
    });
    expect(applied.plan.revision).toBe(1);
    expect(controller.currentGoal()?.phase).toBe("ready");
    expect(
      session.messages.some((message) => message.injectionSource === "plan"),
    ).toBe(true);

    const registry = new ToolRegistry().register(createTodoWriteTool({ goalController: controller }));
    const ctx = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      callId: "todo-1",
      sessionId: "s1",
    };
    const missingCheckpoint = await registry.execute(
      {
        id: "todo-1",
        name: "todo_write",
        args: { todos: [{ id: "t1", content: "写测试", status: "in_progress" }] },
      },
      ctx,
    );
    expect(missingCheckpoint.ok).toBe(false);
    expect(missingCheckpoint.output).toContain("checkpoint_id");

    const noEvidence = await registry.execute(
      {
        id: "todo-2",
        name: "todo_write",
        args: {
          checkpoint_id: "cp1",
          todos: [{ id: "t1", content: "写测试", status: "completed" }],
        },
      },
      ctx,
    );
    expect(noEvidence.ok).toBe(false);
    expect(noEvidence.output).toContain("completionEvidence");

    const created = await registry.execute(
      {
        id: "todo-3",
        name: "todo_write",
        args: {
          checkpoint_id: "cp1",
          todos: [
            {
              id: "t1",
              content: "写测试",
              status: "completed",
              completionEvidence: ["tests/goal-controller.test.ts"],
            },
            { id: "t2", content: "跑测试", status: "in_progress" },
          ],
        },
      },
      ctx,
    );
    expect(created.ok).toBe(true);
    expect(created.output).toContain("Todo snapshot revision：1");
    expect(controller.currentGoal()?.phase).toBe("executing");
    expect(controller.currentGoal()?.activeCheckpointId).toBe("cp1");

    const wrongCheckpoint = await registry.execute(
      {
        id: "todo-4",
        name: "todo_write",
        args: {
          checkpoint_id: "cp2",
          todos: [{ id: "t3", content: "提前做", status: "pending" }],
        },
      },
      ctx,
    );
    expect(wrongCheckpoint.ok).toBe(false);
    expect(wrongCheckpoint.output).toContain("当前 Checkpoint");
  });

  test("用户可编辑未规划 Goal Contract，clear 只删除 Goal 聚合", async () => {
    const { session, controller } = await setup();
    controller.repository.createGoal({
      id: "draft-goal",
      sessionId: "s1",
      rawIntent: "原始目标",
      objective: "原始目标",
      successCriteria: [{ id: "SC-1", text: "旧标准", evidenceRequired: ["test"] }],
      phase: "draft",
    });
    const beforeMessages = session.messages.length;

    const edited = controller.editContract({
      rawIntent: "更新目标",
      objective: "更新后的目标",
      successCriteria: ["新标准"],
      constraints: ["新约束"],
      nonGoals: [],
    });
    expect(edited.objective).toBe("更新后的目标");
    expect(edited.successCriteria[0]?.text).toBe("新标准");
    expect(session.messages.length).toBeGreaterThan(beforeMessages);

    const cleared = controller.clearGoal();
    expect(cleared).toBe("draft-goal");
    expect(controller.currentGoal()).toBeUndefined();
    expect(session.messages.length).toBeGreaterThan(beforeMessages);
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

  test("update_plan 工具创建 Plan 并返回首个 Checkpoint", async () => {
    const { controller } = await setup();
    const registry = new ToolRegistry();
    for (const tool of createGoalTools(controller)) registry.register(tool);
    const ctx = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "s1",
    };
    controller.authorizeCreate();
    await registry.execute(
      {
        id: "c1",
        name: "create_goal",
        args: {
          raw_intent: "实现 Goal",
          objective: "实现完整 Goal",
          success_criteria: ["测试通过"],
        },
      },
      ctx,
    );

    const result = await registry.execute(
      {
        id: "c2",
        name: "update_plan",
        args: {
          phases: [
            {
              id: "p1",
              title: "基础",
              objective: "完成 P0",
              checkpoint_ids: ["cp1"],
              verification: ["bun test"],
            },
          ],
          checkpoints: [
            {
              id: "cp1",
              order: 1,
              title: "仓储",
              deliverable: "GoalRepository",
              acceptance_criteria: ["测试通过"],
              evidence_required: ["test"],
            },
          ],
        },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('"checkpointId": "cp1"');
    expect(controller.currentGoal()?.phase).toBe("ready");
  });

  test("submit_checkpoint 工具走 verifier 与 review gate", async () => {
    const { controller } = await setup({
      reviewRunner: {
        async run(): Promise<ReviewResult> {
          return {
            verdict: "approve",
            criteriaCoverage: [
              { criterion: "测试通过", status: "proven", evidence: ["ev-test"] },
            ],
            findings: [],
            unresolvedQuestions: [],
          };
        },
      },
    });
    prepareExecutingCheckpoint(controller);
    const registry = new ToolRegistry();
    for (const tool of createGoalTools(controller)) registry.register(tool);
    const ctx = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "s1",
    };

    const result = await registry.execute(
      {
        id: "c1",
        name: "submit_checkpoint",
        args: {
          checkpoint_id: "cp1",
          summary: "完成",
          evidence: [
            {
              kind: "test",
              summary: "tests pass",
              reference: "bun test",
              command: "bun test",
              exit_code: 0,
            },
          ],
        },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('"reviewStatus": "approved"');
    expect(result.output).toContain('"checkpointStatus": "completed"');
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

describe("Goal P3 · verification and review", () => {
  const evidence = [
    {
      kind: "test" as const,
      summary: "Goal controller tests pass",
      reference: "bun test tests/goal-controller.test.ts",
      command: "bun test tests/goal-controller.test.ts",
      exitCode: 0,
    },
  ];

  test("确定性验证失败时不会进入 review", async () => {
    let reviewCalled = false;
    const { controller } = await setup({
      reviewRunner: {
        async run(): Promise<ReviewResult> {
          reviewCalled = true;
          throw new Error("should not run");
        },
      },
    });
    prepareExecutingCheckpoint(controller);

    await expect(
      controller.submitCheckpoint({
        checkpointId: "cp1",
        summary: "失败命令",
        evidence: [{ ...evidence[0]!, exitCode: 1 }],
      }),
    ).rejects.toThrow("退出码不是 0");
    expect(reviewCalled).toBe(false);
    expect(controller.repository.requireCheckpoint("cp1").status).toBe("active");
  });

  test("review approve 后 Checkpoint 才完成", async () => {
    const { controller } = await setup({
      reviewRunner: {
        async run(): Promise<ReviewResult> {
          return {
            verdict: "approve",
            criteriaCoverage: [
              { criterion: "测试通过", status: "proven", evidence: ["ev-test"] },
            ],
            findings: [],
            unresolvedQuestions: [],
          };
        },
      },
    });
    prepareExecutingCheckpoint(controller);

    const result = await controller.submitCheckpoint({
      checkpointId: "cp1",
      summary: "实现完成",
      evidence,
      remainingRisk: [],
    });
    expect(result.review.status).toBe("approved");
    expect(result.checkpoint.status).toBe("completed");
    expect(
      controller.repository.listEvidence(controller.currentGoal()!.id, "cp1"),
    ).toHaveLength(1);
    expect(controller.currentGoal()?.phase).toBe("checkpoint_audit");
  });

  test("changes_requested 会让 Checkpoint 回到 active", async () => {
    const { controller } = await setup({
      reviewRunner: {
        async run(): Promise<ReviewResult> {
          return {
            verdict: "changes_requested",
            criteriaCoverage: [
              { criterion: "测试通过", status: "partial", evidence: ["ev-test"] },
            ],
            findings: [
              {
                severity: "high",
                title: "缺少边界测试",
                evidence: "只有 happy path",
                requestedChange: "补失败路径测试",
              },
            ],
            unresolvedQuestions: [],
          };
        },
      },
    });
    prepareExecutingCheckpoint(controller);

    const result = await controller.submitCheckpoint({
      checkpointId: "cp1",
      summary: "待修复",
      evidence,
    });
    expect(result.review.status).toBe("changes_requested");
    expect(result.checkpoint.status).toBe("active");
    expect(controller.repository.listReviewFindings(result.review.id).length).toBeGreaterThan(0);
  });

  test("reviewer approve 但 criteria 未覆盖时由系统强制拒绝", async () => {
    const { controller } = await setup({
      reviewRunner: {
        async run(): Promise<ReviewResult> {
          return {
            verdict: "approve",
            criteriaCoverage: [],
            findings: [],
            unresolvedQuestions: [],
          };
        },
      },
    });
    prepareExecutingCheckpoint(controller);

    const result = await controller.submitCheckpoint({
      checkpointId: "cp1",
      summary: "证据不足",
      evidence,
    });
    expect(result.review.status).toBe("changes_requested");
    expect(result.checkpoint.status).toBe("active");
  });
});

describe("Goal P5 · continuation accounting", () => {
  test("执行中可继续，连续三次无进展进入 blocked", async () => {
    const { session, controller } = await setup();
    prepareExecutingCheckpoint(controller);
    expect(controller.canAutoContinue()).toEqual({ allowed: true });

    const start = controller.beginContinuation();
    expect(controller.currentGoal()?.continuationCount).toBe(1);
    expect(session.messages.at(-1)?.injectionSource).toBe("goal");

    const first = controller.completeTurn({
      turnId: "g1",
      startedAt: 0,
      endedAt: 1000,
      usage: { input: 10, output: 5 },
      fingerprintBefore: start.fingerprint,
    });
    expect(first.outcome).toBe("no_progress");
    expect(first.blockedStreak).toBe(1);

    controller.completeTurn({
      turnId: "g2",
      startedAt: 1000,
      endedAt: 2000,
      usage: { input: 10, output: 5 },
      fingerprintBefore: controller.progressFingerprint(),
    });
    const third = controller.completeTurn({
      turnId: "g3",
      startedAt: 2000,
      endedAt: 3000,
      usage: { input: 10, output: 5 },
      fingerprintBefore: controller.progressFingerprint(),
    });
    expect(third.blocked).toBe(true);
    expect(controller.currentGoal()?.status).toBe("blocked");
    expect(controller.currentGoal()?.tokensUsed).toBe(45);
  });

  test("waiting_user 会暂停自动 continuation，直到用户输入", async () => {
    const { controller } = await setup();
    prepareExecutingCheckpoint(controller);
    controller.deferForUser();
    expect(controller.canAutoContinue()).toEqual({
      allowed: false,
      reason: "waiting for user",
    });
    controller.clearUserDeferral();
    expect(controller.canAutoContinue()).toEqual({ allowed: true });
  });

  test("达到 token budget 会停止 continuation", async () => {
    const { controller } = await setup();
    controller.authorizeCreate();
    controller.createFromContract({
      rawIntent: "预算 Goal",
      objective: "验证预算停止",
      successCriteria: ["停止"],
      tokenBudget: 10,
    });
    controller.applyPlan({
      phases: [
        {
          id: "p1",
          title: "预算",
          objective: "达到预算",
          checkpointIds: ["cp1"],
          dependsOn: [],
          risks: [],
          verification: ["test"],
        },
      ],
      checkpoints: [
        {
          id: "cp1",
          order: 1,
          title: "预算",
          deliverable: "stop",
          acceptanceCriteria: ["stop"],
          evidenceRequired: ["test"],
        },
      ],
    });
    controller.writeTodos({
      checkpointId: "cp1",
      todos: [{ id: "t1", content: "执行", status: "in_progress" }],
    });
    expect(controller.canAutoContinue()).toEqual({ allowed: true });
    const start = controller.beginContinuation();
    const completion = controller.completeTurn({
      turnId: "budget-turn",
      startedAt: 0,
      endedAt: 1000,
      usage: { input: 6, output: 4 },
      fingerprintBefore: start.fingerprint,
    });
    expect(completion.budgetLimited).toBe(true);
    expect(controller.currentGoal()?.status).toBe("budget_limited");
    expect(controller.canAutoContinue().allowed).toBe(false);
  });
});

describe("Goal P6 · final audit", () => {
  const evidence = [
    {
      kind: "test" as const,
      summary: "tests pass",
      reference: "bun test",
      command: "bun test",
      exitCode: 0,
    },
  ];

  function approveRunner(): ReviewRunner {
    return {
      async run(): Promise<ReviewResult> {
        return {
          verdict: "approve",
          criteriaCoverage: [
            { criterion: "测试通过", status: "proven", evidence: ["ev"] },
          ],
          findings: [],
          unresolvedQuestions: [],
        };
      },
    };
  }

  test("最后一个 Checkpoint 完成后仍需 goal-level audit 才能 complete", async () => {
    const { controller } = await setup({ reviewRunner: approveRunner() });
    prepareExecutingCheckpoint(controller);
    await controller.submitCheckpoint({
      checkpointId: "cp1",
      summary: "完成",
      evidence,
    });
    expect(controller.currentGoal()?.status).toBe("active");
    expect(controller.currentGoal()?.phase).toBe("checkpoint_audit");

    const audit = await controller.finalAudit();
    expect(audit.approved).toBe(true);
    expect(controller.currentGoal()?.status).toBe("complete");
    expect(controller.currentGoal()?.phase).toBe("final_audit");
  });

  test("final audit 未覆盖 success criterion 时回到 executing", async () => {
    let call = 0;
    const { controller } = await setup({
      reviewRunner: {
        async run(): Promise<ReviewResult> {
          call += 1;
          return call === 1
            ? {
                verdict: "approve",
                criteriaCoverage: [
                  { criterion: "测试通过", status: "proven", evidence: ["ev"] },
                ],
                findings: [],
                unresolvedQuestions: [],
              }
            : {
                verdict: "approve",
                criteriaCoverage: [],
                findings: [],
                unresolvedQuestions: [],
              };
        },
      },
    });
    prepareExecutingCheckpoint(controller);
    await controller.submitCheckpoint({
      checkpointId: "cp1",
      summary: "完成",
      evidence,
    });

    const audit = await controller.finalAudit();
    expect(audit.approved).toBe(false);
    expect(controller.currentGoal()?.status).toBe("active");
    expect(controller.currentGoal()?.phase).toBe("executing");
  });
});
