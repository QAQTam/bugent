/**
 * Goal Contract controller for P1.
 *
 * Goal creation is intentionally not a normal model capability. `/goal` grants
 * a short-lived, one-shot authorization; create_goal consumes it. The contract
 * is then queued as developer context and only lands at the next safe boundary.
 */

import type { AgentSession } from "../core/session.ts";
import { createHash } from "node:crypto";
import type {
  CheckpointDefinition,
  GoalRepository,
} from "../store/goal-repository.ts";
import type {
  Checkpoint,
  Criterion,
  Goal,
  GoalReview,
  GoalStatus,
  GoalTodo,
  PlanPhase,
  PlanRevision,
  RiskLevel,
  RiskPolicy,
  ReviewPolicy,
  TodoSnapshot,
} from "./types.ts";
import {
  reviewResultRejection,
  withForcedRejection,
  type ReviewRunner,
} from "./review.ts";
import {
  verifyCheckpointDeterministically,
  type VerificationEvidenceInput,
} from "./verification.ts";

export interface GoalContractInput {
  rawIntent: string;
  objective: string;
  successCriteria: readonly string[];
  constraints?: readonly string[];
  nonGoals?: readonly string[];
  riskPolicy?: RiskPolicy;
  tokenBudget?: number;
}

export interface GoalPlanInput {
  phases: readonly PlanPhase[];
  checkpoints?: readonly CheckpointDefinition[];
  assumptions?: readonly string[];
}

export interface GoalTodoInput {
  checkpointId: string;
  summary?: string;
  todos: readonly Omit<GoalTodo, "checkpointId">[];
}

export interface SubmitCheckpointInput {
  checkpointId: string;
  summary: string;
  evidence: readonly VerificationEvidenceInput[];
  remainingRisk?: readonly string[];
}

