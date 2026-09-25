import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, schemaVersion, SCHEMA_VERSION } from "../src/store/db.ts";
import { GoalRepository, GoalRepositoryError } from "../src/store/goal-repository.ts";
import { SessionStore } from "../src/store/repository.ts";

const stores: SessionStore[] = [];
const databases: Database[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  for (const database of databases) {
    try {
      database.close();
    } catch {
      // already closed
    }
  }
  stores.length = 0;
  databases.length = 0;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function makeStore(): Promise<SessionStore> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-goal-"));
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
  return store;
}

function createGoal(repository: GoalRepository) {
  return repository.createGoal({
    id: "goal1",
    sessionId: "s1",
    rawIntent: "实现 Goal Mode",
    objective: "实现可验证的 Goal Mode",
    successCriteria: [
      { id: "SC-1", text: "持久化完整", evidenceRequired: ["migration test"] },
    ],
    constraints: ["不破坏旧 schema"],
    nonGoals: ["不做自动 continuation"],
    riskPolicy: {
      level: "medium",
      requireUserApproval: false,
      reviewPolicy: "medium",
      notes: [],
    },
    now: 10,
  });
}

describe("Goal P0 · schema v10", () => {
  test("v9 数据库会迁移到 v10 并创建 Goal 表", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bugent-goal-migrate-"));
    dirs.push(dir);
    const path = join(dir, "v9.db");

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
      INSERT INTO meta (key, value) VALUES ('schema_version', '9');
    `);
    legacy.close();

    const upgraded = openDatabase({ path });
    databases.push(upgraded);
    const tables = new Set(
      (
        upgraded
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((row) => row.name),
    );

    expect(schemaVersion(upgraded)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(10);
    for (const table of [
      "session_goals",
      "goal_checkpoints",
      "goal_plan_revisions",
      "goal_todo_snapshots",
      "goal_evidence",
      "goal_handoffs",
      "goal_epochs",
      "goal_turn_accounting",
      "goal_reviews",
      "goal_review_findings",
    ]) {
      expect(tables.has(table)).toBe(true);
    }
  });
});

describe("Goal P0 · repository", () => {
  test("Goal contract、phase/status 与完整完成门禁", async () => {
    const store = await makeStore();
    const repository = new GoalRepository(store.db);
    const goal = createGoal(repository);

    expect(goal.status).toBe("active");
    expect(goal.phase).toBe("draft");
    expect(goal.successCriteria).toHaveLength(1);
    expect(() => repository.setGoalStatus("goal1", "complete")).toThrow(GoalRepositoryError);

    expect(repository.setGoalPhase("goal1", "inspecting").phase).toBe("inspecting");
    expect(repository.setGoalPhase("goal1", "planning").phase).toBe("planning");
    expect(repository.setGoalPhase("goal1", "ready").phase).toBe("ready");
    expect(repository.setGoalPhase("goal1", "executing").phase).toBe("executing");
    expect(() => repository.setGoalPhase("goal1", "draft")).toThrow(GoalRepositoryError);

    const checkpoints = repository.addCheckpoints(
      "goal1",
      [
        {
          id: "cp1",
          order: 1,
          title: "基础模型",
          deliverable: "类型和仓储",
          acceptanceCriteria: ["仓储测试通过"],
          evidenceRequired: ["test"],
        },
        {
          id: "cp2",
          order: 2,
          title: "接入运行时",
          deliverable: "GoalController",
          acceptanceCriteria: ["集成测试通过"],
          evidenceRequired: ["test"],
          dependsOn: ["cp1"],
        },
      ],
      20,
    );
    expect(checkpoints.map((checkpoint) => checkpoint.status)).toEqual(["pending", "pending"]);
    expect(repository.activateCheckpoint("cp1", 21).status).toBe("active");
    expect(() => repository.activateCheckpoint("cp2", 22)).toThrow("preceding checkpoint");

    repository.setCheckpointStatus("cp1", "verifying");
    repository.setCheckpointStatus("cp1", "reviewing");
    repository.setCheckpointStatus("cp1", "completed");
    expect(repository.activateCheckpoint("cp2", 23).status).toBe("active");
    repository.setCheckpointStatus("cp2", "verifying");
    repository.setCheckpointStatus("cp2", "reviewing");
    repository.setCheckpointStatus("cp2", "completed");

    expect(repository.setGoalPhase("goal1", "final_audit").phase).toBe("final_audit");
    expect(repository.setGoalStatus("goal1", "complete").status).toBe("complete");
    expect(() => repository.setGoalStatus("goal1", "active")).toThrow(GoalRepositoryError);
  });

  test("Checkpoint 依赖校验是原子的，环依赖不会留下半成品", async () => {
    const store = await makeStore();
    const repository = new GoalRepository(store.db);
    createGoal(repository);

    expect(() =>
      repository.addCheckpoints("goal1", [
        {
          id: "a",
          order: 1,
          title: "A",
          deliverable: "A",
          acceptanceCriteria: ["a"],
          evidenceRequired: ["test"],
          dependsOn: ["b"],
        },
        {
          id: "b",
          order: 2,
          title: "B",
          deliverable: "B",
          acceptanceCriteria: ["b"],
          evidenceRequired: ["test"],
          dependsOn: ["a"],
        },
      ]),
    ).toThrow("cycle");
    expect(repository.listCheckpoints("goal1")).toHaveLength(0);
  });

  test("初始 Plan 与 Checkpoint 原子写入，非法 DAG 不留下半成品", async () => {
    const store = await makeStore();
    const repository = new GoalRepository(store.db);
    createGoal(repository);

    expect(() =>
      repository.createInitialPlan("goal1", {
        phases: [
          {
            id: "p1",
            title: "基础",
            objective: "完成 P0",
            checkpointIds: ["a", "b"],
            dependsOn: [],
            risks: [],
            verification: ["bun test"],
          },
        ],
        checkpoints: [
          {
            id: "a",
            order: 1,
            title: "A",
            deliverable: "A",
            acceptanceCriteria: ["a"],
            evidenceRequired: ["test"],
            dependsOn: ["b"],
          },
          {
            id: "b",
            order: 2,
            title: "B",
            deliverable: "B",
            acceptanceCriteria: ["b"],
            evidenceRequired: ["test"],
            dependsOn: ["a"],
          },
        ],
      }),
    ).toThrow("cycle");
    expect(repository.listPlanRevisions("goal1")).toHaveLength(0);
    expect(repository.listCheckpoints("goal1")).toHaveLength(0);
  });

  test("Plan revision 不覆盖旧版本，Todo 完成必须带证据", async () => {
    const store = await makeStore();
    const repository = new GoalRepository(store.db);
    createGoal(repository);
    repository.addCheckpoint("goal1", {
      id: "cp1",
      order: 1,
      title: "P0",
      deliverable: "仓储",
      acceptanceCriteria: ["测试通过"],
      evidenceRequired: ["test"],
    });

    const first = repository.appendPlanRevision("goal1", {
      phases: [
        {
          id: "p1",
          title: "基础",
          objective: "完成 P0",
          checkpointIds: ["cp1"],
          dependsOn: [],
          risks: [],
          verification: ["bun test"],
        },
      ],
      now: 30,
    });
    const second = repository.appendPlanRevision("goal1", {
      phases: [
        {
          id: "p1",
          title: "基础",
          objective: "完成 P0 与测试",
          checkpointIds: ["cp1"],
          dependsOn: [],
          risks: ["兼容性"],
          verification: ["bun test", "bun run typecheck"],
        },
      ],
      assumptions: ["schema v10"],
      now: 31,
    });

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(repository.listPlanRevisions("goal1").map((plan) => plan.revision)).toEqual([1, 2]);
    expect(repository.latestPlanRevision("goal1")?.id).toBe(second.id);

    expect(() =>
      repository.replaceTodoSnapshot("goal1", {
        checkpointId: "cp1",
        todos: [{ id: "t1", content: "写测试", status: "completed" }],
      }),
    ).toThrow("completionEvidence");

    const snapshot = repository.replaceTodoSnapshot("goal1", {
      checkpointId: "cp1",
      summary: "P0 执行",
      todos: [
        {
          id: "t1",
          content: "写测试",
          status: "completed",
          completionEvidence: ["tests/goal-repository.test.ts"],
        },
        { id: "t2", content: "跑测试", status: "in_progress" },
      ],
      now: 32,
    });
    expect(snapshot.revision).toBe(1);
    expect(snapshot.todos[0]?.checkpointId).toBe("cp1");
  });

  test("Review changes_requested 会把 Checkpoint 退回 active", async () => {
    const store = await makeStore();
    const repository = new GoalRepository(store.db);
    createGoal(repository);
    repository.addCheckpoint("goal1", {
      id: "cp1",
      order: 1,
      title: "P0",
      deliverable: "仓储",
      acceptanceCriteria: ["测试通过"],
      evidenceRequired: ["test"],
    });
    repository.activateCheckpoint("cp1");
    repository.setCheckpointStatus("cp1", "verifying");
    repository.setCheckpointStatus("cp1", "reviewing");

    const review = repository.createReview("goal1", {
      id: "review1",
      checkpointId: "cp1",
      reviewer: "reviewer",
      baseRevision: "base",
      headRevision: "head",
      diffHash: "sha256:diff",
      now: 40,
    });
    repository.setReviewStatus(review.id, "running");
    const completed = repository.completeReview(review.id, {
      verdict: "changes_requested",
      criteriaCoverage: [
        { criterion: "SC-1", status: "partial", evidence: ["ev1"] },
      ],
      findings: [
        {
          severity: "high",
          title: "缺少迁移测试",
          evidence: "diff 未覆盖 v9 -> v10",
          requestedChange: "补迁移测试",
        },
      ],
      unresolvedQuestions: [],
    });

    expect(completed.status).toBe("changes_requested");
    expect(repository.requireCheckpoint("cp1").status).toBe("active");
    expect(repository.listReviewFindings(review.id)).toHaveLength(1);
  });

  test("usage、handoff revision 与 epoch snapshot 可持久化", async () => {
    const store = await makeStore();
    const repository = new GoalRepository(store.db);
    createGoal(repository);
    repository.addCheckpoint("goal1", {
      id: "cp1",
      order: 1,
      title: "P0",
      deliverable: "仓储",
      acceptanceCriteria: ["测试通过"],
      evidenceRequired: ["test"],
    });

    repository.recordTurn("goal1", {
      turnId: "turn1",
      inputTokens: 120,
      outputTokens: 30,
      cachedTokens: 80,
      activeSeconds: 5,
      outcome: "progress",
      startedAt: 50,
      endedAt: 55,
    });
    expect(repository.requireGoal("goal1")).toMatchObject({
      tokensUsed: 150,
      timeUsedSeconds: 5,
    });
    expect(() =>
      repository.recordTurn("goal1", {
        turnId: "turn1",
        inputTokens: 1,
        outputTokens: 1,
        activeSeconds: 1,
        outcome: "progress",
        startedAt: 56,
        endedAt: 57,
      }),
    ).toThrow();

    const evidence = repository.addEvidence("goal1", {
      id: "ev1",
      checkpointId: "cp1",
      kind: "test",
      summary: "Goal P0 tests pass",
      reference: "bun test tests/goal-repository.test.ts",
      command: "bun test tests/goal-repository.test.ts",
      exitCode: 0,
      now: 60,
    });
    expect(repository.listEvidence("goal1", "cp1")).toEqual([evidence]);

    const handoff1 = repository.createHandoffRevision("goal1", {
      id: "h1",
      updatedBy: "system",
      currentState: "P0 started",
      markdownPath: "/tmp/goal1/HANDOFF.md",
      now: 70,
    });
    expect(handoff1.revision).toBe(1);
    expect(() =>
      repository.createEpoch("goal1", {
        branchId: "branch1",
        handoffId: handoff1.id,
        reason: "manual",
      }),
    ).toThrow("snapshot hash");

    const handoff2 = repository.createHandoffRevision("goal1", {
      id: "h2",
      updatedBy: "worker",
      currentState: "P0 tested",
      markdownPath: "/tmp/goal1/HANDOFF.md",
      snapshotHash: "sha256:handoff",
      supersedesRevision: 1,
      now: 71,
    });
    expect(handoff2.revision).toBe(2);
    expect(repository.requireHandoff(handoff1.id).status).toBe("frozen");
    expect(repository.getCanonicalHandoff("goal1")?.id).toBe(handoff2.id);

    const epoch = repository.createEpoch("goal1", {
      id: "epoch1",
      branchId: "branch1",
      checkpointId: "cp1",
      handoffId: handoff2.id,
      reason: "manual",
      now: 72,
    });
    expect(epoch.handoffRevision).toBe(2);
    expect(epoch.handoffSnapshotHash).toBe("sha256:handoff");
    expect(repository.requireGoal("goal1").activeEpochId).toBe("epoch1");
  });

  test("删除 session 会级联删除 Goal 聚合", async () => {
    const store = await makeStore();
    const repository = new GoalRepository(store.db);
    createGoal(repository);
    repository.addCheckpoint("goal1", {
      id: "cp1",
      order: 1,
      title: "P0",
      deliverable: "仓储",
      acceptanceCriteria: ["测试通过"],
      evidenceRequired: ["test"],
    });
    repository.addEvidence("goal1", {
      checkpointId: "cp1",
      kind: "file",
      summary: "file exists",
      reference: "src/goal/types.ts",
    });

    store.db.exec("DELETE FROM sessions WHERE id = 's1'");

    expect(repository.getGoal("goal1")).toBeUndefined();
    expect(repository.listCheckpoints("goal1")).toHaveLength(0);
    expect(repository.listEvidence("goal1")).toHaveLength(0);
  });
});
