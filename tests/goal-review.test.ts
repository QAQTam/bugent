import { describe, expect, test } from "bun:test";
import {
  createReadOnlyReviewRunner,
  parseReviewResult,
  reviewResultRejection,
} from "../src/goal/review.ts";
import type { ReviewRequest } from "../src/goal/review.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";

const reviewRequest: ReviewRequest = {
  goal: {
    id: "goal1",
    sessionId: "s1",
    rawIntent: "实现 Goal",
    objective: "实现完整 Goal",
    successCriteria: [
      { id: "SC-1", text: "测试通过", evidenceRequired: ["test"] },
    ],
    constraints: ["只读 review"],
    nonGoals: [],
    riskPolicy: {
      level: "medium",
      requireUserApproval: false,
      reviewPolicy: "medium",
      notes: [],
    },
    status: "active",
    phase: "executing",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    continuationCount: 0,
    blockedStreak: 0,
    activeCheckpointId: "cp1",
    createdAt: 1,
    updatedAt: 1,
  },
  checkpoint: {
    id: "cp1",
    goalId: "goal1",
    order: 1,
    title: "仓储",
    deliverable: "GoalRepository",
    acceptanceCriteria: ["测试通过"],
    evidenceRequired: ["test"],
    dependsOn: [],
    status: "reviewing",
    createdAt: 1,
  },
  todos: [
    {
      id: "t1",
      checkpointId: "cp1",
      content: "写测试",
      status: "completed",
      completionEvidence: ["bun test"],
    },
  ],
  evidence: [
    {
      id: "ev1",
      goalId: "goal1",
      checkpointId: "cp1",
      kind: "test",
      summary: "tests pass",
      reference: "bun test",
      command: "bun test",
      exitCode: 0,
      createdAt: 1,
    },
  ],
  remainingRisk: [],
  cwd: "/tmp",
  baseRevision: "base",
  headRevision: "head",
  diffHash: "sha256:diff",
};

describe("Goal P3 · read-only reviewer", () => {
  test("reviewer 只拿到只读工具，解析 JSON verdict", async () => {
    let toolNames: string[] = [];
    const client = createMockClient({
      script: [
        (request) => {
          toolNames = request.tools?.map((tool) => tool.name) ?? [];
          return [
            {
              type: "text",
              delta:
                '```json\n{"verdict":"approve","criteriaCoverage":[{"criterion":"测试通过","status":"proven","evidence":["ev1"]}],"findings":[],"unresolvedQuestions":[]}\n```',
            },
            { type: "done", reason: "stop" },
          ];
        },
      ],
    });
    const runner = createReadOnlyReviewRunner({
      client,
      model: "test",
      cwd: "/tmp",
    });

    const result = await runner.run(reviewRequest);
    expect(result.verdict).toBe("approve");
    expect(toolNames).toContain("read_file");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("edit_file");
  });

  test("approve 但 acceptance coverage 不完整时被系统拒绝", () => {
    const result = parseReviewResult(
      JSON.stringify({
        verdict: "approve",
        criteriaCoverage: [],
        findings: [],
        unresolvedQuestions: [],
      }),
    );
    expect(reviewResultRejection(result, ["测试通过"])).toEqual([
      "验收条件未被证明：测试通过",
    ]);
  });
});
