/**
 * Goal contract tools.
 *
 * `create_goal` is deliberately inert until `/goal` grants a one-shot
 * authorization. This keeps ordinary model turns from inventing persistent
 * goals while still letting the model compile a contract during explicit
 * initialization.
 */

import type { GoalController } from "../goal/controller.ts";
import type { RiskLevel, RiskPolicy, ReviewPolicy } from "../goal/types.ts";
import type { JSONSchema } from "../provider/types.ts";
import type { Tool, ToolCtx } from "./types.ts";

export const GET_GOAL_TOOL_NAME = "get_goal";
export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";

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

  return [getGoal, createGoal, updateGoal];
}