export interface GoalControllerOptions {
  repository: GoalRepository;
  session: AgentSession;
  cwd?: string;
  reviewRunner?: ReviewRunner;
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

function renderPlan(plan: PlanRevision, checkpoints: readonly Checkpoint[]): string {
  const phases = plan.phases
    .map((phase) => {
      const checkpointList = phase.checkpointIds.join(", ") || "(none)";
      return `- ${phase.id} · ${phase.title}: ${phase.objective}\n  Checkpoints: ${checkpointList}\n  Verification: ${
        phase.verification.join("; ") || "(pending)"
      }`;
    })
    .join("\n");
  const checkpointList = checkpoints
    .map(
      (checkpoint) =>
        `- ${checkpoint.order}. ${checkpoint.title} [${checkpoint.status}]\n` +
        `  Deliverable: ${checkpoint.deliverable}\n` +
        `  Acceptance: ${checkpoint.acceptanceCriteria.join("; ")}\n` +
        `  Evidence required: ${checkpoint.evidenceRequired.join("; ")}`,
    )
    .join("\n");

  return [
    "# Goal Plan",
    "",
    `- Goal ID: ${plan.goalId}`,
    `- Plan revision: ${plan.revision}`,
    "",
    "## Phases",
    "",
    phases,
    "",
    "## Checkpoints",
    "",
    checkpointList,
    "",
    "## Assumptions",
    "",
    plan.assumptions.length > 0
      ? plan.assumptions.map((assumption) => `- ${assumption}`).join("\n")
      : "- (none)",
  ].join("\n");
}

function renderCheckpointTodo(
  checkpoint: Checkpoint,
  snapshot: TodoSnapshot,
): string {
  const todos = snapshot.todos
    .map((todo) => {
      const evidence =
        todo.completionEvidence === undefined || todo.completionEvidence.length === 0
          ? ""
          : ` · evidence: ${todo.completionEvidence.join("; ")}`;
      return `- [${todo.status}] ${todo.id}: ${todo.content}${evidence}`;
    })
    .join("\n");
  return [
    "# Current Goal Checkpoint",
    "",
    `- Checkpoint ID: ${checkpoint.id}`,
    `- Order: ${checkpoint.order}`,
    `- Title: ${checkpoint.title}`,
    `- Deliverable: ${checkpoint.deliverable}`,
    `- Acceptance: ${checkpoint.acceptanceCriteria.join("; ")}`,
    `- Evidence required: ${checkpoint.evidenceRequired.join("; ")}`,
    "",
    `## Todo Snapshot ${snapshot.revision}`,
    "",
    todos,
    "",
    "Todo 完成不等于 Checkpoint 完成；Checkpoint 仍需 verifier/review。",
  ].join("\n");
}

interface WorkspaceRevision {
  base: string;
  head: string;
  diffHash: string;
}

function captureWorkspaceRevision(cwd: string): WorkspaceRevision {
  const headResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (headResult.exitCode !== 0) {
    return { base: "unknown", head: "unknown", diffHash: "unknown" };
  }
  const head = headResult.stdout.toString().trim();
  const diffResult = Bun.spawnSync(["git", "diff", "--no-ext-diff", "--binary", "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (diffResult.exitCode !== 0) {
    return { base: head, head: head, diffHash: `head:${head}` };
  }
  const diff = diffResult.stdout;
  const diffHash =
    diff.byteLength === 0
      ? `head:${head}`
      : `sha256:${createHash("sha256").update(diff).digest("hex")}`;
  return {
    base: head,
    head: diff.byteLength === 0 ? head : `${head}+worktree`,
    diffHash,
  };
}

function renderReviewDecision(review: GoalReview): string {
  const coverage = review.criteriaCoverage
    .map((item) => `- ${item.status}: ${item.criterion}`)
    .join("\n");
  return [
    "# Goal Review Result",
    "",
    `- Review ID: ${review.id}`,
    `- Checkpoint ID: ${review.checkpointId}`,
    `- Round: ${review.round}`,
    `- Status: ${review.status}`,
    `- Verdict: ${review.verdict ?? "(pending)"}`,
    "",
    "## Criteria Coverage",
    "",
    coverage.length > 0 ? coverage : "- (none)",
    "",
    "## Unresolved Questions",
    "",
    review.unresolvedQuestions.length > 0
      ? review.unresolvedQuestions.map((question) => `- ${question}`).join("\n")
      : "- (none)",
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
  readonly cwd: string;
  readonly reviewRunner: ReviewRunner | undefined;
  #now: () => number;
  #createAuthorizedUntil: number | undefined;

  constructor(options: GoalControllerOptions) {
    this.repository = options.repository;
    this.session = options.session;
    this.cwd = options.cwd ?? process.cwd();
    this.reviewRunner = options.reviewRunner;
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

    const plan = this.repository.latestPlanRevision(goal.id);
    if (plan !== undefined) {
      const planMarker = `- Plan revision: ${plan.revision}`;
      const planPresent = this.session.messages.some(
        (message) =>
          message.injectionSource === "plan" &&
          message.parts.some((part) => part.type === "text" && part.text.includes(planMarker)),
      );
      if (!planPresent) {
        this.session.enqueueInjection(
          renderPlan(plan, this.repository.listCheckpoints(goal.id)),
          "plan",
        );
      }
    }

    const checkpoint =
      goal.activeCheckpointId === undefined
        ? undefined
        : this.repository.getCheckpoint(goal.activeCheckpointId);
    if (checkpoint === undefined) return;
    const todo = this.repository.latestTodoSnapshot(goal.id, checkpoint.id);
    if (todo === undefined) return;
    const checkpointMarker = `## Todo Snapshot ${todo.revision}`;
    const checkpointPresent = this.session.messages.some(
      (message) =>
        message.injectionSource === "checkpoint" &&
        message.parts.some(
          (part) => part.type === "text" && part.text.includes(checkpointMarker),
        ),
    );
    if (!checkpointPresent) {
      this.session.enqueueInjection(renderCheckpointTodo(checkpoint, todo), "checkpoint");
    }
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

  /**
   * 第一次 update_plan 原子创建 Plan + Checkpoint DAG，后续 revision 只能
   * 在尚未执行时重写策略；Checkpoint 集合当前不可中途替换。
   */
  applyPlan(input: GoalPlanInput): { plan: PlanRevision; checkpoints: Checkpoint[] } {
    const goal = this.requireCurrent();
    if (goal.status !== "active") throw new Error(`Goal 当前不是 active：${goal.status}`);
    if (goal.phase !== "planning" && goal.phase !== "ready") {
      throw new Error(`只有 planning/ready 阶段可以更新 Plan，当前为 ${goal.phase}`);
    }

    const existing = this.repository.latestPlanRevision(goal.id);
    let plan: PlanRevision;
    let checkpoints: Checkpoint[];
    if (existing === undefined) {
      if (input.checkpoints === undefined || input.checkpoints.length === 0) {
        throw new Error("首次 update_plan 必须提供 checkpoints");
      }
      const created = this.repository.createInitialPlan(goal.id, {
        phases: input.phases,
        checkpoints: input.checkpoints,
        ...(input.assumptions !== undefined ? { assumptions: input.assumptions } : {}),
      });
      plan = created.plan;
      checkpoints = created.checkpoints;
      this.repository.setGoalPhase(goal.id, "ready");
    } else {
      if (input.checkpoints !== undefined) {
        throw new Error("Checkpoint 集合已冻结；后续 update_plan 只能更新 phases/assumptions");
      }
      plan = this.repository.appendPlanRevision(goal.id, {
        phases: input.phases,
        ...(input.assumptions !== undefined ? { assumptions: input.assumptions } : {}),
      });
      checkpoints = this.repository.listCheckpoints(goal.id);
    }

    this.session.enqueueInjection(renderPlan(plan, checkpoints), "plan");
    return { plan, checkpoints };
  }

  /**
   * Goal 模式 todo 只写当前 Checkpoint。第一次写入会激活第一个 Checkpoint，
   * 并把 Goal 从 ready 推进到 executing。
   */
  writeTodos(input: GoalTodoInput): TodoSnapshot {
    const goal = this.requireCurrent();
    if (goal.status !== "active") throw new Error(`Goal 当前不是 active：${goal.status}`);
    if (goal.phase !== "ready" && goal.phase !== "executing") {
      throw new Error(`只有 ready/executing 阶段可以写 Todo，当前为 ${goal.phase}`);
    }
    const plan = this.repository.latestPlanRevision(goal.id);
    if (plan === undefined) throw new Error("写 Todo 前必须先建立 Plan");

    const checkpoint = this.repository.requireCheckpoint(input.checkpointId);
    if (checkpoint.goalId !== goal.id) {
      throw new Error(`Checkpoint ${checkpoint.id} 不属于当前 Goal`);
    }
    if (goal.activeCheckpointId === undefined) {
      const firstPending = this.repository
        .listCheckpoints(goal.id)
        .find((candidate) => candidate.status === "pending");
      if (firstPending?.id !== checkpoint.id) {
        throw new Error(`Todo 必须属于第一个可执行 Checkpoint：${firstPending?.id ?? "(none)"}`);
      }
      this.repository.activateCheckpoint(checkpoint.id);
      this.repository.setGoalPhase(goal.id, "executing");
    } else if (goal.activeCheckpointId !== checkpoint.id) {
      throw new Error(`Todo 只能写入当前 Checkpoint：${goal.activeCheckpointId}`);
    }

    const snapshot = this.repository.replaceTodoSnapshot(goal.id, {
      checkpointId: checkpoint.id,
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      todos: input.todos,
    });
    const current = this.repository.requireCheckpoint(checkpoint.id);
    this.session.enqueueInjection(renderCheckpointTodo(current, snapshot), "checkpoint");
    return snapshot;
  }

  async submitCheckpoint(input: SubmitCheckpointInput): Promise<{
    review: GoalReview;
    checkpoint: Checkpoint;
    nextCheckpointId?: string;
  }> {
    const goal = this.requireCurrent();
    if (goal.status !== "active") throw new Error(`Goal 当前不是 active：${goal.status}`);
    if (goal.phase !== "executing") {
      throw new Error(`只有 executing 阶段可以提交 Checkpoint，当前为 ${goal.phase}`);
    }
    if (goal.activeCheckpointId !== input.checkpointId) {
      throw new Error(`只能提交当前 Checkpoint：${goal.activeCheckpointId ?? "(none)"}`);
    }
    const checkpoint = this.repository.requireCheckpoint(input.checkpointId);
    if (checkpoint.status !== "active") {
      throw new Error(`Checkpoint 当前不是 active：${checkpoint.status}`);
    }
    const todo = this.repository.latestTodoSnapshot(goal.id, checkpoint.id);
    if (todo === undefined) throw new Error("提交 Checkpoint 前必须建立 Todo snapshot");

    const verification = await verifyCheckpointDeterministically({
      checkpoint,
      todos: todo.todos,
      evidence: input.evidence,
      cwd: this.cwd,
    });
    if (!verification.ok) {
      throw new Error(`确定性验证失败：${verification.errors.join("；")}`);
    }

    const existingReviews = this.repository.listReviews(goal.id, checkpoint.id);
    const nextRound = existingReviews.length + 1;
    if (nextRound > 3) {
      throw new Error("Checkpoint 已达到 3 轮 review；需要用户决定如何继续");
    }

    const storedEvidence = input.evidence.map((evidence) =>
      this.repository.addEvidence(goal.id, {
        checkpointId: checkpoint.id,
        kind: evidence.kind,
        summary: evidence.summary,
        reference: evidence.reference,
        ...(evidence.digest !== undefined ? { digest: evidence.digest } : {}),
        ...(evidence.command !== undefined ? { command: evidence.command } : {}),
        ...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
      }),
    );
    const revision = captureWorkspaceRevision(this.cwd);
    const review = this.repository.createReview(goal.id, {
      checkpointId: checkpoint.id,
      round: nextRound,
      reviewer: "read-only-reviewer",
      baseRevision: revision.base,
      headRevision: revision.head,
      diffHash: revision.diffHash,
      criteriaCoverage: checkpoint.acceptanceCriteria.map((criterion) => ({
        criterion,
        status: "missing",
        evidence: [],
      })),
    });

    this.repository.setCheckpointStatus(checkpoint.id, "verifying");
    if (goal.riskPolicy.reviewPolicy === "off") {
      this.repository.setCheckpointStatus(checkpoint.id, "reviewing");
      const completed = this.repository.completeReview(review.id, {
        verdict: "approve",
        criteriaCoverage: checkpoint.acceptanceCriteria.map((criterion) => ({
          criterion,
          status: "proven",
          evidence: storedEvidence.map((evidence) => evidence.id),
        })),
        findings: [],
        unresolvedQuestions: [],
      });
      const finished = this.repository.setCheckpointStatus(checkpoint.id, "completed");
      const next = this.repository
        .listCheckpoints(goal.id)
        .find((candidate) => candidate.status === "pending");
      this.repository.setGoalPhase(goal.id, "checkpoint_audit");
      if (next !== undefined) {
        this.repository.activateCheckpoint(next.id);
        this.repository.setGoalPhase(goal.id, "executing");
      }
      return {
        review: completed,
        checkpoint: finished,
        ...(next !== undefined ? { nextCheckpointId: next.id } : {}),
      };
    }

    if (this.reviewRunner === undefined) {
      throw new Error("当前没有独立 reviewer，不能通过该 Checkpoint");
    }
    this.repository.setReviewStatus(review.id, "running");
    this.repository.setCheckpointStatus(checkpoint.id, "reviewing");

    let result;
    try {
      result = await this.reviewRunner.run({
        goal,
        checkpoint,
        todos: todo.todos,
        evidence: storedEvidence,
        remainingRisk: input.remainingRisk ?? [],
        cwd: this.cwd,
        baseRevision: revision.base,
        headRevision: revision.head,
        diffHash: revision.diffHash,
      });
    } catch (error) {
      this.repository.setReviewStatus(review.id, "blocked");
      this.repository.setCheckpointStatus(checkpoint.id, "blocked");
      throw new Error(
        `reviewer 执行失败，Checkpoint 已阻塞：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const gateErrors = reviewResultRejection(result, checkpoint.acceptanceCriteria);
    const completedReview = this.repository.completeReview(
      review.id,
      withForcedRejection(result, gateErrors),
    );
    let updatedCheckpoint = this.repository.requireCheckpoint(checkpoint.id);
    let nextCheckpointId: string | undefined;

    if (completedReview.status === "approved") {
      updatedCheckpoint = this.repository.setCheckpointStatus(checkpoint.id, "completed");
      this.repository.setGoalPhase(goal.id, "checkpoint_audit");
      const next = this.repository
        .listCheckpoints(goal.id)
        .find((candidate) => candidate.status === "pending");
      if (next !== undefined) {
        nextCheckpointId = next.id;
        this.repository.activateCheckpoint(next.id);
        this.repository.setGoalPhase(goal.id, "executing");
      }
    } else {
      updatedCheckpoint = this.repository.requireCheckpoint(checkpoint.id);
    }

    this.session.enqueueInjection(renderReviewDecision(completedReview), "review");
    return {
      review: completedReview,
      checkpoint: updatedCheckpoint,
      ...(nextCheckpointId !== undefined ? { nextCheckpointId } : {}),
    };
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
    const review = this.repository.listReviews(goal.id).at(-1);
    return [
      `Goal      ${goal.objective}`,
      `Status    ${goal.status}`,
      `Phase     ${goal.phase}`,
      `Progress  ${progress.completed}/${progress.total} checkpoints`,
      `Review    ${
        review === undefined
          ? "(none)"
          : `${review.status} · round ${review.round}${review.verdict === undefined ? "" : ` · ${review.verdict}`}`
      }`,
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
