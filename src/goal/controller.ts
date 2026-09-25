/**
 * Goal Contract controller for P1.
 *
 * Goal creation is intentionally not a normal model capability. `/goal` grants
 * a short-lived, one-shot authorization; create_goal consumes it. The contract
 * is then queued as developer context and only lands at the next safe boundary.
 */

import { AgentSession } from "../core/session.ts";
import { storedText } from "../core/message.ts";
import type { Usage } from "../provider/types.ts";
import { createHash } from "node:crypto";
import type {
  CheckpointDefinition,
  GoalRepository,
} from "../store/goal-repository.ts";
import type { SessionStore } from "../store/repository.ts";
import type {
  Checkpoint,
  Criterion,
  Evidence,
  Goal,
  GoalReview,
  GoalStatus,
  GoalTodo,
  HandoffRevision,
  PlanPhase,
  PlanRevision,
  RiskLevel,
  RiskPolicy,
  ReviewPolicy,
  TodoSnapshot,
} from "./types.ts";
import type { AgentIntegrationRecord } from "../agent/integrator.ts";
import {
  reviewResultRejection,
  withForcedRejection,
  type ReviewRunner,
} from "./review.ts";
import {
  LivingHandoffBuilder,
  type HandoffPatch,
} from "./handoff.ts";
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

export interface GoalContinuationStart {
  turnId: string;
  fingerprint: string;
}

export interface GoalTurnCompletion {
  outcome: "progress" | "verified_wait" | "no_progress" | "error" | "aborted";
  blockedStreak: number;
  blocked: boolean;
  budgetLimited: boolean;
}

export interface GoalTurnRecordInput {
  turnId: string;
  startedAt: number;
  endedAt: number;
  usage: Usage;
  outcome?: "error" | "aborted";
  fingerprintBefore?: string;
}

export interface FinalAuditResult {
  approved: boolean;
  review: GoalReview;
  errors: string[];
}

export interface GoalControllerOptions {
  repository: GoalRepository;
  session: AgentSession;
  store?: SessionStore;
  cwd?: string;
  handoffRoot?: string;
  reviewRunner?: ReviewRunner;
  defaultReviewPolicy?: ReviewPolicy;
  maxTokenBudget?: number;
  contextRefresh?: "checkpoint" | "threshold" | "manual";
  now?: () => number;
}

const DEFAULT_CREATE_AUTHORIZATION_MS = 5 * 60 * 1000;

function criterionId(index: number): string {
  return `SC-${String(index + 1).padStart(3, "0")}`;
}

