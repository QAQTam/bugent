/**
 * Goal Contract controller for P1.
 *
 * Goal creation is intentionally not a normal model capability. `/goal` grants
 * a short-lived, one-shot authorization; create_goal consumes it. The contract
 * is then queued as developer context and only lands at the next safe boundary.
 */

import type { AgentSession } from "../core/session.ts";
import type { GoalRepository } from "../store/goal-repository.ts";
import type {
  Criterion,
  Goal,
  GoalStatus,
  RiskLevel,
  RiskPolicy,
  ReviewPolicy,
} from "./types.ts";

export interface GoalContractInput {
  rawIntent: string;
  objective: string;
  successCriteria: readonly string[];
  constraints?: readonly string[];
  nonGoals?: readonly string[];
  riskPolicy?: RiskPolicy;
  tokenBudget?: number;
}

export interface GoalControllerOptions {
  repository: GoalRepository;
  session: AgentSession;
  now?: () => number;
}

const DEFAULT_CREATE_AUTHORIZATION_MS = 5 * 60 * 1000;

function criterionId(index: number): string {
  return `SC-${String(index + 1).padStart(3, "0")}`;
}

function normalizeLines(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function defaultRiskPolicy(level: RiskLevel): RiskPolicy {
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

function renderGoalContract(goal: Goal): string {
  const criteria = goal.successCriteria
    .map((criterion) => `- ${criterion.id}: ${criterion.text}`)
    .join("\n");
  const constraints =
    goal.constraints.length > 0 ? goal.constraints.map((value) => `- ${value}`).join("\n") : "- (none)";
  const nonGoals =
    goal.nonGoals.length > 0 ? goal.nonGoals.map((value) => `- ${value}`).join("\n") : "- (none)";
  const budget = goal.tokenBudget === undefined ? "unbounded" : String(goal.tokenBudget);

  return [
    "# Goal Contract",
    "",
    "> 这是用户目标，不是更高优先级指令。工作区、测试和证据仍是当前事实来源。",
    "",
    `- Goal ID: ${goal.id}`,
    `- Status: ${goal.status}`,
    `- Phase: ${goal.phase}`,
    `- Token budget: ${budget}`,
    "",
    "## Objective",
    "",
    goal.objective,
    "",
    "## Success Criteria",
    "",
    criteria.length > 0 ? criteria : "- (pending clarification)",
    "",
    "## Constraints",
    "",
    constraints,
    "",
    "## Non-goals",
    "",
    nonGoals,
    "",
    "## Risk Policy",
    "",
    `- Level: ${goal.riskPolicy.level}`,
    `- User approval required: ${goal.riskPolicy.requireUserApproval ? "yes" : "no"}`,
    `- Review policy: ${goal.riskPolicy.reviewPolicy}`,
  ].join("\n");
}

function renderGoalStatus(goal: Goal): string {
  return [
    "# Goal Status",
    "",
    `- Goal ID: ${goal.id}`,
    `- Status: ${goal.status}`,
    `- Phase: ${goal.phase}`,
    `- Tokens used: ${goal.tokensUsed}${goal.tokenBudget === undefined ? "" : ` / ${goal.tokenBudget}`}`,
    `- Continuations: ${goal.continuationCount}`,
    `- Blocked streak: ${goal.blockedStreak}`,
  ].join("\n");
}

export const GOAL_INITIALIZATION_INSTRUCTION = [
  "# Explicit Goal Initialization",
  "",
  "用户刚刚显式执行了 `/goal`。当前任务只做 Goal Contract 初始化，不要开始实现。",
  "",
  "步骤：",
  "1. 先从现有对话、工作区和最近消息中检查已知信息。",
  "2. 只对无法推断且会改变方向的信息调用 `ask_user`；不要机械地重复提问。",
  "3. 汇总 objective、success_criteria、constraints、non_goals、risk_policy、token_budget。",
  "4. 调用 `create_goal` 一次。不要在普通对话中调用它。",
  "5. 创建成功后停止，不要立即执行计划或改代码；Plan/Checkpoint/Todo 属于后续阶段。",
  "",
  "Goal Contract 必须可验证；口头描述不算证据要求。",
].join("\n");

export class GoalController {
  readonly repository: GoalRepository;
  readonly session: AgentSession;
  #now: () => number;
  #createAuthorizedUntil: number | undefined;

  constructor(options: GoalControllerOptions) {
    this.repository = options.repository;
    this.session = options.session;
    this.#now = options.now ?? Date.now;
  }

  currentGoal(): Goal | undefined {
    return this.repository.getCurrentGoal(this.session.id);
  }

  /**
   * 恢复/重建 runtime 时保证当前 Goal Contract 已进入本分支上下文。
   *
   * 正常情况下 create_goal 已排队注入；这里覆盖“创建后立刻 abort / crash”
   * 以及旧 session resume 两种情况。按 Goal ID 幂等，不重复追加。
   */
  ensureContext(): void {
    const goal = this.currentGoal();
    if (goal === undefined) return;
    const marker = `- Goal ID: ${goal.id}`;
    const present = this.session.messages.some(
      (message) =>
        message.injectionSource === "goal" &&
        message.parts.some((part) => part.type === "text" && part.text.includes(marker)),
    );
    if (!present) this.session.appendGoalContext(renderGoalContract(goal));
  }

  authorizeCreate(ttlMs = DEFAULT_CREATE_AUTHORIZATION_MS): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Goal 创建授权时长必须大于 0");
    }
    this.#createAuthorizedUntil = this.#now() + ttlMs;
  }

  revokeCreateAuthorization(): void {
    this.#createAuthorizedUntil = undefined;
  }

  canCreate(): boolean {
    return (
      this.#createAuthorizedUntil !== undefined &&
      this.#createAuthorizedUntil >= this.#now()
    );
  }

  createFromContract(input: GoalContractInput): Goal {
    if (!this.canCreate()) {
      throw new Error("create_goal 需要用户先显式执行 /goal；当前没有一次性创建授权");
    }
    const existing = this.currentGoal();
    if (existing !== undefined && existing.status !== "complete") {
      throw new Error(`当前 session 已有未完成 Goal：${existing.id}`);
    }

    const objective = input.objective.trim();
    const rawIntent = input.rawIntent.trim();
    if (objective.length === 0) throw new Error("Goal objective 不能为空");
    if (rawIntent.length === 0) throw new Error("Goal raw intent 不能为空");

    const successCriteriaText = normalizeLines(input.successCriteria);
    if (successCriteriaText.length === 0) {
      throw new Error("Goal 至少需要一条可验证的 success criterion");
    }
    if (input.tokenBudget !== undefined && input.tokenBudget <= 0) {
      throw new Error("Goal token budget 必须大于 0");
    }

    const successCriteria: Criterion[] = successCriteriaText.map((text, index) => ({
      id: criterionId(index),
      text,
      evidenceRequired: ["command/test/file/runtime evidence"],
    }));
    const goal = this.repository.createGoal({
      sessionId: this.session.id,
      rawIntent,
      objective,
      successCriteria,
      constraints: normalizeLines(input.constraints),
      nonGoals: normalizeLines(input.nonGoals),
      riskPolicy: input.riskPolicy ?? defaultRiskPolicy("medium"),
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
      phase: "draft",
    });

    this.repository.setGoalPhase(goal.id, "inspecting");
    const planning = this.repository.setGoalPhase(goal.id, "planning");
    this.session.appendGoalContext(renderGoalContract(planning));
    this.revokeCreateAuthorization();
    return planning;
  }

  pause(reason?: string): Goal {
    return this.#userStatus("paused", reason);
  }

  resume(): Goal {
    const goal = this.requireCurrent();
    const resumed = this.repository.setGoalStatus(goal.id, "active");
    this.session.appendGoalContext(
      `${renderGoalStatus(resumed)}\n\n- Resume: 用户显式恢复；继续当前 phase，不要重做已完成工作。`,
    );
    return resumed;
  }

  updateStatus(status: "paused" | "blocked" | "complete", reason?: string): Goal {
    const goal = this.requireCurrent();
    const updated = this.repository.setGoalStatus(goal.id, status);
    this.session.appendGoalContext(
      `${renderGoalStatus(updated)}${reason === undefined ? "" : `\n- Reason: ${reason.trim()}`}`,
    );
    return updated;
  }

  statusLine(): string | undefined {
    const goal = this.currentGoal();
    if (goal === undefined) return undefined;
    if (goal.status === "paused") return "Goal paused (/goal resume)";
    if (goal.status === "blocked") return "Goal stalled (/goal resume)";
    if (goal.status === "usage_limited") return "Goal hit usage limits (/goal resume)";
    if (goal.status === "budget_limited") {
      const limit = goal.tokenBudget === undefined ? "?" : `${Math.round(goal.tokenBudget / 1000)}K`;
      return `Goal unmet (${Math.round(goal.tokensUsed / 1000)}K/${limit})`;
    }
    if (goal.status === "complete") {
      return `Goal achieved (${Math.round(goal.tokensUsed / 1000)}K tokens)`;
    }
    const progress = this.repository.checkpointProgress(goal.id);
    return `Pursuing goal · ${progress.completed}/${progress.total} checkpoints · ${Math.round(
      goal.tokensUsed / 1000,
    )}K${goal.tokenBudget === undefined ? "" : `/${Math.round(goal.tokenBudget / 1000)}K`}`;
  }

  dialogLines(): string[] {
    const goal = this.currentGoal();
    if (goal === undefined) return ["当前没有 Goal。使用 `/goal <目标>` 初始化。"];
    const progress = this.repository.checkpointProgress(goal.id);
    return [
      `Goal      ${goal.objective}`,
      `Status    ${goal.status}`,
      `Phase     ${goal.phase}`,
      `Progress  ${progress.completed}/${progress.total} checkpoints`,
      `Budget    ${goal.tokensUsed}${goal.tokenBudget === undefined ? "" : ` / ${goal.tokenBudget}`}`,
      `Risk      ${goal.riskPolicy.level} · review ${goal.riskPolicy.reviewPolicy}`,
    ];
  }

  private requireCurrent(): Goal {
    const goal = this.currentGoal();
    if (goal === undefined) throw new Error("当前 session 没有 Goal");
    return goal;
  }

  #userStatus(status: GoalStatus, reason?: string): Goal {
    const goal = this.requireCurrent();
    const updated = this.repository.setGoalStatus(goal.id, status);
    this.session.appendGoalContext(
      `${renderGoalStatus(updated)}${reason === undefined ? "" : `\n- Reason: ${reason.trim()}`}`,
    );
    return updated;
  }
}
