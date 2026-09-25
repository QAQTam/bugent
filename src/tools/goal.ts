/**
 * Goal contract tools.
 *
 * `create_goal` is deliberately inert until `/goal` grants a one-shot
 * authorization. This keeps ordinary model turns from inventing persistent
 * goals while still letting the model compile a contract during explicit
 * initialization.
 */

import type { GoalController } from "../goal/controller.ts";
import type {
  EvidenceKind,
  RiskLevel,
  RiskPolicy,
  ReviewPolicy,
} from "../goal/types.ts";
import type { HandoffNarrativeSection } from "../goal/handoff.ts";
import type { JSONSchema } from "../provider/types.ts";
import type { Tool, ToolCtx } from "./types.ts";

export const GET_GOAL_TOOL_NAME = "get_goal";
export const CREATE_GOAL_TOOL_NAME = "create_goal";
export const UPDATE_GOAL_TOOL_NAME = "update_goal";
export const UPDATE_PLAN_TOOL_NAME = "update_plan";
export const SUBMIT_CHECKPOINT_TOOL_NAME = "submit_checkpoint";
export const FINAL_AUDIT_TOOL_NAME = "final_audit";
export const GET_HANDOFF_TOOL_NAME = "get_handoff";
export const HANDOFF_UPDATE_TOOL_NAME = "handoff_update";

const HANDOFF_SECTIONS: readonly HandoffNarrativeSection[] = [
  "work_log",
  "decisions",
  "risks",
  "open_questions",
  "file_map",
];

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
    raw_intent: { type: "string", description: "The user's original intent, verbatim." },
    objective: { type: "string", description: "Clear, non-reducible end goal." },
    success_criteria: {
      type: "array",
      description: "Verifiable success criteria. Each must be provable by evidence.",
      items: { type: "string" },
    },
    constraints: {
      type: "array",
      description: "Constraints that must be respected.",
      items: { type: "string" },
    },
    non_goals: {
      type: "array",
      description: "Explicit non-goals.",
      items: { type: "string" },
    },
    risk_level: {
      type: "string",
      enum: [...RISK_LEVELS],
      description: "Risk level. high and critical require user approval.",
    },
    token_budget: {
      type: "integer",
      description: "Optional token budget. Must be greater than 0.",
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
      description: "Only paused, blocked, or complete. Resuming is user-controlled.",
    },
    reason: { type: "string", description: "Optional reason for the status change." },
  },
  required: ["status"],
};

const UPDATE_PLAN_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    phases: {
      type: "array",
      description: "Plan phases. Each phase needs at least one checkpoint.",
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
      description: "Required on the first update_plan; later revisions reuse the frozen checkpoints.",
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
    checkpoint_id: { type: "string", description: "Active checkpoint ID." },
    summary: { type: "string", description: "Short summary of this submission." },
    evidence: {
      type: "array",
      description: "Verifiable evidence. Command evidence needs command and exit_code=0.",
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
            description: "Command, file path, diff hash, or other locator.",
          },
          digest: { type: "string", description: "Optional sha256 for file evidence." },
          command: { type: "string", description: "Required for test, command, and runtime evidence." },
          exit_code: { type: "integer", description: "Command exit code. Must be 0." },
        },
        required: ["kind", "summary", "reference"],
      },
    },
    remaining_risk: {
      type: "array",
      description: "Known unresolved risks.",
      items: { type: "string" },
    },
  },
  required: ["checkpoint_id", "summary", "evidence"],
};

const GET_HANDOFF_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    epoch_id: {
      type: "string",
      description: "Omit to read the latest revision; provide to read a frozen snapshot.",
    },
  },
};

const FINAL_AUDIT_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {},
};

const HANDOFF_UPDATE_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    base_revision: { type: "integer", description: "Must match the current revision." },
    patches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          section: { type: "string", enum: [...HANDOFF_SECTIONS] },
          operation: { type: "string", enum: ["append", "correct"] },
          content: { type: "string" },
          target: { type: "string", description: "Entry id being corrected." },
          reason: { type: "string", description: "Required when operation is correct." },
          evidence: { type: "array", items: { type: "string" } },
        },
        required: ["section", "operation", "content"],
      },
    },
  },
  required: ["base_revision", "patches"],
};