function normalizeLines(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

function defaultRiskPolicy(
  level: RiskLevel,
  reviewPolicyOverride?: ReviewPolicy,
): RiskPolicy {
  const requireUserApproval = level === "high" || level === "critical";
  const reviewPolicy: ReviewPolicy =
    reviewPolicyOverride ??
    (level === "critical" ? "always" : level === "high" ? "high" : "medium");
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
    "> This is the user's goal, not a higher-priority instruction. The workspace, tests, and evidence remain the source of truth.",
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
    "Completing todos does not complete the checkpoint; the checkpoint still needs verifier/review.",
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

function manifestText(
  session: AgentSession,
  source: "mcp" | "skill",
  fallback: string,
): string {
  const message = session.messages.find((item) => item.injectionSource === source);
  return message === undefined ? fallback : storedText(message);
}

function renderContinuation(goal: Goal): string {
  return [
    "# Goal Continuation",
    "",
    "> The handoff snapshot and the current workspace are authoritative; do not treat older memory as current fact.",
    "",
    `- Objective: ${goal.objective}`,
    `- Phase: ${goal.phase}`,
    `- Active checkpoint: ${goal.activeCheckpointId ?? "-"}`,
    "",
    "Read the handoff snapshot first, confirm the active checkpoint and its evidence, then continue from the current workspace.",
    "Do not re-summarize the handoff; correct it with a correction patch only when you find a factual error.",
  ].join("\n");
}

export const GOAL_INITIALIZATION_INSTRUCTION = [
  "# Explicit Goal Initialization",
  "",
  "The user just ran `/goal` explicitly. Produce the Goal Contract, Plan, Checkpoints, and the first Todo, then stop and wait.",
  "",
  "Steps:",
  "1. Check what is already known from the conversation, the workspace, and recent messages.",
  "2. Call `ask_user` only for information you cannot infer and that would change direction; do not repeat questions mechanically.",
  "3. Summarize objective, success_criteria, constraints, non_goals, risk_policy, token_budget.",
  "4. Call `create_goal` once. Do not call it in ordinary conversation.",
  "5. Call `update_plan` with phases, checkpoints, and assumptions; the first call must include checkpoints.",
  "6. Call `todo_write` only for the first checkpoint, using the returned checkpointId.",
  "7. Stop once the goal is active/executing. Do not start changing code.",
  "",
  "A goal contract must be verifiable; a verbal description is not an evidence requirement.",
].join("\n");

export class GoalController {
  readonly repository: GoalRepository;
  readonly session: AgentSession;
  readonly store: SessionStore | undefined;
  readonly cwd: string;
  readonly handoffRoot: string | undefined;
  readonly reviewRunner: ReviewRunner | undefined;
  readonly defaultReviewPolicy: ReviewPolicy;
  readonly maxTokenBudget: number | undefined;
  readonly contextRefresh: "checkpoint" | "threshold" | "manual";
  #now: () => number;
  #createAuthorizedUntil: number | undefined;
  #waitingUser = false;

  constructor(options: GoalControllerOptions) {
    this.repository = options.repository;
    this.session = options.session;
    this.store = options.store;
    this.cwd = options.cwd ?? process.cwd();
    this.handoffRoot = options.handoffRoot;
    this.reviewRunner = options.reviewRunner;
    this.defaultReviewPolicy = options.defaultReviewPolicy ?? "medium";
    this.maxTokenBudget = options.maxTokenBudget;
    this.contextRefresh = options.contextRefresh ?? "manual";
    this.#now = options.now ?? Date.now;
  }

  currentGoal(): Goal | undefined {
    return this.repository.getCurrentGoal(this.session.id);
  }

  /**
   * Persist deterministic integration evidence. Failed or rolled-back patches
   * are audit-only and must not become Goal completion evidence.
   */
  recordAgentIntegration(record: AgentIntegrationRecord): Evidence[] {
    const goal = this.currentGoal();
    if (
      goal === undefined ||
      goal.status !== "active" ||
      !record.applied ||
      record.rolledBack
    ) {
      return [];
    }
    const checkpointId = goal.activeCheckpointId;
    const stored: Evidence[] = [
      this.repository.addEvidence(goal.id, {
        ...(checkpointId !== undefined ? { checkpointId } : {}),
        kind: "diff",
        summary: `Applied worker patch ${record.agentId}`,
        reference: `agent://${record.agentId}/patch`,
        digest: record.patchDigest,
      }),
    ];
    record.verifications.forEach((verification, index) => {
      if (
        verification.exitCode !== 0 ||
        verification.timedOut ||
        verification.aborted
      ) {
        return;
      }
      stored.push(
        this.repository.addEvidence(goal.id, {
          ...(checkpointId !== undefined ? { checkpointId } : {}),
          kind: "test",
          summary: `Integrator verification passed: ${verification.command}`,
          reference: `agent://${record.agentId}/verify/${index}`,
          command: verification.command,
          exitCode: 0,
        }),
      );
    });
    return stored;
  }

  handoffBuilder(goalId: string): LivingHandoffBuilder | undefined {
    if (this.handoffRoot === undefined) return undefined;
    return new LivingHandoffBuilder({
      repository: this.repository,
      sessionId: this.session.id,
      goalId,
      root: this.handoffRoot,
    });
  }

  async syncHandoff(updatedBy: "system" | "worker" | "reviewer" | "user" = "system"): Promise<HandoffRevision | undefined> {
    const goal = this.currentGoal();
    if (goal === undefined) return undefined;
    return this.handoffBuilder(goal.id)?.sync(updatedBy);
  }

  async getHandoff(epochId?: string): Promise<{
    revision: HandoffRevision;
    markdown: string;
    snapshot: boolean;
  } | undefined> {
    const goal = this.currentGoal();
    if (goal === undefined) return undefined;
    const builder = this.handoffBuilder(goal.id);
    if (builder === undefined) return undefined;

    if (epochId !== undefined) {
      const epoch = this.repository.requireEpoch(epochId);
      if (epoch.goalId !== goal.id) throw new Error(`Epoch ${epochId} does not belong to the current goal`);
      const markdown = await Bun.file(builder.snapshotPath(epoch.id)).text();
      const revision = this.repository.requireHandoff(epoch.handoffId);
      return { revision, markdown, snapshot: true };
    }

    let revision = this.repository.getCanonicalHandoff(goal.id);
    if (revision === undefined) revision = await builder.sync("system");
    const markdown = await builder.readCanonical();
    if (markdown === undefined) throw new Error("canonical HANDOFF.md does not exist");
    return { revision, markdown, snapshot: false };
  }

  async applyHandoffPatches(
    baseRevision: number,
    actor: "system" | "worker" | "reviewer" | "user",
    patches: readonly HandoffPatch[],
  ): Promise<HandoffRevision> {
    const goal = this.requireCurrent();
    const builder = this.handoffBuilder(goal.id);
    if (builder === undefined) throw new Error("no handoff storage is configured");
    return builder.applyPatches(baseRevision, actor, patches);
  }

  async createContextEpoch(
    reason: "checkpoint" | "context_limit" | "resume" | "blocked" | "manual",
    checkpointId?: string,
  ): Promise<{ branchId: string; epochId: string; handoffRevision: number }> {
    const goal = this.requireCurrent();
    const store = this.store;
    if (store === undefined) throw new Error("persistence is disabled; cannot create a context epoch");
    if (this.session.turnActive || this.session.hasOpenToolBatch()) {
      throw new Error("context epochs can only be created at a safe boundary with no active turn or tool batch");
    }
    if (this.session.queuedUserCount > 0) {
      throw new Error("cannot create a context epoch while user messages are queued");
    }
    const builder = this.handoffBuilder(goal.id);
    if (builder === undefined) throw new Error("no handoff storage is configured");

    const handoff = await builder.sync("system");
    const epochId = `epoch_${crypto.randomUUID()}`;
    const snapshot = await builder.writeEpochSnapshot(epochId);
    if (snapshot.hash !== handoff.snapshotHash) {
      throw new Error("handoff snapshot hash does not match its revision");
    }

    const sessionRecord = store.getSession(this.session.id);
    if (sessionRecord === undefined) throw new Error(`unknown session: ${this.session.id}`);
    const previousBranchId = this.session.branchId;
    const branchId = store.createBranch(this.session.id, 0, {
      ...(previousBranchId !== undefined ? { parentBranchId: previousBranchId } : {}),
      title: `goal ${goal.id} · ${reason}`,
    });

    try {
      store.setActiveBranch(this.session.id, branchId);
      const branchSession = new AgentSession({
        id: this.session.id,
        branchId,
        system: sessionRecord.systemPrompt,
        client: this.session.client,
        model: this.session.model,
        restore: store.loadBranchPath(this.session.id, branchId),
        nextMsgId: store.nextMsgId(this.session.id),
        onMessage: (message) => {
          store.appendMessageToBranch(this.session.id, branchId, message, message.createdAt);
        },
      });
      branchSession.appendInjection(
        manifestText(this.session, "mcp", "# MCP servers\n\n(none)"),
        "mcp",
      );
      branchSession.appendInjection(
        manifestText(this.session, "skill", "# Skills\n\n(none)"),
        "skill",
      );
      branchSession.appendGoalContext(renderGoalContract(goal));
      const plan = this.repository.latestPlanRevision(goal.id);
      if (plan !== undefined) {
        branchSession.enqueueInjection(
          renderPlan(plan, this.repository.listCheckpoints(goal.id)),
          "plan",
        );
      }
      const checkpoint =
        checkpointId === undefined
          ? goal.activeCheckpointId === undefined
            ? undefined
            : this.repository.getCheckpoint(goal.activeCheckpointId)
          : this.repository.getCheckpoint(checkpointId);
      const todo =
        checkpoint === undefined
          ? undefined
          : this.repository.latestTodoSnapshot(goal.id, checkpoint.id);
      if (checkpoint !== undefined && todo !== undefined) {
        branchSession.enqueueInjection(renderCheckpointTodo(checkpoint, todo), "checkpoint");
      }
      branchSession.enqueueInjection(snapshot.markdown, "handoff");
      branchSession.enqueueInjection(renderContinuation(goal), "handoff");

      const epoch = this.repository.createEpoch(goal.id, {
        id: epochId,
        branchId,
        ...(goal.activeEpochId !== undefined ? { parentEpochId: goal.activeEpochId } : {}),
        ...(checkpoint !== undefined ? { checkpointId: checkpoint.id } : {}),
        handoffId: handoff.id,
        reason,
      });
      if (goal.phase === "handoff") {
        this.repository.setGoalPhase(goal.id, "epoch_switch");
        this.repository.setGoalPhase(goal.id, "executing");
      }
      return { branchId, epochId: epoch.id, handoffRevision: handoff.revision };
    } catch (error) {
      if (previousBranchId !== undefined) store.setActiveBranch(this.session.id, previousBranchId);
      throw error;
    }
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
      throw new Error("goal creation authorization window must be greater than 0");
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
      throw new Error("create_goal requires the user to run /goal first; no one-shot creation authorization is active");
    }
    const existing = this.currentGoal();
    if (existing !== undefined && existing.status !== "complete") {
      throw new Error(`this session already has an unfinished goal: ${existing.id}`);
    }

    const objective = input.objective.trim();
    const rawIntent = input.rawIntent.trim();
    if (objective.length === 0) throw new Error("goal objective must not be empty");
    if (rawIntent.length === 0) throw new Error("goal raw intent must not be empty");

    const successCriteriaText = normalizeLines(input.successCriteria);
    if (successCriteriaText.length === 0) {
      throw new Error("a goal needs at least one verifiable success criterion");
    }
    if (input.tokenBudget !== undefined && input.tokenBudget <= 0) {
      throw new Error("goal token budget must be greater than 0");
    }
    if (
      input.tokenBudget !== undefined &&
      this.maxTokenBudget !== undefined &&
      input.tokenBudget > this.maxTokenBudget
    ) {
      throw new Error(`goal token budget must not exceed the configured limit ${this.maxTokenBudget}`);
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
      riskPolicy:
        input.riskPolicy ?? defaultRiskPolicy("medium", this.defaultReviewPolicy),
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
    if (goal.status !== "active") throw new Error(`goal is not active: ${goal.status}`);
    if (goal.phase !== "planning" && goal.phase !== "ready") {
      throw new Error(`update_plan is only allowed in planning/ready, current phase is ${goal.phase}`);
    }

    const existing = this.repository.latestPlanRevision(goal.id);
    let plan: PlanRevision;
    let checkpoints: Checkpoint[];
    if (existing === undefined) {
      if (input.checkpoints === undefined || input.checkpoints.length === 0) {
        throw new Error("the first update_plan must provide checkpoints");
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
        throw new Error("checkpoints are frozen; later update_plan calls may only update phases/assumptions");
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
    if (goal.status !== "active") throw new Error(`goal is not active: ${goal.status}`);
    if (goal.phase !== "ready" && goal.phase !== "executing") {
      throw new Error(`todo_write is only allowed in ready/executing, current phase is ${goal.phase}`);
    }
    const plan = this.repository.latestPlanRevision(goal.id);
    if (plan === undefined) throw new Error("a plan must exist before writing todos");

    const checkpoint = this.repository.requireCheckpoint(input.checkpointId);
    if (checkpoint.goalId !== goal.id) {
      throw new Error(`checkpoint ${checkpoint.id} does not belong to the current goal`);
    }
    if (goal.activeCheckpointId === undefined) {
      const firstPending = this.repository
        .listCheckpoints(goal.id)
        .find((candidate) => candidate.status === "pending");
      if (firstPending?.id !== checkpoint.id) {
        throw new Error(`todos must belong to the first executable checkpoint: ${firstPending?.id ?? "(none)"}`);
      }
      this.repository.activateCheckpoint(checkpoint.id);
      this.repository.setGoalPhase(goal.id, "executing");
    } else if (goal.activeCheckpointId !== checkpoint.id) {
      throw new Error(`todos may only be written to the active checkpoint: ${goal.activeCheckpointId}`);
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
    if (goal.status !== "active") throw new Error(`goal is not active: ${goal.status}`);
    if (goal.phase !== "executing") {
      throw new Error(`submitting a checkpoint is only allowed in executing, current phase is ${goal.phase}`);
    }
    if (goal.activeCheckpointId !== input.checkpointId) {
      throw new Error(`only the active checkpoint can be submitted: ${goal.activeCheckpointId ?? "(none)"}`);
    }
    const checkpoint = this.repository.requireCheckpoint(input.checkpointId);
    if (checkpoint.status !== "active") {
      throw new Error(`checkpoint is not active: ${checkpoint.status}`);
    }
    const todo = this.repository.latestTodoSnapshot(goal.id, checkpoint.id);
    if (todo === undefined) throw new Error("a todo snapshot must exist before submitting a checkpoint");

    const verification = await verifyCheckpointDeterministically({
      checkpoint,
      todos: todo.todos,
      evidence: input.evidence,
      cwd: this.cwd,
    });
    if (!verification.ok) {
      throw new Error(`deterministic verification failed: ${verification.errors.join("; ")}`);
    }

    const existingReviews = this.repository.listReviews(goal.id, checkpoint.id);
    const nextRound = existingReviews.length + 1;
    if (nextRound > 3) {
      throw new Error("checkpoint has reached 3 review rounds; the user must decide how to continue");
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
        this.repository.setGoalPhase(
          goal.id,
          this.contextRefresh === "checkpoint" ? "handoff" : "executing",
        );
      }
      await this.syncHandoff("system");
      return {
        review: completed,
        checkpoint: finished,
        ...(next !== undefined ? { nextCheckpointId: next.id } : {}),
      };
    }

    if (this.reviewRunner === undefined) {
      throw new Error("no independent reviewer is available; this checkpoint cannot pass");
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
        `reviewer failed; checkpoint blocked: ${error instanceof Error ? error.message : String(error)}`,
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
        this.repository.setGoalPhase(
          goal.id,
          this.contextRefresh === "checkpoint" ? "handoff" : "executing",
        );
      }
    } else {
      updatedCheckpoint = this.repository.requireCheckpoint(checkpoint.id);
    }

    this.session.enqueueInjection(renderReviewDecision(completedReview), "review");
    await this.syncHandoff("reviewer");
    return {
      review: completedReview,
      checkpoint: updatedCheckpoint,
      ...(nextCheckpointId !== undefined ? { nextCheckpointId } : {}),
    };
  }

  async finalAudit(): Promise<FinalAuditResult> {
    const goal = this.requireCurrent();
    if (goal.status !== "active") throw new Error(`goal is not active: ${goal.status}`);
    if (this.reviewRunner === undefined) throw new Error("no final reviewer is available");

    const checkpoints = this.repository.listCheckpoints(goal.id);
    if (checkpoints.length === 0) throw new Error("the goal has no checkpoints; cannot run the final audit");
    const incomplete = checkpoints.filter((checkpoint) => checkpoint.status !== "completed");
    if (incomplete.length > 0) {
      throw new Error(`unfinished checkpoints remain: ${incomplete.map((item) => item.id).join(", ")}`);
    }
    if (goal.phase !== "checkpoint_audit" && goal.phase !== "executing") {
      throw new Error(`final audit is not allowed in the current phase: ${goal.phase}`);
    }

    if (goal.phase === "checkpoint_audit") {
      this.repository.setGoalPhase(goal.id, "executing");
    }
    this.repository.setGoalPhase(goal.id, "final_audit");

    const lastCheckpoint = checkpoints[checkpoints.length - 1]!;
    const priorReviews = this.repository.listReviews(goal.id, lastCheckpoint.id);
    const round = priorReviews.length + 1;
    const revision = captureWorkspaceRevision(this.cwd);
    const review = this.repository.createReview(goal.id, {
      checkpointId: lastCheckpoint.id,
      round,
      reviewer: "final-auditor",
      baseRevision: revision.base,
      headRevision: revision.head,
      diffHash: revision.diffHash,
      criteriaCoverage: goal.successCriteria.map((criterion) => ({
        criterion: criterion.text,
        status: "missing",
        evidence: [],
      })),
    });
    this.repository.setReviewStatus(review.id, "running");

    const syntheticCheckpoint: Checkpoint = {
      id: `final:${goal.id}`,
      goalId: goal.id,
      order: checkpoints.length + 1,
      title: "Final Goal Audit",
      deliverable: goal.objective,
      acceptanceCriteria: goal.successCriteria.map((criterion) => criterion.text),
      evidenceRequired: ["review"],
      dependsOn: checkpoints.map((checkpoint) => checkpoint.id),
      status: "reviewing",
      createdAt: Date.now(),
    };
    const latestTodo = this.repository.latestTodoSnapshot(goal.id);
    let result;
    try {
      result = await this.reviewRunner.run({
        goal,
        checkpoint: syntheticCheckpoint,
        todos: latestTodo?.todos ?? [],
        evidence: this.repository.listEvidence(goal.id),
        remainingRisk: [],
        cwd: this.cwd,
        baseRevision: revision.base,
        headRevision: revision.head,
        diffHash: revision.diffHash,
      });
    } catch (error) {
      this.repository.setReviewStatus(review.id, "blocked");
      this.repository.setGoalPhase(goal.id, "executing");
      throw new Error(
        `final reviewer failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const errors = reviewResultRejection(
      result,
      goal.successCriteria.map((criterion) => criterion.text),
    );
    const completed = this.repository.completeReview(
      review.id,
      withForcedRejection(result, errors),
    );
    if (completed.status === "approved") {
      this.repository.setGoalStatus(goal.id, "complete");
      await this.syncHandoff("reviewer");
      return { approved: true, review: completed, errors: [] };
    }

    this.repository.setGoalPhase(goal.id, "executing");
    await this.syncHandoff("reviewer");
    return { approved: false, review: completed, errors };
  }

  pause(reason?: string): Goal {
    return this.#userStatus("paused", reason);
  }

  editContract(input: GoalContractInput): Goal {
    const goal = this.requireCurrent();
    if (
      goal.phase !== "draft" &&
      goal.phase !== "inspecting" &&
      goal.phase !== "clarifying"
    ) {
      throw new Error("the goal contract is already in planning and cannot be rewritten in place; clear it and initialize again");
    }
    const updated = this.repository.updateGoalContract(goal.id, {
      rawIntent: input.rawIntent,
      objective: input.objective,
      successCriteria: input.successCriteria.map((text, index) => ({
        id: criterionId(index),
        text,
        evidenceRequired: ["command/test/file/runtime evidence"],
      })),
      ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
      ...(input.nonGoals !== undefined ? { nonGoals: input.nonGoals } : {}),
      ...(input.riskPolicy !== undefined ? { riskPolicy: input.riskPolicy } : {}),
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
    });
    this.session.appendGoalContext(renderGoalContract(updated));
    return updated;
  }

  clearGoal(): string {
    const goal = this.requireCurrent();
    if (!this.repository.deleteGoal(goal.id)) throw new Error(`failed to delete goal: ${goal.id}`);
    this.session.enqueueInjection(
      `# Goal Cleared\n\n- Goal ID: ${goal.id}\n- The user explicitly cleared the goal aggregate; conversation history and handoff files are kept.`,
      "system",
    );
    return goal.id;
  }

  progressFingerprint(): string {
    const goal = this.currentGoal();
    if (goal === undefined) return "none";
    const checkpoints = this.repository
      .listCheckpoints(goal.id)
      .map((checkpoint) => `${checkpoint.id}:${checkpoint.status}`)
      .join(",");
    const todo = this.repository.latestTodoSnapshot(goal.id);
    const reviews = this.repository
      .listReviews(goal.id)
      .map((review) => `${review.id}:${review.status}`)
      .join(",");
    const handoff = this.repository.getCanonicalHandoff(goal.id);
    return createHash("sha256")
      .update(
        JSON.stringify({
          status: goal.status,
          phase: goal.phase,
          activeCheckpointId: goal.activeCheckpointId,
          checkpoints,
          todoRevision: todo?.revision ?? 0,
          evidenceCount: this.repository.listEvidence(goal.id).length,
          reviews,
          handoffRevision: handoff?.revision ?? 0,
        }),
      )
      .digest("hex");
  }

  deferForUser(): void {
    this.#waitingUser = true;
  }

  clearUserDeferral(): void {
    this.#waitingUser = false;
  }

  get waitingUser(): boolean {
    return this.#waitingUser;
  }

  shouldAutoRefreshContext(): boolean {
    const goal = this.currentGoal();
    return (
      this.contextRefresh === "checkpoint" &&
      goal?.status === "active" &&
      goal.phase === "handoff"
    );
  }

  canAutoContinue(): { allowed: boolean; reason?: string } {
    const goal = this.currentGoal();
    if (goal === undefined) return { allowed: false, reason: "no goal" };
    if (this.#waitingUser) return { allowed: false, reason: "waiting for user" };
    if (goal.status !== "active") return { allowed: false, reason: `status=${goal.status}` };
    if (goal.phase !== "executing" && goal.phase !== "ready") {
      return { allowed: false, reason: `phase=${goal.phase}` };
    }
    if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
      this.repository.setGoalStatus(goal.id, "budget_limited");
      return { allowed: false, reason: "budget limited" };
    }
    return { allowed: true };
  }

  beginContinuation(): GoalContinuationStart {
    const check = this.canAutoContinue();
    if (!check.allowed) throw new Error(`the goal cannot auto-continue right now: ${check.reason ?? "unknown"}`);
    const goal = this.repository.incrementContinuation(this.requireCurrent().id);
    const handoff = this.repository.getCanonicalHandoff(goal.id);
    this.session.enqueueInjection(
      [
        renderContinuation(goal),
        ...(handoff === undefined
          ? []
          : [`- Latest handoff revision: ${handoff.revision}`, `- Current state: ${handoff.currentState}`]),
      ].join("\n"),
      "goal",
    );
    return {
      turnId: `goal-turn-${crypto.randomUUID()}`,
      fingerprint: this.progressFingerprint(),
    };
  }

  completeTurn(input: GoalTurnRecordInput): GoalTurnCompletion {
    const goal = this.currentGoal();
    if (goal === undefined) {
      return { outcome: "progress", blockedStreak: 0, blocked: false, budgetLimited: false };
    }
    const fingerprintAfter = this.progressFingerprint();
    const outcome =
      input.outcome ??
      (input.fingerprintBefore !== undefined && input.fingerprintBefore === fingerprintAfter
        ? "no_progress"
        : "progress");
    this.repository.recordTurn(goal.id, {
      turnId: input.turnId,
      inputTokens: input.usage.input,
      outputTokens: input.usage.output,
      cachedTokens: input.usage.cached ?? 0,
      activeSeconds: Math.max(0, Math.round((input.endedAt - input.startedAt) / 1000)),
      outcome,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
    });

    let blockedStreak = goal.blockedStreak;
    let blocked = false;
    if (outcome === "no_progress") {
      blockedStreak += 1;
      this.repository.setBlockedStreak(goal.id, blockedStreak);
      if (blockedStreak >= 3) {
        this.repository.setGoalStatus(goal.id, "blocked");
        blocked = true;
      }
    } else if (outcome === "progress") {
      blockedStreak = 0;
      this.repository.setBlockedStreak(goal.id, 0);
    }

    const updated = this.requireCurrent();
    const budgetLimited =
      updated.tokenBudget !== undefined && updated.tokensUsed >= updated.tokenBudget;
    if (budgetLimited && updated.status === "active") {
      this.repository.setGoalStatus(goal.id, "budget_limited");
    }
    return { outcome, blockedStreak, blocked, budgetLimited };
  }

  markUsageLimited(reason?: string): Goal {
    const goal = this.requireCurrent();
    const updated = this.repository.setGoalStatus(goal.id, "usage_limited");
    this.session.appendGoalContext(
      `${renderGoalStatus(updated)}${reason === undefined ? "" : `\n- Reason: ${reason}`}`,
    );
    return updated;
  }

  resume(): Goal {
    const goal = this.requireCurrent();
    const resumed = this.repository.setGoalStatus(goal.id, "active");
    this.session.appendGoalContext(
      `${renderGoalStatus(resumed)}\n\n- Resume: the user explicitly resumed; continue the current phase and do not redo completed work.`,
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
    if (goal === undefined) throw new Error("this session has no goal");
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
