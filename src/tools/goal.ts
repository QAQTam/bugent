/**
 * Goal contract tools.
 *
 * `create_goal` is deliberately inert until `/goal` grants a one-shot
 * authorization. This keeps ordinary model turns from inventing persistent
 * goals while still letting the model compile a contract during explicit
 * initialization.
 */

import type { GoalController } from "../goal/controller.ts";
import type { EvidenceKind, RiskLevel, RiskPolicy, ReviewPolicy } from "../goal/types.ts";
import type { JSONSchema } from "../provider/types.ts";
import type { Tool, ToolCtx } from "./types.ts";

export const GET_GOAL_TOOL_NAME = "get_goal";
export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";
export const UPDATE_PLAN_TOOL_NAME = "update_plan";
export const SUBMIT_CHECKPOINT_TOOL_NAME = "submit_checkpoint";

const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "test",
  "command",
  "file",
  "diff",
  "runtime",
  "review",
  "user",
];

const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];
const UPDATE_STATUSES = ["paused", "blocked", "complete"] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} 必须是非空字符串`);
  }
  return value.trim();
}

function optionalStrings(source: Record<string, unknown>, key: string): string[] | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${key} 必须是字符串数组`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${key}[${index}] 必须是非空字符串`);
    }
    return item.trim();
  });
}

function requiredStrings(source: Record<string, unknown>, key: string): string[] {
  const values = optionalStrings(source, key);
  if (values === undefined || values.length === 0) {
    throw new Error(`${key} 至少需要一项`);
  }
  return values;
}

function objects(source: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = source[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} 必须是非空数组`);
  }
  return value.map((item, index) => record(item, `${key}[${index}]`));
}