export function createGoalTools(controller: GoalController): Tool[] {
  const getGoal: Tool<Record<string, never>, unknown> = {
    name: GET_GOAL_TOOL_NAME,
    description: "Read the current goal: contract, status, phase, budget, and checkpoint progress.",
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
    description: "Create the persistent goal contract. Only available right after the user runs `/goal`.",
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
    description: "Update goal status. Allowed values: paused, blocked, complete.",
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
    description: "Submit a plan revision with phases and checkpoints. The first call must include checkpoints.",
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
    description: "Submit the active checkpoint with evidence for verification and review.",
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

  const getHandoff: Tool<unknown, unknown> = {
    name: GET_HANDOFF_TOOL_NAME,
    description:
      "Read the canonical handoff snapshot, or a frozen one by epoch_id.",
    parameters: GET_HANDOFF_PARAMETERS,
    defaultPermission: "allow",
    resources() {
      return [{ key: "goal", access: "read" }];
    },
    describe(input: unknown) {
      const source = record(input, "get_handoff input");
      const epochId = source.epoch_id;
      if (epochId !== undefined && typeof epochId !== "string") {
        throw new Error("epoch_id 必须是字符串");
      }
      return {
        resource: typeof epochId === "string" ? `epoch ${epochId}` : "canonical handoff",
        summary: typeof epochId === "string" ? "读取 Handoff snapshot" : "读取最新 Handoff",
      };
    },
    async run(input: unknown): Promise<unknown> {
      const source = record(input, "get_handoff input");
      const epochId = source.epoch_id;
      if (epochId !== undefined && typeof epochId !== "string") {
        throw new Error("epoch_id 必须是字符串");
      }
      const handoff = await controller.getHandoff(
        typeof epochId === "string" ? epochId : undefined,
      );
      if (handoff === undefined) return { handoff: null };
      return {
        revision: handoff.revision.revision,
        snapshot: handoff.snapshot,
        snapshotHash: handoff.revision.snapshotHash ?? null,
        markdown: handoff.markdown,
      };
    },
  };

  const handoffUpdate: Tool<unknown, unknown> = {
    name: HANDOFF_UPDATE_TOOL_NAME,
    description: "Update narrative sections of the handoff snapshot with a structured patch.",
    parameters: HANDOFF_UPDATE_PARAMETERS,
    defaultPermission: "allow",
    resources() {
      return [{ key: "goal", access: "write" }];
    },
    describe(input: unknown) {
      const source = record(input, "handoff_update input");
      const count = Array.isArray(source.patches) ? source.patches.length : 0;
      return { resource: "canonical handoff", summary: `更新 Handoff（${count} patches）` };
    },
    async run(input: unknown): Promise<unknown> {
      const source = record(input, "handoff_update input");
      const baseRevision = source.base_revision;
      if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision)) {
        throw new Error("base_revision 必须是整数");
      }
      const patches = objects(source, "patches").map((patch, index) => {
        const section = requiredString(patch, "section");
        if (!HANDOFF_SECTIONS.includes(section as HandoffNarrativeSection)) {
          throw new Error(`patches[${index}].section 不允许：${section}`);
        }
        const operation = requiredString(patch, "operation");
        if (operation !== "append" && operation !== "correct") {
          throw new Error(`patches[${index}].operation 非法：${operation}`);
        }
        const target = patch.target;
        if (target !== undefined && typeof target !== "string") {
          throw new Error(`patches[${index}].target 必须是字符串`);
        }
        const reason = patch.reason;
        if (reason !== undefined && typeof reason !== "string") {
          throw new Error(`patches[${index}].reason 必须是字符串`);
        }
        if (operation === "correct" && (typeof target !== "string" || target.trim().length === 0)) {
          throw new Error(`patches[${index}] correction 必须提供 target`);
        }
        if (operation === "correct" && (typeof reason !== "string" || reason.trim().length === 0)) {
          throw new Error(`patches[${index}] correction 必须提供 reason`);
        }
        const evidence = optionalStrings(patch, "evidence");
        return {
          section: section as HandoffNarrativeSection,
          operation: operation as "append" | "correct",
          content: requiredString(patch, "content"),
          ...(typeof target === "string" ? { target } : {}),
          ...(typeof reason === "string" ? { reason } : {}),
          ...(evidence !== undefined ? { evidence } : {}),
        };
      });
      const updated = await controller.applyHandoffPatches(baseRevision, "worker", patches);
      return {
        updated: true,
        revision: updated.revision,
        snapshotHash: updated.snapshotHash ?? null,
      };
    },
  };

  const finalAudit: Tool<Record<string, never>, unknown> = {
    name: FINAL_AUDIT_TOOL_NAME,
    description: "Request the final independent audit of the goal against its success criteria.",
    parameters: FINAL_AUDIT_PARAMETERS,
    defaultPermission: "allow",
    resources() {
      return [{ key: "goal", access: "write" }];
    },
    describe() {
      return { resource: "current goal", summary: "执行 Goal final audit" };
    },
    async run(): Promise<unknown> {
      const result = await controller.finalAudit();
      return {
        approved: result.approved,
        reviewId: result.review.id,
        status: result.review.status,
        verdict: result.review.verdict ?? null,
        errors: result.errors,
      };
    },
  };

  return [
    getGoal,
    createGoal,
    updateGoal,
    updatePlan,
    submitCheckpoint,
    finalAudit,
    getHandoff,
    handoffUpdate,
  ];
}