function optionalObjects(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} 必须是非空数组`);
  }
  return value.map((item, index) => record(item, `${key}[${index}]`));
}

function riskPolicy(source: Record<string, unknown>): RiskPolicy | undefined {
  const raw = source.risk_level;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !RISK_LEVELS.includes(raw as RiskLevel)) {
    throw new Error(`risk_level 必须是 ${RISK_LEVELS.join(" / ")}`);
  }
  const level = raw as RiskLevel;
  const requireUserApproval = level === "high" || level === "critical";
  const reviewPolicy: ReviewPolicy =
    level === "critical" ? "always" : level === "high" ? "high" : "medium";
  return {
    level,
    requireUserApproval,
    reviewPolicy,
    notes: [],
  };
}

const GET_GOAL_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {},
};

const CREATE_GOAL_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    raw_intent: { type: "string", description: "用户最初的 Goal 原始意图" },
    objective: { type: "string", description: "清晰、不可缩小的最终目标" },
    success_criteria: {
      type: "array",
      description: "可验证的成功标准；每项必须能关联证据",
      items: { type: "string" },
    },
    constraints: {
      type: "array",
      description: "必须遵守的约束",
      items: { type: "string" },
    },
    non_goals: {
      type: "array",
      description: "明确不做的范围",
      items: { type: "string" },
    },
    risk_level: {
      type: "string",
      enum: [...RISK_LEVELS],
      description: "风险等级；high/critical 默认要求用户 gate",
    },
    token_budget: {
      type: "integer",
      description: "可选 token 预算；必须大于 0",
    },
  },
  required: ["raw_intent", "objective", "success_criteria"],
};

const UPDATE_GOAL_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: [...UPDATE_STATUSES],
      description: "模型只能提交 paused / blocked / complete；resume 由用户控制",
    },
    reason: { type: "string", description: "状态变更原因，可选" },
  },
  required: ["status"],
};

const UPDATE_PLAN_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    phases: {
      type: "array",
      description: "策略阶段；每个阶段至少关联一个 Checkpoint",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          objective: { type: "string" },
          checkpoint_ids: { type: "array", items: { type: "string" } },
          depends_on: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          verification: { type: "array", items: { type: "string" } },
        },
        required: ["id", "title", "objective", "checkpoint_ids", "verification"],
      },
    },
    checkpoints: {
      type: "array",
      description: "首次 update_plan 必须提供；后续策略 revision 省略并复用已冻结的 Checkpoint",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          order: { type: "integer" },
          title: { type: "string" },
          deliverable: { type: "string" },
          acceptance_criteria: { type: "array", items: { type: "string" } },
          evidence_required: { type: "array", items: { type: "string" } },
          depends_on: { type: "array", items: { type: "string" } },
        },
        required: [
          "order",
          "title",
          "deliverable",
          "acceptance_criteria",
          "evidence_required",
        ],
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
  },
  required: ["phases"],
};

const SUBMIT_CHECKPOINT_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    checkpoint_id: { type: "string", description: "当前 active Checkpoint ID" },
    summary: { type: "string", description: "本次提交的简短结果摘要" },
    evidence: {
      type: "array",
      description: "可核验的结构化证据；命令类必须带 command 和 exit_code=0",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [...EVIDENCE_KINDS],
          },
          summary: { type: "string" },
          reference: {
            type: "string",
            description: "命令、文件路径、diff hash 或其他可定位引用",
          },
          digest: { type: "string", description: "file 证据的 sha256，可选" },
          command: { type: "string", description: "test/command/runtime 证据必须提供" },
          exit_code: { type: "integer", description: "命令退出码；必须为 0" },
        },
        required: ["kind", "summary", "reference"],
      },
    },
    remaining_risk: {
      type: "array",
      description: "已识别但尚未解决的残余风险",
      items: { type: "string" },
    },
  },
  required: ["checkpoint_id", "summary", "evidence"],
};

export function createGoalTools(controller: GoalController): Tool[] {
  const getGoal: Tool<Record<string, never>, unknown> = {
    name: GET_GOAL_TOOL_NAME,
    description: "读取当前 session 的 Goal Contract、状态、phase、预算与 Checkpoint 进度。",
    parameters: GET_GOAL_PARAMETERS,
    defaultPermission: "allow",
    resources() {
      return [{ key: "goal", access: "read" }];
    },
    describe() {
      return { resource: "current goal", summary: "读取当前 Goal" };
    },
    async run(): Promise<unknown> {
      const goal = controller.currentGoal();
      if (goal === undefined) return { goal: null };
      return {
        goal,
        checkpointProgress: controller.repository.checkpointProgress(goal.id),
      };
    },
  };

  const createGoal: Tool<unknown, unknown> = {
    name: CREATE_GOAL_TOOL_NAME,
    description: [
      "把显式 `/goal` 初始化结果编译成持久 Goal Contract。",
      "只有在用户刚执行 `/goal` 且宿主授予一次性创建权限时可用。",
      "普通对话、普通任务和模型自行发现的“长期目标”都不得调用。",
    ].join("\n"),
    parameters: CREATE_GOAL_PARAMETERS,
    defaultPermission: "allow",
    resources() {
      return [{ key: "goal", access: "write" }];
    },
    describe(input: unknown) {
      const source = record(input, "create_goal input");
      const objective =
        typeof source.objective === "string" ? source.objective.trim() : "(invalid objective)";
      return { resource: "new goal", summary: `创建 Goal：${objective}` };
    },
    async run(input: unknown, _ctx: ToolCtx): Promise<unknown> {
      const source = record(input, "create_goal input");
      const criteria = optionalStrings(source, "success_criteria");
      if (criteria === undefined || criteria.length === 0) {
        throw new Error("success_criteria 至少需要一项");
      }
      const tokenBudget = source.token_budget;
      if (
        tokenBudget !== undefined &&
        (typeof tokenBudget !== "number" || !Number.isInteger(tokenBudget) || tokenBudget <= 0)
      ) {
        throw new Error("token_budget 必须是正整数");
      }
      const constraints = optionalStrings(source, "constraints");
      const nonGoals = optionalStrings(source, "non_goals");
      const policy = riskPolicy(source);

      const goal = controller.createFromContract({
        rawIntent: requiredString(source, "raw_intent"),
        objective: requiredString(source, "objective"),
        successCriteria: criteria,
        ...(constraints !== undefined ? { constraints } : {}),
        ...(nonGoals !== undefined ? { nonGoals } : {}),
        ...(policy !== undefined ? { riskPolicy: policy } : {}),
        ...(typeof tokenBudget === "number" ? { tokenBudget } : {}),
      });

      return {
        created: true,
        goalId: goal.id,
        status: goal.status,
        phase: goal.phase,
        note: "Goal Contract 将在下一个安全边界作为 developer context 注入。",
      };
    },
  };

  const updateGoal: Tool<unknown, unknown> = {
    name: UPDATE_GOAL_TOOL_NAME,
    description: [
      "提交 Goal 生命周期状态。模型只能提交 paused、blocked、complete。",
      "active/resume 只能由用户或系统控制；complete 必须通过 final audit 门禁。",
    ].join("\n"),
    parameters: UPDATE_GOAL_PARAMETERS,
    defaultPermission: "allow",
    resources() {
      return [{ key: "goal", access: "write" }];
    },
    describe(input: unknown) {
      const source = record(input, "update_goal input");
      const status = typeof source.status === "string" ? source.status : "invalid";
      return { resource: "current goal", summary: `更新 Goal 状态：${status}` };
    },
    async run(input: unknown, _ctx: ToolCtx): Promise<unknown> {
      const source = record(input, "update_goal input");
      const status = requiredString(source, "status");
      if (!UPDATE_STATUSES.includes(status as (typeof UPDATE_STATUSES)[number])) {
        throw new Error(`update_goal.status 只能是 ${UPDATE_STATUSES.join(" / ")}`);
      }
      const reason = source.reason;
      if (reason !== undefined && typeof reason !== "string") {
        throw new Error("update_goal.reason 必须是字符串");
      }
      const goal = controller.updateStatus(
        status as (typeof UPDATE_STATUSES)[number],
        reason?.trim() || undefined,
      );
      return { updated: true, goalId: goal.id, status: goal.status, phase: goal.phase };
    },
  };

  const updatePlan: Tool<unknown, unknown> = {
    name: UPDATE_PLAN_TOOL_NAME,
    description: [
      "为当前 Goal 提交 Plan revision 与 Checkpoint DAG。",
      "首次调用必须同时提供 checkpoints；后续 revision 只能更新 phases/assumptions。",
      "Checkpoint 必须是可验证的阶段结果，不能是“运行一次测试”这类微步骤。",
    ].join("\n"),
    parameters: UPDATE_PLAN_PARAMETERS,
    defaultPermission: "allow",
    resources() {
      return [{ key: "goal", access: "write" }];
    },
    describe(input: unknown) {
      const source = record(input, "update_plan input");
      const phaseCount = Array.isArray(source.phases) ? source.phases.length : 0;
      const checkpointCount = Array.isArray(source.checkpoints)
        ? source.checkpoints.length
        : 0;
      return {
        resource: "current goal plan",
        summary: `更新 Goal Plan（${phaseCount} phases / ${checkpointCount} checkpoints）`,
      };
    },
    async run(input: unknown, _ctx: ToolCtx): Promise<unknown> {
      const source = record(input, "update_plan input");
      const phases = objects(source, "phases").map((phase, index) => ({
        id: requiredString(phase, "id"),
        title: requiredString(phase, "title"),
        objective: requiredString(phase, "objective"),
        checkpointIds: requiredStrings(phase, "checkpoint_ids"),
        dependsOn: optionalStrings(phase, "depends_on") ?? [],
        risks: optionalStrings(phase, "risks") ?? [],
        verification: requiredStrings(phase, "verification"),
      }));
      const rawCheckpoints = optionalObjects(source, "checkpoints");
      const checkpoints =
        rawCheckpoints === undefined
          ? undefined
          : rawCheckpoints.map((checkpoint, index) => {
              const order = checkpoint.order;
              if (typeof order !== "number" || !Number.isInteger(order) || order <= 0) {
                throw new Error(`checkpoints[${index}].order 必须是正整数`);
              }
              const id = checkpoint.id;
              if (id !== undefined && typeof id !== "string") {
                throw new Error(`checkpoints[${index}].id 必须是字符串`);
              }
              return {
                ...(typeof id === "string" && id.trim().length > 0 ? { id: id.trim() } : {}),
                order,
                title: requiredString(checkpoint, "title"),
                deliverable: requiredString(checkpoint, "deliverable"),
                acceptanceCriteria: requiredStrings(checkpoint, "acceptance_criteria"),
                evidenceRequired: requiredStrings(checkpoint, "evidence_required"),
                dependsOn: optionalStrings(checkpoint, "depends_on") ?? [],
              };
            });
      const assumptions = optionalStrings(source, "assumptions");
      const applied = controller.applyPlan({
        phases,
        ...(checkpoints !== undefined ? { checkpoints } : {}),
        ...(assumptions !== undefined ? { assumptions } : {}),
      });
      const firstPending = applied.checkpoints.find(
        (checkpoint) => checkpoint.status === "pending",
      );
      return {
        planId: applied.plan.id,
        revision: applied.plan.revision,
        checkpoints: applied.checkpoints.map((checkpoint) => ({
          id: checkpoint.id,
          order: checkpoint.order,
          status: checkpoint.status,
        })),
        next: {
          action: "todo_write",
          checkpointId: firstPending?.id ?? null,
          note: "只为该 Checkpoint 生成 Todo；completed 项必须带 completionEvidence。",
        },
      };
    },
  };

  const submitCheckpoint: Tool<unknown, unknown> = {
    name: SUBMIT_CHECKPOINT_TOOL_NAME,
    description: [
      "提交当前 Goal Checkpoint 进行确定性验证和独立 review。",
      "只有所有 Todo 完成且带证据时才能提交；提交不等于完成，必须通过 verifier/review gate。",
    ].join("\n"),
    parameters: SUBMIT_CHECKPOINT_PARAMETERS,
    defaultPermission: "allow",
    resources() {
      return [{ key: "goal", access: "write" }];
    },
    describe(input: unknown) {
      const source = record(input, "submit_checkpoint input");
      const checkpointId =
        typeof source.checkpoint_id === "string" ? source.checkpoint_id : "(invalid)";
      return {
        resource: "current checkpoint",
        summary: `提交 Checkpoint：${checkpointId}`,
      };
    },
    async run(input: unknown, _ctx: ToolCtx): Promise<unknown> {
      const source = record(input, "submit_checkpoint input");
      const evidence = objects(source, "evidence").map((item, index) => {
        const kind = requiredString(item, "kind");
        if (!EVIDENCE_KINDS.includes(kind as EvidenceKind)) {
          throw new Error(`evidence[${index}].kind 非法：${kind}`);
        }
        const digest = item.digest;
        if (digest !== undefined && typeof digest !== "string") {
          throw new Error(`evidence[${index}].digest 必须是字符串`);
        }
        const command = item.command;
        if (command !== undefined && typeof command !== "string") {
          throw new Error(`evidence[${index}].command 必须是字符串`);
        }
        const exitCode = item.exit_code;
        if (exitCode !== undefined && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) {
          throw new Error(`evidence[${index}].exit_code 必须是整数`);
        }
        return {
          kind: kind as EvidenceKind,
          summary: requiredString(item, "summary"),
          reference: requiredString(item, "reference"),
          ...(typeof digest === "string" ? { digest } : {}),
          ...(typeof command === "string" ? { command } : {}),
          ...(typeof exitCode === "number" ? { exitCode } : {}),
        };
      });
      const remainingRisk = optionalStrings(source, "remaining_risk") ?? [];
      const result = await controller.submitCheckpoint({
        checkpointId: requiredString(source, "checkpoint_id"),
        summary: requiredString(source, "summary"),
        evidence,
        remainingRisk,
      });
      return {
        reviewId: result.review.id,
        reviewRound: result.review.round,
        reviewStatus: result.review.status,
        checkpointStatus: result.checkpoint.status,
        nextCheckpointId: result.nextCheckpointId ?? null,
      };
    },
  };

  return [getGoal, createGoal, updateGoal, updatePlan, submitCheckpoint];
}
