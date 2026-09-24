/**
 * Goal Mode 2.0 persistence.
 *
 * The repository owns domain invariants that SQLite alone cannot express:
 * state transitions, checkpoint DAG validation, todo evidence, review gates and
 * immutable revisions. Callers may still read the raw database for diagnostics,
 * but Goal state must be written through this class.
 */

import type { Database } from "bun:sqlite";
import {
  CHECKPOINT_STATUSES,
  EVIDENCE_KINDS,
  GOAL_PHASES,
  GOAL_STATUSES,
  REVIEW_STATUSES,
  type Checkpoint,
  type CheckpointStatus,
  type ContextEpoch,
  type ContextEpochReason,
  type CriteriaCoverage,
  type Criterion,
  type Evidence,
  type EvidenceKind,
  type Goal,
  type GoalPhase,
  type GoalReview,
  type GoalStatus,
  type GoalTodo,
  type HandoffActor,
  type HandoffRevision,
  type HandoffStatus,
  type PlanPhase,
  type PlanRevision,
  type ReviewFinding,
  type ReviewPolicy,
  type ReviewResult,
  type ReviewStatus,
  type RiskPolicy,
  type TodoSnapshot,
  type TurnAccounting,
  type TurnOutcome,
} from "../goal/types.ts";

export class GoalRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalRepositoryError";
  }
}

const GOAL_STATUS_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  active: ["paused", "blocked", "usage_limited", "budget_limited", "complete"],
  paused: ["active", "blocked"],
  blocked: ["active", "paused"],
  usage_limited: ["active"],
  budget_limited: ["active"],
  complete: [],
};

const GOAL_PHASE_TRANSITIONS: Record<GoalPhase, readonly GoalPhase[]> = {
  draft: ["inspecting"],
  inspecting: ["clarifying", "planning"],
  clarifying: ["planning"],
  planning: ["ready"],
  ready: ["executing"],
  executing: ["checkpoint_audit", "final_audit"],
  checkpoint_audit: ["executing", "handoff"],
  handoff: ["executing", "epoch_switch"],
  epoch_switch: ["executing"],
  final_audit: ["executing"],
};

const CHECKPOINT_STATUS_TRANSITIONS: Record<CheckpointStatus, readonly CheckpointStatus[]> = {
  pending: ["active"],
  active: ["verifying", "blocked"],
  verifying: ["reviewing", "active", "blocked"],
  reviewing: ["completed", "active", "blocked"],
  completed: [],
  blocked: ["active"],
};

const REVIEW_STATUS_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  requested: ["running", "blocked"],
  running: ["approved", "changes_requested", "blocked"],
  approved: ["stale"],
  changes_requested: ["stale"],
  blocked: [],
  stale: ["requested"],
};

export interface CreateGoalInput {
  id?: string;
  sessionId: string;
  rawIntent: string;
  objective: string;
  successCriteria?: readonly Criterion[];
  constraints?: readonly string[];
  nonGoals?: readonly string[];
  riskPolicy?: RiskPolicy;
  status?: GoalStatus;
  phase?: GoalPhase;
  tokenBudget?: number;
  now?: number;
}

export interface GoalContractPatch {
  rawIntent?: string;
  objective?: string;
  successCriteria?: readonly Criterion[];
  constraints?: readonly string[];
  nonGoals?: readonly string[];
  riskPolicy?: RiskPolicy;
  tokenBudget?: number;
}

export interface CheckpointDefinition {
  id?: string;
  order: number;
  title: string;
  deliverable: string;
  acceptanceCriteria: readonly string[];
  evidenceRequired: readonly string[];
  dependsOn?: readonly string[];
}

export interface PlanRevisionInput {
  id?: string;
  phases: readonly PlanPhase[];
  assumptions?: readonly string[];
  now?: number;
}

export interface InitialPlanInput extends PlanRevisionInput {
  checkpoints: readonly CheckpointDefinition[];
  planId?: string;
}

export interface TodoSnapshotInput {
  id?: string;
  checkpointId: string;
  summary?: string;
  todos: readonly Omit<GoalTodo, "checkpointId">[];
  now?: number;
}

export interface EvidenceInput {
  id?: string;
  checkpointId?: string;
  kind: EvidenceKind;
  summary: string;
  reference: string;
  digest?: string;
  command?: string;
  exitCode?: number;
  now?: number;
}

export interface HandoffRevisionInput {
  id?: string;
  status?: HandoffStatus;
  updatedBy: HandoffActor;
  currentState: string;
  markdownPath: string;
  snapshotHash?: string;
  supersedesRevision?: number;
  now?: number;
}

export interface ContextEpochInput {
  id?: string;
  branchId: string;
  parentEpochId?: string;
  checkpointId?: string;
  handoffId: string;
  reason: ContextEpochReason;
  now?: number;
}

export interface TurnAccountingInput {
  turnId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  activeSeconds: number;
  outcome: TurnOutcome;
  startedAt: number;
  endedAt: number;
}

export interface ReviewInput {
  id?: string;
  checkpointId: string;
  round?: number;
  reviewer: string;
  baseRevision: string;
  headRevision: string;
  diffHash: string;
  criteriaCoverage?: readonly CriteriaCoverage[];
  unresolvedQuestions?: readonly string[];
  now?: number;
}

interface GoalRow {
  goal_id: string;
  session_id: string;
  raw_intent: string;
  objective: string;
  success_criteria: string;
  constraints: string;
  non_goals: string;
  risk_policy: string;
  status: string;
  phase: string;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  continuation_count: number;
  blocked_streak: number;
  active_checkpoint_id: string | null;
  active_epoch_id: string | null;
  created_at: number;
  updated_at: number;
}

interface CheckpointRow {
  checkpoint_id: string;
  goal_id: string;
  ordinal: number;
  title: string;
  deliverable: string;
  acceptance_criteria: string;
  evidence_required: string;
  depends_on: string;
  status: string;
  created_at: number;
  completed_at: number | null;
}

interface PlanRow {
  plan_id: string;
  goal_id: string;
  revision: number;
  phases: string;
  assumptions: string;
  created_at: number;
}

interface TodoSnapshotRow {
  snapshot_id: string;
  goal_id: string;
  checkpoint_id: string;
  revision: number;
  summary: string | null;
  todos: string;
  created_at: number;
}

interface EvidenceRow {
  evidence_id: string;
  goal_id: string;
  checkpoint_id: string | null;
  kind: string;
  summary: string;
  reference: string;
  digest: string | null;
  command: string | null;
  exit_code: number | null;
  created_at: number;
}

interface HandoffRow {
  handoff_id: string;
  goal_id: string;
  revision: number;
  status: string;
  updated_by: string;
  current_state: string;
  markdown_path: string;
  snapshot_hash: string | null;
  supersedes_revision: number | null;
  created_at: number;
  updated_at: number;
}

interface EpochRow {
  epoch_id: string;
  goal_id: string;
  branch_id: string;
  parent_epoch_id: string | null;
  checkpoint_id: string | null;
  handoff_id: string;
  handoff_revision: number;
  handoff_snapshot_hash: string;
  reason: string;
  created_at: number;
}

interface TurnAccountingRow {
  id: number;
  goal_id: string;
  turn_id: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  active_seconds: number;
  outcome: string;
  started_at: number;
  ended_at: number;
}

interface ReviewRow {
  review_id: string;
  goal_id: string;
  checkpoint_id: string;
  round: number;
  status: string;
  reviewer: string;
  base_revision: string;
  head_revision: string;
  diff_hash: string;
  verdict: string | null;
  criteria_coverage: string;
  unresolved_questions: string;
  created_at: number;
  updated_at: number;
}

interface ReviewFindingRow {
  finding_id: string;
  review_id: string;
  severity: string;
  title: string;
  evidence: string;
  requested_change: string | null;
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new GoalRepositoryError(`${field} 不能为空`);
  }
  return normalized;
}

function nonEmptyList(values: readonly string[], field: string): string[] {
  if (values.length === 0) throw new GoalRepositoryError(`${field} 至少需要一项`);
  return values.map((value) => nonEmpty(value, field));
}

function parseStringArray(raw: string): string[] {
  return JSON.parse(raw) as string[];
}

function parseRiskPolicy(raw: string): RiskPolicy {
  return JSON.parse(raw) as RiskPolicy;
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.goal_id,
    sessionId: row.session_id,
    rawIntent: row.raw_intent,
    objective: row.objective,
    successCriteria: JSON.parse(row.success_criteria) as Criterion[],
    constraints: parseStringArray(row.constraints),
    nonGoals: parseStringArray(row.non_goals),
    riskPolicy: parseRiskPolicy(row.risk_policy),
    status: row.status as GoalStatus,
    phase: row.phase as GoalPhase,
    ...(row.token_budget !== null ? { tokenBudget: row.token_budget } : {}),
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    continuationCount: row.continuation_count,
    blockedStreak: row.blocked_streak,
    ...(row.active_checkpoint_id !== null
      ? { activeCheckpointId: row.active_checkpoint_id }
      : {}),
    ...(row.active_epoch_id !== null ? { activeEpochId: row.active_epoch_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.checkpoint_id,
    goalId: row.goal_id,
    order: row.ordinal,
    title: row.title,
    deliverable: row.deliverable,
    acceptanceCriteria: parseStringArray(row.acceptance_criteria),
    evidenceRequired: parseStringArray(row.evidence_required),
    dependsOn: parseStringArray(row.depends_on),
    status: row.status as CheckpointStatus,
    createdAt: row.created_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

function rowToPlan(row: PlanRow): PlanRevision {
  return {
    id: row.plan_id,
    goalId: row.goal_id,
    revision: row.revision,
    phases: JSON.parse(row.phases) as PlanPhase[],
    assumptions: parseStringArray(row.assumptions),
    createdAt: row.created_at,
  };
}

function rowToTodoSnapshot(row: TodoSnapshotRow): TodoSnapshot {
  return {
    id: row.snapshot_id,
    goalId: row.goal_id,
    checkpointId: row.checkpoint_id,
    revision: row.revision,
    ...(row.summary !== null ? { summary: row.summary } : {}),
    todos: JSON.parse(row.todos) as GoalTodo[],
    createdAt: row.created_at,
  };
}

function rowToEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.evidence_id,
    goalId: row.goal_id,
    ...(row.checkpoint_id !== null ? { checkpointId: row.checkpoint_id } : {}),
    kind: row.kind as EvidenceKind,
    summary: row.summary,
    reference: row.reference,
    ...(row.digest !== null ? { digest: row.digest } : {}),
    ...(row.command !== null ? { command: row.command } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    createdAt: row.created_at,
  };
}

function rowToHandoff(row: HandoffRow): HandoffRevision {
  return {
    id: row.handoff_id,
    goalId: row.goal_id,
    revision: row.revision,
    status: row.status as HandoffStatus,
    updatedBy: row.updated_by as HandoffActor,
    currentState: row.current_state,
    markdownPath: row.markdown_path,
    ...(row.snapshot_hash !== null ? { snapshotHash: row.snapshot_hash } : {}),
    ...(row.supersedes_revision !== null
      ? { supersedesRevision: row.supersedes_revision }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEpoch(row: EpochRow): ContextEpoch {
  return {
    id: row.epoch_id,
    goalId: row.goal_id,
    branchId: row.branch_id,
    ...(row.parent_epoch_id !== null ? { parentEpochId: row.parent_epoch_id } : {}),
    ...(row.checkpoint_id !== null ? { checkpointId: row.checkpoint_id } : {}),
    handoffId: row.handoff_id,
    handoffRevision: row.handoff_revision,
    handoffSnapshotHash: row.handoff_snapshot_hash,
    reason: row.reason as ContextEpochReason,
    createdAt: row.created_at,
  };
}

function rowToTurnAccounting(row: TurnAccountingRow): TurnAccounting {
  return {
    id: row.id,
    goalId: row.goal_id,
    turnId: row.turn_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedTokens: row.cached_tokens,
    activeSeconds: row.active_seconds,
    outcome: row.outcome as TurnOutcome,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function rowToReview(row: ReviewRow): GoalReview {
  return {
    id: row.review_id,
    goalId: row.goal_id,
    checkpointId: row.checkpoint_id,
    round: row.round,
    status: row.status as ReviewStatus,
    reviewer: row.reviewer,
    baseRevision: row.base_revision,
    headRevision: row.head_revision,
    diffHash: row.diff_hash,
    ...(row.verdict !== null ? { verdict: row.verdict as ReviewResult["verdict"] } : {}),
    criteriaCoverage: JSON.parse(row.criteria_coverage) as CriteriaCoverage[],
    unresolvedQuestions: parseStringArray(row.unresolved_questions),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToFinding(row: ReviewFindingRow): ReviewFinding {
  return {
    id: row.finding_id,
    reviewId: row.review_id,
    severity: row.severity as ReviewFinding["severity"],
    title: row.title,
    evidence: row.evidence,
    ...(row.requested_change !== null ? { requestedChange: row.requested_change } : {}),
  };
}

function assertAcyclic(
  ids: readonly string[],
  dependenciesFor: (id: string) => readonly string[],
  label: string,
): void {
  const idSet = new Set(ids);
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const id of ids) {
    const dependencies = dependenciesFor(id);
    const unique = new Set(dependencies);
    for (const dependency of unique) {
      if (!idSet.has(dependency)) {
        throw new GoalRepositoryError(`${label} ${id} 依赖不存在的 ${dependency}`);
      }
      if (dependency === id) throw new GoalRepositoryError(`${label} ${id} 不能依赖自身`);
      const targets = outgoing.get(dependency) ?? [];
      targets.push(id);
      outgoing.set(dependency, targets);
    }
    indegree.set(id, unique.size);
  }

  const queue = ids.filter((id) => indegree.get(id) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited += 1;
    for (const next of outgoing.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (visited !== ids.length) throw new GoalRepositoryError(`${label} 依赖存在环`);
}

export class GoalRepository {
  #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /* --------------------------- goals --------------------------- */

  createGoal(input: CreateGoalInput): Goal {
    const id = input.id ?? newId("goal");
    const now = input.now ?? Date.now();
    const objective = nonEmpty(input.objective, "objective");
    const rawIntent = nonEmpty(input.rawIntent, "raw_intent");
    const status = input.status ?? "active";
    const phase = input.phase ?? "draft";
    if (!isOneOf(status, GOAL_STATUSES)) {
      throw new GoalRepositoryError(`未知 Goal status：${String(status)}`);
    }
    if (!isOneOf(phase, GOAL_PHASES)) {
      throw new GoalRepositoryError(`未知 Goal phase：${String(phase)}`);
    }

    const successCriteria = [...(input.successCriteria ?? [])];
    const executionPhases: readonly GoalPhase[] = [
      "ready",
      "executing",
      "checkpoint_audit",
      "handoff",
      "epoch_switch",
      "final_audit",
    ];
    if (executionPhases.includes(phase) && successCriteria.length === 0) {
      throw new GoalRepositoryError(`${phase} 阶段至少需要一条 success criterion`);
    }
    if (input.tokenBudget !== undefined && input.tokenBudget <= 0) {
      throw new GoalRepositoryError("token_budget 必须大于 0");
    }

    const riskPolicy: RiskPolicy = input.riskPolicy ?? {
      level: "medium",
      requireUserApproval: false,
      reviewPolicy: "medium",
      notes: [],
    };

    this.#db
      .query(
        `INSERT INTO session_goals
         (goal_id, session_id, raw_intent, objective, success_criteria, constraints,
          non_goals, risk_policy, status, phase, token_budget, tokens_used,
          time_used_seconds, continuation_count, blocked_streak,
          active_checkpoint_id, active_epoch_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        rawIntent,
        objective,
        JSON.stringify(successCriteria),
        JSON.stringify(input.constraints ?? []),
        JSON.stringify(input.nonGoals ?? []),
        JSON.stringify(riskPolicy),
        status,
        phase,
        input.tokenBudget ?? null,
        now,
        now,
      );

    return this.requireGoal(id);
  }

  getGoal(goalId: string): Goal | undefined {
    const row = this.#db
      .query("SELECT * FROM session_goals WHERE goal_id = ?")
      .get(goalId) as GoalRow | null;
    return row === null ? undefined : rowToGoal(row);
  }

  requireGoal(goalId: string): Goal {
    const goal = this.getGoal(goalId);
    if (goal === undefined) throw new GoalRepositoryError(`未知 Goal：${goalId}`);
    return goal;
  }

  getCurrentGoal(sessionId: string): Goal | undefined {
    const row = this.#db
      .query(
        `SELECT * FROM session_goals
          WHERE session_id = ?
          ORDER BY CASE WHEN status = 'complete' THEN 1 ELSE 0 END, updated_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(sessionId) as GoalRow | null;
    return row === null ? undefined : rowToGoal(row);
  }

  listGoals(sessionId?: string): Goal[] {
    const rows =
      sessionId === undefined
        ? (this.#db
            .query("SELECT * FROM session_goals ORDER BY created_at ASC, rowid ASC")
            .all() as GoalRow[])
        : (this.#db
            .query(
              `SELECT * FROM session_goals
                WHERE session_id = ?
                ORDER BY created_at ASC, rowid ASC`,
            )
            .all(sessionId) as GoalRow[]);
    return rows.map(rowToGoal);
  }

  /** 用户显式 clear：只删除 Goal 聚合，不删除消息历史。 */
  deleteGoal(goalId: string): boolean {
    const result = this.#db.query("DELETE FROM session_goals WHERE goal_id = ?").run(goalId);
    return result.changes > 0;
  }

  updateGoalContract(goalId: string, patch: GoalContractPatch): Goal {
    const current = this.requireGoal(goalId);
    if (current.status === "complete") {
      throw new GoalRepositoryError("complete Goal 不能再修改 contract");
    }
    const successCriteria = patch.successCriteria ?? current.successCriteria;
    const objective =
      patch.objective === undefined ? current.objective : nonEmpty(patch.objective, "objective");
    const rawIntent =
      patch.rawIntent === undefined ? current.rawIntent : nonEmpty(patch.rawIntent, "raw_intent");
    if (current.phase !== "draft" && current.phase !== "inspecting" && current.phase !== "clarifying") {
      if (patch.objective !== undefined || patch.successCriteria !== undefined) {
        throw new GoalRepositoryError("Goal 进入 planning 后不能静默改写 objective/success criteria");
      }
    }
    if (
      (current.phase === "ready" ||
        current.phase === "executing" ||
        current.phase === "checkpoint_audit" ||
        current.phase === "handoff" ||
        current.phase === "epoch_switch" ||
        current.phase === "final_audit") &&
      successCriteria.length === 0
    ) {
      throw new GoalRepositoryError("执行中的 Goal 必须有 success criteria");
    }
    if (patch.tokenBudget !== undefined && patch.tokenBudget <= 0) {
      throw new GoalRepositoryError("token_budget 必须大于 0");
    }

    const now = Date.now();
    this.#db
      .query(
        `UPDATE session_goals
            SET raw_intent = ?, objective = ?, success_criteria = ?, constraints = ?,
                non_goals = ?, risk_policy = ?, token_budget = ?, updated_at = ?
          WHERE goal_id = ?`,
      )
      .run(
        rawIntent,
        objective,
        JSON.stringify(successCriteria),
        JSON.stringify(patch.constraints ?? current.constraints),
        JSON.stringify(patch.nonGoals ?? current.nonGoals),
        JSON.stringify(patch.riskPolicy ?? current.riskPolicy),
        patch.tokenBudget ?? current.tokenBudget ?? null,
        now,
        goalId,
      );
    return this.requireGoal(goalId);
  }

  setGoalStatus(goalId: string, status: GoalStatus): Goal {
    const current = this.requireGoal(goalId);
    if (current.status === status) return current;
    if (!GOAL_STATUS_TRANSITIONS[current.status].includes(status)) {
      throw new GoalRepositoryError(`非法 Goal 状态转换：${current.status} -> ${status}`);
    }
    if (status === "complete") {
      const checkpoints = this.listCheckpoints(goalId);
      if (current.phase !== "final_audit") {
        throw new GoalRepositoryError("Goal 只能从 final_audit 进入 complete");
      }
      if (checkpoints.length === 0 || checkpoints.some((checkpoint) => checkpoint.status !== "completed")) {
        throw new GoalRepositoryError("所有 Checkpoint 完成后才能完成 Goal");
      }
    }
    this.#db
      .query("UPDATE session_goals SET status = ?, updated_at = ? WHERE goal_id = ?")
      .run(status, Date.now(), goalId);
    return this.requireGoal(goalId);
  }

  setGoalPhase(goalId: string, phase: GoalPhase): Goal {
    const current = this.requireGoal(goalId);
    if (current.phase === phase) return current;
    if (!GOAL_PHASE_TRANSITIONS[current.phase].includes(phase)) {
      throw new GoalRepositoryError(`非法 Goal phase 转换：${current.phase} -> ${phase}`);
    }
    if (
      (phase === "ready" ||
        phase === "executing" ||
        phase === "checkpoint_audit" ||
        phase === "handoff" ||
        phase === "epoch_switch" ||
        phase === "final_audit") &&
      current.successCriteria.length === 0
    ) {
      throw new GoalRepositoryError(`${phase} 阶段至少需要一条 success criterion`);
    }
    this.#db
      .query("UPDATE session_goals SET phase = ?, updated_at = ? WHERE goal_id = ?")
      .run(phase, Date.now(), goalId);
    return this.requireGoal(goalId);
  }

  setGoalActiveCheckpoint(goalId: string, checkpointId?: string): Goal {
    this.requireGoal(goalId);
    if (checkpointId !== undefined) {
      const checkpoint = this.requireCheckpoint(checkpointId);
      if (checkpoint.goalId !== goalId) {
        throw new GoalRepositoryError(`Checkpoint ${checkpointId} 不属于 Goal ${goalId}`);
      }
    }
    this.#db
      .query("UPDATE session_goals SET active_checkpoint_id = ?, updated_at = ? WHERE goal_id = ?")
      .run(checkpointId ?? null, Date.now(), goalId);
    return this.requireGoal(goalId);
  }

  setGoalActiveEpoch(goalId: string, epochId?: string): Goal {
    this.requireGoal(goalId);
    if (epochId !== undefined) {
      const epoch = this.requireEpoch(epochId);
      if (epoch.goalId !== goalId) {
        throw new GoalRepositoryError(`Epoch ${epochId} 不属于 Goal ${goalId}`);
      }
    }
    this.#db
      .query("UPDATE session_goals SET active_epoch_id = ?, updated_at = ? WHERE goal_id = ?")
      .run(epochId ?? null, Date.now(), goalId);
    return this.requireGoal(goalId);
  }

  recordTurn(goalId: string, input: TurnAccountingInput): TurnAccounting {
    this.requireGoal(goalId);
    if (input.inputTokens < 0 || input.outputTokens < 0 || (input.cachedTokens ?? 0) < 0) {
      throw new GoalRepositoryError("token 计数不能为负数");
    }
    if (input.activeSeconds < 0) throw new GoalRepositoryError("active_seconds 不能为负数");
    if (input.endedAt < input.startedAt) throw new GoalRepositoryError("ended_at 不能早于 started_at");

    const tx = this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO goal_turn_accounting
           (goal_id, turn_id, input_tokens, output_tokens, cached_tokens, active_seconds,
            outcome, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          goalId,
          input.turnId,
          input.inputTokens,
          input.outputTokens,
          input.cachedTokens ?? 0,
          input.activeSeconds,
          input.outcome,
          input.startedAt,
          input.endedAt,
        );
      this.#db
        .query(
          `UPDATE session_goals
              SET tokens_used = tokens_used + ?,
                  time_used_seconds = time_used_seconds + ?,
                  updated_at = ?
            WHERE goal_id = ?`,
        )
        .run(
          input.inputTokens + input.outputTokens,
          input.activeSeconds,
          input.endedAt,
          goalId,
        );
    });
    tx.immediate();

    const row = this.#db
      .query("SELECT * FROM goal_turn_accounting WHERE goal_id = ? AND turn_id = ?")
      .get(goalId, input.turnId) as TurnAccountingRow | null;
    if (row === null) throw new GoalRepositoryError("turn accounting 写入失败");
    return rowToTurnAccounting(row);
  }

  listTurnAccounting(goalId: string): TurnAccounting[] {
    const rows = this.#db
      .query(
        `SELECT * FROM goal_turn_accounting
          WHERE goal_id = ?
          ORDER BY started_at ASC, id ASC`,
      )
      .all(goalId) as TurnAccountingRow[];
    return rows.map(rowToTurnAccounting);
  }

  incrementContinuation(goalId: string): Goal {
    this.requireGoal(goalId);
    this.#db
      .query(
        `UPDATE session_goals
            SET continuation_count = continuation_count + 1, updated_at = ?
          WHERE goal_id = ?`,
      )
      .run(Date.now(), goalId);
    return this.requireGoal(goalId);
  }

  setBlockedStreak(goalId: string, streak: number): Goal {
    if (!Number.isInteger(streak) || streak < 0) {
      throw new GoalRepositoryError("blocked_streak 必须是非负整数");
    }
    this.requireGoal(goalId);
    this.#db
      .query("UPDATE session_goals SET blocked_streak = ?, updated_at = ? WHERE goal_id = ?")
      .run(streak, Date.now(), goalId);
    return this.requireGoal(goalId);
  }

  /* --------------------------- checkpoints --------------------------- */

  addCheckpoints(
    goalId: string,
    definitions: readonly CheckpointDefinition[],
    now = Date.now(),
  ): Checkpoint[] {
    this.requireGoal(goalId);
    if (definitions.length === 0) throw new GoalRepositoryError("Checkpoint 不能为空");
    if (definitions.length > 20) {
      throw new GoalRepositoryError("单个 Goal 最多 20 个 Checkpoint；请合并微步骤");
    }

    const ids = definitions.map((definition) => definition.id ?? newId("cp"));
    const idSet = new Set<string>();
    const orderSet = new Set<number>();
    for (let index = 0; index < definitions.length; index += 1) {
      const id = ids[index]!;
      const definition = definitions[index]!;
      if (idSet.has(id)) throw new GoalRepositoryError(`Checkpoint id 重复：${id}`);
      idSet.add(id);
      if (!Number.isInteger(definition.order) || definition.order <= 0) {
        throw new GoalRepositoryError("Checkpoint order 必须是正整数");
      }
      if (orderSet.has(definition.order)) {
        throw new GoalRepositoryError(`Checkpoint order 重复：${definition.order}`);
      }
      orderSet.add(definition.order);
      nonEmpty(definition.title, "checkpoint.title");
      nonEmpty(definition.deliverable, "checkpoint.deliverable");
      nonEmptyList(definition.acceptanceCriteria, "acceptance_criteria");
      nonEmptyList(definition.evidenceRequired, "evidence_required");
    }

    const byId = new Map(ids.map((id, index) => [id, definitions[index]!]));
    assertAcyclic(ids, (id) => byId.get(id)?.dependsOn ?? [], "Checkpoint");

    const existing = this.listCheckpoints(goalId);
    for (const checkpoint of existing) {
      if (idSet.has(checkpoint.id)) {
        throw new GoalRepositoryError(`Checkpoint id 已存在：${checkpoint.id}`);
      }
      if (orderSet.has(checkpoint.order)) {
        throw new GoalRepositoryError(`Checkpoint order 已存在：${checkpoint.order}`);
      }
    }

    const tx = this.#db.transaction(() => {
      for (let index = 0; index < definitions.length; index += 1) {
        const definition = definitions[index]!;
        this.#db
          .query(
            `INSERT INTO goal_checkpoints
             (checkpoint_id, goal_id, ordinal, title, deliverable, acceptance_criteria,
              evidence_required, depends_on, status, created_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
          )
          .run(
            ids[index]!,
            goalId,
            definition.order,
            definition.title.trim(),
            definition.deliverable.trim(),
            JSON.stringify(definition.acceptanceCriteria),
            JSON.stringify(definition.evidenceRequired),
            JSON.stringify(definition.dependsOn ?? []),
            now,
          );
      }
      this.#db
        .query("UPDATE session_goals SET updated_at = ? WHERE goal_id = ?")
        .run(now, goalId);
    });
    tx.immediate();

    return ids.map((id) => this.requireCheckpoint(id));
  }

  addCheckpoint(
    goalId: string,
    definition: CheckpointDefinition,
    now = Date.now(),
  ): Checkpoint {
    return this.addCheckpoints(goalId, [definition], now)[0]!;
  }

  getCheckpoint(checkpointId: string): Checkpoint | undefined {
    const row = this.#db
      .query("SELECT * FROM goal_checkpoints WHERE checkpoint_id = ?")
      .get(checkpointId) as CheckpointRow | null;
    return row === null ? undefined : rowToCheckpoint(row);
  }

  requireCheckpoint(checkpointId: string): Checkpoint {
    const checkpoint = this.getCheckpoint(checkpointId);
    if (checkpoint === undefined) {
      throw new GoalRepositoryError(`未知 Checkpoint：${checkpointId}`);
    }
    return checkpoint;
  }

  listCheckpoints(goalId: string): Checkpoint[] {
    const rows = this.#db
      .query("SELECT * FROM goal_checkpoints WHERE goal_id = ? ORDER BY ordinal ASC")
      .all(goalId) as CheckpointRow[];
    return rows.map(rowToCheckpoint);
  }

  getCurrentCheckpoint(goalId: string): Checkpoint | undefined {
    const goal = this.requireGoal(goalId);
    return goal.activeCheckpointId === undefined
      ? undefined
      : this.getCheckpoint(goal.activeCheckpointId);
  }

  activateCheckpoint(checkpointId: string, now = Date.now()): Checkpoint {
    const checkpoint = this.requireCheckpoint(checkpointId);
    if (checkpoint.status !== "pending" && checkpoint.status !== "blocked") {
      throw new GoalRepositoryError(
        `Checkpoint ${checkpointId} 不能从 ${checkpoint.status} 激活`,
      );
    }
    const goal = this.requireGoal(checkpoint.goalId);
    const incompleteDependency = checkpoint.dependsOn.find(
      (dependencyId) => this.requireCheckpoint(dependencyId).status !== "completed",
    );
    if (incompleteDependency !== undefined) {
      throw new GoalRepositoryError(`前置 Checkpoint 尚未完成：${incompleteDependency}`);
    }
    if (
      goal.activeCheckpointId !== undefined &&
      goal.activeCheckpointId !== checkpointId
    ) {
      throw new GoalRepositoryError(
        `Goal 已有活动 Checkpoint：${goal.activeCheckpointId}`,
      );
    }

    const tx = this.#db.transaction(() => {
      this.#db
        .query(
          `UPDATE goal_checkpoints
              SET status = 'active', completed_at = NULL
            WHERE checkpoint_id = ?`,
        )
        .run(checkpointId);
      this.#db
        .query(
          `UPDATE session_goals
              SET active_checkpoint_id = ?, updated_at = ?
            WHERE goal_id = ?`,
        )
        .run(checkpointId, now, checkpoint.goalId);
    });
    tx.immediate();
    return this.requireCheckpoint(checkpointId);
  }

  setCheckpointStatus(
    checkpointId: string,
    status: CheckpointStatus,
    now = Date.now(),
  ): Checkpoint {
    const checkpoint = this.requireCheckpoint(checkpointId);
    if (checkpoint.status === status) return checkpoint;
    if (!CHECKPOINT_STATUS_TRANSITIONS[checkpoint.status].includes(status)) {
      throw new GoalRepositoryError(
        `非法 Checkpoint 状态转换：${checkpoint.status} -> ${status}`,
      );
    }

    const tx = this.#db.transaction(() => {
      this.#db
        .query(
          `UPDATE goal_checkpoints
              SET status = ?, completed_at = ?
            WHERE checkpoint_id = ?`,
        )
        .run(status, status === "completed" ? now : null, checkpointId);
      if (status === "completed") {
        this.#db
          .query(
            `UPDATE session_goals
                SET active_checkpoint_id = CASE
                      WHEN active_checkpoint_id = ? THEN NULL
                      ELSE active_checkpoint_id
                    END,
                    updated_at = ?
              WHERE goal_id = ?`,
          )
          .run(checkpointId, now, checkpoint.goalId);
      } else {
        this.#db
          .query("UPDATE session_goals SET updated_at = ? WHERE goal_id = ?")
          .run(now, checkpoint.goalId);
      }
    });
    tx.immediate();
    return this.requireCheckpoint(checkpointId);
  }

  checkpointProgress(goalId: string): { completed: number; total: number } {
    const checkpoints = this.listCheckpoints(goalId);
    return {
      completed: checkpoints.filter((checkpoint) => checkpoint.status === "completed").length,
      total: checkpoints.length,
    };
  }

  /* --------------------------- plans --------------------------- */

  /**
   * 初始 Plan 与 Checkpoint 必须原子写入。
   *
   * 如果先写 checkpoints、后写 plan，中间 crash 会留下没有策略依据的孤立阶段；
   * 这里用一个 immediate transaction 消除该状态。
   */
  createInitialPlan(
    goalId: string,
    input: InitialPlanInput,
  ): { plan: PlanRevision; checkpoints: Checkpoint[] } {
    this.requireGoal(goalId);
    if (this.listPlanRevisions(goalId).length > 0) {
      throw new GoalRepositoryError("初始 Plan 已存在；后续变化请使用 appendPlanRevision");
    }
    if (this.listCheckpoints(goalId).length > 0) {
      throw new GoalRepositoryError("Goal 已有 Checkpoint，不能再创建初始 Plan");
    }
    if (input.phases.length === 0) throw new GoalRepositoryError("Plan 至少需要一个 phase");
    if (input.checkpoints.length === 0) throw new GoalRepositoryError("Checkpoint 不能为空");
    if (input.checkpoints.length > 20) {
      throw new GoalRepositoryError("单个 Goal 最多 20 个 Checkpoint；请合并微步骤");
    }

    const checkpointIds = input.checkpoints.map(
      (definition) => definition.id ?? newId("cp"),
    );
    const checkpointIdSet = new Set<string>();
    const checkpointOrderSet = new Set<number>();
    for (let index = 0; index < input.checkpoints.length; index += 1) {
      const checkpointId = checkpointIds[index]!;
      const definition = input.checkpoints[index]!;
      if (checkpointIdSet.has(checkpointId)) {
        throw new GoalRepositoryError(`Checkpoint id 重复：${checkpointId}`);
      }
      checkpointIdSet.add(checkpointId);
      if (!Number.isInteger(definition.order) || definition.order <= 0) {
        throw new GoalRepositoryError("Checkpoint order 必须是正整数");
      }
      if (checkpointOrderSet.has(definition.order)) {
        throw new GoalRepositoryError(`Checkpoint order 重复：${definition.order}`);
      }
      checkpointOrderSet.add(definition.order);
      nonEmpty(definition.title, "checkpoint.title");
      nonEmpty(definition.deliverable, "checkpoint.deliverable");
      nonEmptyList(definition.acceptanceCriteria, "acceptance_criteria");
      nonEmptyList(definition.evidenceRequired, "evidence_required");
    }
    const checkpointById = new Map(
      checkpointIds.map((checkpointId, index) => [checkpointId, input.checkpoints[index]!]),
    );
    assertAcyclic(
      checkpointIds,
      (checkpointId) => checkpointById.get(checkpointId)?.dependsOn ?? [],
      "Checkpoint",
    );

    const phaseIds = input.phases.map((phase) => phase.id);
    if (new Set(phaseIds).size !== phaseIds.length) {
      throw new GoalRepositoryError("Plan phase id 重复");
    }
    for (const phase of input.phases) {
      nonEmpty(phase.id, "plan_phase.id");
      nonEmpty(phase.title, "plan_phase.title");
      nonEmpty(phase.objective, "plan_phase.objective");
      nonEmptyList(phase.verification, "plan_phase.verification");
      if (phase.checkpointIds.length === 0) {
        throw new GoalRepositoryError(`Plan phase ${phase.id} 至少需要关联一个 Checkpoint`);
      }
      for (const checkpointId of phase.checkpointIds) {
        if (!checkpointIdSet.has(checkpointId)) {
          throw new GoalRepositoryError(
            `Plan phase ${phase.id} 引用了不存在的 Checkpoint：${checkpointId}`,
          );
        }
      }
    }
    const phaseById = new Map(input.phases.map((phase) => [phase.id, phase]));
    assertAcyclic(phaseIds, (phaseId) => phaseById.get(phaseId)?.dependsOn ?? [], "Plan phase");

    const now = input.now ?? Date.now();
    const planId = input.id ?? newId("plan");
    const tx = this.#db.transaction(() => {
      for (let index = 0; index < input.checkpoints.length; index += 1) {
        const definition = input.checkpoints[index]!;
        this.#db
          .query(
            `INSERT INTO goal_checkpoints
             (checkpoint_id, goal_id, ordinal, title, deliverable, acceptance_criteria,
              evidence_required, depends_on, status, created_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
          )
          .run(
            checkpointIds[index]!,
            goalId,
            definition.order,
            definition.title.trim(),
            definition.deliverable.trim(),
            JSON.stringify(definition.acceptanceCriteria),
            JSON.stringify(definition.evidenceRequired),
            JSON.stringify(definition.dependsOn ?? []),
            now,
          );
      }
      this.#db
        .query(
          `INSERT INTO goal_plan_revisions
           (plan_id, goal_id, revision, phases, assumptions, created_at)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(
          planId,
          goalId,
          JSON.stringify(input.phases),
          JSON.stringify(input.assumptions ?? []),
          now,
        );
      this.#db
        .query("UPDATE session_goals SET updated_at = ? WHERE goal_id = ?")
        .run(now, goalId);
    });
    tx.immediate();

    return {
      plan: this.requirePlanRevision(planId),
      checkpoints: checkpointIds.map((checkpointId) => this.requireCheckpoint(checkpointId)),
    };
  }

  appendPlanRevision(goalId: string, input: PlanRevisionInput): PlanRevision {
    this.requireGoal(goalId);
    if (input.phases.length === 0) throw new GoalRepositoryError("Plan 至少需要一个 phase");
    const ids = input.phases.map((phase) => phase.id);
    if (new Set(ids).size !== ids.length) throw new GoalRepositoryError("Plan phase id 重复");
    for (const phase of input.phases) {
      nonEmpty(phase.id, "plan_phase.id");
      nonEmpty(phase.title, "plan_phase.title");
      nonEmpty(phase.objective, "plan_phase.objective");
      nonEmptyList(phase.verification, "plan_phase.verification");
      if (phase.checkpointIds.length === 0) {
        throw new GoalRepositoryError(`Plan phase ${phase.id} 至少需要关联一个 Checkpoint`);
      }
      for (const checkpointId of phase.checkpointIds) {
        const checkpoint = this.requireCheckpoint(checkpointId);
        if (checkpoint.goalId !== goalId) {
          throw new GoalRepositoryError(`Plan 引用了其他 Goal 的 Checkpoint：${checkpointId}`);
        }
      }
    }
    const byId = new Map(input.phases.map((phase) => [phase.id, phase]));
    assertAcyclic(ids, (id) => byId.get(id)?.dependsOn ?? [], "Plan phase");

    const next = this.#db
      .query(
        "SELECT COALESCE(MAX(revision) + 1, 1) AS revision FROM goal_plan_revisions WHERE goal_id = ?",
      )
      .get(goalId) as { revision: number };
    const id = input.id ?? newId("plan");
    const now = input.now ?? Date.now();
    this.#db
      .query(
        `INSERT INTO goal_plan_revisions
         (plan_id, goal_id, revision, phases, assumptions, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        goalId,
        next.revision,
        JSON.stringify(input.phases),
        JSON.stringify(input.assumptions ?? []),
        now,
      );
    this.#db
      .query("UPDATE session_goals SET updated_at = ? WHERE goal_id = ?")
      .run(now, goalId);
    return this.requirePlanRevision(id);
  }

  getPlanRevision(planId: string): PlanRevision | undefined {
    const row = this.#db
      .query("SELECT * FROM goal_plan_revisions WHERE plan_id = ?")
      .get(planId) as PlanRow | null;
    return row === null ? undefined : rowToPlan(row);
  }

  requirePlanRevision(planId: string): PlanRevision {
    const plan = this.getPlanRevision(planId);
    if (plan === undefined) throw new GoalRepositoryError(`未知 Plan revision：${planId}`);
    return plan;
  }

  latestPlanRevision(goalId: string): PlanRevision | undefined {
    const row = this.#db
      .query(
        `SELECT * FROM goal_plan_revisions
          WHERE goal_id = ?
          ORDER BY revision DESC
          LIMIT 1`,
      )
      .get(goalId) as PlanRow | null;
    return row === null ? undefined : rowToPlan(row);
  }

  listPlanRevisions(goalId: string): PlanRevision[] {
    const rows = this.#db
      .query("SELECT * FROM goal_plan_revisions WHERE goal_id = ? ORDER BY revision ASC")
      .all(goalId) as PlanRow[];
    return rows.map(rowToPlan);
  }

  /* --------------------------- todos --------------------------- */

  replaceTodoSnapshot(goalId: string, input: TodoSnapshotInput): TodoSnapshot {
    this.requireGoal(goalId);
    const checkpoint = this.requireCheckpoint(input.checkpointId);
    if (checkpoint.goalId !== goalId) {
      throw new GoalRepositoryError(`Checkpoint ${input.checkpointId} 不属于 Goal ${goalId}`);
    }
    if (input.todos.length === 0) {
      throw new GoalRepositoryError("Todo snapshot 不能为空");
    }

    const ids = new Set<string>();
    let inProgress = 0;
    const todos: GoalTodo[] = input.todos.map((todo, index) => {
      const id = nonEmpty(todo.id, `todos[${index}].id`);
      if (ids.has(id)) throw new GoalRepositoryError(`Todo id 重复：${id}`);
      ids.add(id);
      const content = nonEmpty(todo.content, `todos[${index}].content`);
      if (todo.status === "in_progress") inProgress += 1;
      if (todo.status === "completed" && (todo.completionEvidence?.length ?? 0) === 0) {
        throw new GoalRepositoryError(`Todo ${id} 标记 completed 时必须提供 completionEvidence`);
      }
      return {
        id,
        checkpointId: input.checkpointId,
        content,
        ...(todo.activeForm !== undefined ? { activeForm: todo.activeForm } : {}),
        status: todo.status,
        ...(todo.completionEvidence !== undefined
          ? { completionEvidence: [...todo.completionEvidence] }
          : {}),
      };
    });
    if (inProgress > 1) throw new GoalRepositoryError("同一时刻最多只能有一项 in_progress");

    const next = this.#db
      .query(
        "SELECT COALESCE(MAX(revision) + 1, 1) AS revision FROM goal_todo_snapshots WHERE goal_id = ?",
      )
      .get(goalId) as { revision: number };
    const id = input.id ?? newId("todo");
    const now = input.now ?? Date.now();
    this.#db
      .query(
        `INSERT INTO goal_todo_snapshots
         (snapshot_id, goal_id, checkpoint_id, revision, summary, todos, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        goalId,
        input.checkpointId,
        next.revision,
        input.summary?.trim() || null,
        JSON.stringify(todos),
        now,
      );
    this.#db
      .query("UPDATE session_goals SET updated_at = ? WHERE goal_id = ?")
      .run(now, goalId);
    return this.requireTodoSnapshot(id);
  }

  getTodoSnapshot(snapshotId: string): TodoSnapshot | undefined {
    const row = this.#db
      .query("SELECT * FROM goal_todo_snapshots WHERE snapshot_id = ?")
      .get(snapshotId) as TodoSnapshotRow | null;
    return row === null ? undefined : rowToTodoSnapshot(row);
  }

  requireTodoSnapshot(snapshotId: string): TodoSnapshot {
    const snapshot = this.getTodoSnapshot(snapshotId);
    if (snapshot === undefined) {
      throw new GoalRepositoryError(`未知 Todo snapshot：${snapshotId}`);
    }
    return snapshot;
  }

  latestTodoSnapshot(goalId: string, checkpointId?: string): TodoSnapshot | undefined {
    const row =
      checkpointId === undefined
        ? (this.#db
            .query(
              `SELECT * FROM goal_todo_snapshots
                WHERE goal_id = ?
                ORDER BY revision DESC
                LIMIT 1`,
            )
            .get(goalId) as TodoSnapshotRow | null)
        : (this.#db
            .query(
              `SELECT * FROM goal_todo_snapshots
                WHERE goal_id = ? AND checkpoint_id = ?
                ORDER BY revision DESC
                LIMIT 1`,
            )
            .get(goalId, checkpointId) as TodoSnapshotRow | null);
    return row === null ? undefined : rowToTodoSnapshot(row);
  }

  listTodoSnapshots(goalId: string): TodoSnapshot[] {
    const rows = this.#db
      .query(
        "SELECT * FROM goal_todo_snapshots WHERE goal_id = ? ORDER BY revision ASC",
      )
      .all(goalId) as TodoSnapshotRow[];
    return rows.map(rowToTodoSnapshot);
  }

  /* --------------------------- evidence --------------------------- */

  addEvidence(goalId: string, input: EvidenceInput): Evidence {
    this.requireGoal(goalId);
    if (!isOneOf(input.kind, EVIDENCE_KINDS)) {
      throw new GoalRepositoryError(`未知 Evidence kind：${String(input.kind)}`);
    }
    if (input.checkpointId !== undefined) {
      const checkpoint = this.requireCheckpoint(input.checkpointId);
      if (checkpoint.goalId !== goalId) {
        throw new GoalRepositoryError(`Checkpoint ${input.checkpointId} 不属于 Goal ${goalId}`);
      }
    }
    const id = input.id ?? newId("ev");
    const now = input.now ?? Date.now();
    this.#db
      .query(
        `INSERT INTO goal_evidence
         (evidence_id, goal_id, checkpoint_id, kind, summary, reference, digest, command,
          exit_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        goalId,
        input.checkpointId ?? null,
        input.kind,
        nonEmpty(input.summary, "evidence.summary"),
        nonEmpty(input.reference, "evidence.reference"),
        input.digest ?? null,
        input.command ?? null,
        input.exitCode ?? null,
        now,
      );
    this.#db
      .query("UPDATE session_goals SET updated_at = ? WHERE goal_id = ?")
      .run(now, goalId);
    return this.requireEvidence(id);
  }

  getEvidence(evidenceId: string): Evidence | undefined {
    const row = this.#db
      .query("SELECT * FROM goal_evidence WHERE evidence_id = ?")
      .get(evidenceId) as EvidenceRow | null;
    return row === null ? undefined : rowToEvidence(row);
  }

  requireEvidence(evidenceId: string): Evidence {
    const evidence = this.getEvidence(evidenceId);
    if (evidence === undefined) throw new GoalRepositoryError(`未知 Evidence：${evidenceId}`);
    return evidence;
  }

  listEvidence(goalId: string, checkpointId?: string): Evidence[] {
    const rows =
      checkpointId === undefined
        ? (this.#db
            .query(
              "SELECT * FROM goal_evidence WHERE goal_id = ? ORDER BY created_at ASC, rowid ASC",
            )
            .all(goalId) as EvidenceRow[])
        : (this.#db
            .query(
              `SELECT * FROM goal_evidence
                WHERE goal_id = ? AND checkpoint_id = ?
                ORDER BY created_at ASC, rowid ASC`,
            )
            .all(goalId, checkpointId) as EvidenceRow[]);
    return rows.map(rowToEvidence);
  }

  /* --------------------------- handoffs --------------------------- */

  createHandoffRevision(goalId: string, input: HandoffRevisionInput): HandoffRevision {
    this.requireGoal(goalId);
    const status = input.status ?? "active";
    if (status !== "active" && status !== "frozen" && status !== "archived") {
      throw new GoalRepositoryError(`未知 Handoff status：${String(status)}`);
    }
    if (input.supersedesRevision !== undefined) {
      const previous = this.getHandoffRevision(goalId, input.supersedesRevision);
      if (previous === undefined) {
        throw new GoalRepositoryError(`被替代的 Handoff revision 不存在：${input.supersedesRevision}`);
      }
    }

    const id = input.id ?? newId("handoff");
    const now = input.now ?? Date.now();
    const tx = this.#db.transaction(() => {
      if (status === "active") {
        this.#db
          .query(
            `UPDATE goal_handoffs
                SET status = 'frozen', updated_at = ?
              WHERE goal_id = ? AND status = 'active'`,
          )
          .run(now, goalId);
      }
      const next = this.#db
        .query(
          `SELECT COALESCE(MAX(revision) + 1, 1) AS revision
             FROM goal_handoffs
            WHERE goal_id = ?`,
        )
        .get(goalId) as { revision: number };
      this.#db
        .query(
          `INSERT INTO goal_handoffs
           (handoff_id, goal_id, revision, status, updated_by, current_state, markdown_path,
            snapshot_hash, supersedes_revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          goalId,
          next.revision,
          status,
          input.updatedBy,
          nonEmpty(input.currentState, "handoff.current_state"),
          nonEmpty(input.markdownPath, "handoff.markdown_path"),
          input.snapshotHash ?? null,
          input.supersedesRevision ?? null,
          now,
          now,
        );
      this.#db
        .query("UPDATE session_goals SET updated_at = ? WHERE goal_id = ?")
        .run(now, goalId);
    });
    tx.immediate();
    return this.requireHandoff(id);
  }

  getHandoff(handoffId: string): HandoffRevision | undefined {
    const row = this.#db
      .query("SELECT * FROM goal_handoffs WHERE handoff_id = ?")
      .get(handoffId) as HandoffRow | null;
    return row === null ? undefined : rowToHandoff(row);
  }

  requireHandoff(handoffId: string): HandoffRevision {
    const handoff = this.getHandoff(handoffId);
    if (handoff === undefined) throw new GoalRepositoryError(`未知 Handoff：${handoffId}`);
    return handoff;
  }

  getHandoffRevision(goalId: string, revision: number): HandoffRevision | undefined {
    const row = this.#db
      .query("SELECT * FROM goal_handoffs WHERE goal_id = ? AND revision = ?")
      .get(goalId, revision) as HandoffRow | null;
    return row === null ? undefined : rowToHandoff(row);
  }

  getCanonicalHandoff(goalId: string): HandoffRevision | undefined {
    const row = this.#db
      .query(
        `SELECT * FROM goal_handoffs
          WHERE goal_id = ?
          ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, revision DESC
          LIMIT 1`,
      )
      .get(goalId) as HandoffRow | null;
    return row === null ? undefined : rowToHandoff(row);
  }

  listHandoffRevisions(goalId: string): HandoffRevision[] {
    const rows = this.#db
      .query("SELECT * FROM goal_handoffs WHERE goal_id = ? ORDER BY revision ASC")
      .all(goalId) as HandoffRow[];
    return rows.map(rowToHandoff);
  }

  /* --------------------------- context epochs --------------------------- */

  createEpoch(goalId: string, input: ContextEpochInput): ContextEpoch {
    this.requireGoal(goalId);
    const handoff = this.requireHandoff(input.handoffId);
    if (handoff.goalId !== goalId) {
      throw new GoalRepositoryError(`Handoff ${input.handoffId} 不属于 Goal ${goalId}`);
    }
    if (handoff.snapshotHash === undefined) {
      throw new GoalRepositoryError("创建 Epoch 前必须为 Handoff 生成 snapshot hash");
    }
    const handoffSnapshotHash = handoff.snapshotHash;
    if (input.parentEpochId !== undefined) {
      const parent = this.requireEpoch(input.parentEpochId);
      if (parent.goalId !== goalId) {
        throw new GoalRepositoryError(`父 Epoch 不属于 Goal ${goalId}`);
      }
    }
    if (input.checkpointId !== undefined) {
      const checkpoint = this.requireCheckpoint(input.checkpointId);
      if (checkpoint.goalId !== goalId) {
        throw new GoalRepositoryError(`Checkpoint ${input.checkpointId} 不属于 Goal ${goalId}`);
      }
    }

    const id = input.id ?? newId("epoch");
    const now = input.now ?? Date.now();
    const tx = this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO goal_epochs
           (epoch_id, goal_id, branch_id, parent_epoch_id, checkpoint_id, handoff_id,
            handoff_revision, handoff_snapshot_hash, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          goalId,
          nonEmpty(input.branchId, "epoch.branch_id"),
          input.parentEpochId ?? null,
          input.checkpointId ?? null,
          input.handoffId,
          handoff.revision,
          handoffSnapshotHash,
          input.reason,
          now,
        );
      this.#db
        .query(
          `UPDATE session_goals
              SET active_epoch_id = ?, updated_at = ?
            WHERE goal_id = ?`,
        )
        .run(id, now, goalId);
    });
    tx.immediate();
    return this.requireEpoch(id);
  }

  getEpoch(epochId: string): ContextEpoch | undefined {
    const row = this.#db
      .query("SELECT * FROM goal_epochs WHERE epoch_id = ?")
      .get(epochId) as EpochRow | null;
    return row === null ? undefined : rowToEpoch(row);
  }

  requireEpoch(epochId: string): ContextEpoch {
    const epoch = this.getEpoch(epochId);
    if (epoch === undefined) throw new GoalRepositoryError(`未知 Epoch：${epochId}`);
    return epoch;
  }

  listEpochs(goalId: string): ContextEpoch[] {
    const rows = this.#db
      .query("SELECT * FROM goal_epochs WHERE goal_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(goalId) as EpochRow[];
    return rows.map(rowToEpoch);
  }

  /* --------------------------- reviews --------------------------- */

  createReview(goalId: string, input: ReviewInput): GoalReview {
    this.requireGoal(goalId);
    const checkpoint = this.requireCheckpoint(input.checkpointId);
    if (checkpoint.goalId !== goalId) {
      throw new GoalRepositoryError(`Checkpoint ${input.checkpointId} 不属于 Goal ${goalId}`);
    }
    const now = input.now ?? Date.now();
    let round = input.round;
    if (round === undefined) {
      const row = this.#db
        .query(
          `SELECT COALESCE(MAX(round) + 1, 1) AS round
             FROM goal_reviews
            WHERE goal_id = ? AND checkpoint_id = ?`,
        )
        .get(goalId, input.checkpointId) as { round: number };
      round = row.round;
    }
    if (!Number.isInteger(round) || round <= 0) {
      throw new GoalRepositoryError("review round 必须是正整数");
    }

    const id = input.id ?? newId("review");
    this.#db
      .query(
        `INSERT INTO goal_reviews
         (review_id, goal_id, checkpoint_id, round, status, reviewer, base_revision,
          head_revision, diff_hash, verdict, criteria_coverage, unresolved_questions,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, 'requested', ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        goalId,
        input.checkpointId,
        round,
        nonEmpty(input.reviewer, "review.reviewer"),
        nonEmpty(input.baseRevision, "review.base_revision"),
        nonEmpty(input.headRevision, "review.head_revision"),
        nonEmpty(input.diffHash, "review.diff_hash"),
        JSON.stringify(input.criteriaCoverage ?? []),
        JSON.stringify(input.unresolvedQuestions ?? []),
        now,
        now,
      );
    return this.requireReview(id);
  }

  getReview(reviewId: string): GoalReview | undefined {
    const row = this.#db
      .query("SELECT * FROM goal_reviews WHERE review_id = ?")
      .get(reviewId) as ReviewRow | null;
    return row === null ? undefined : rowToReview(row);
  }

  requireReview(reviewId: string): GoalReview {
    const review = this.getReview(reviewId);
    if (review === undefined) throw new GoalRepositoryError(`未知 Review：${reviewId}`);
    return review;
  }

  listReviews(goalId: string, checkpointId?: string): GoalReview[] {
    const rows =
      checkpointId === undefined
        ? (this.#db
            .query(
              "SELECT * FROM goal_reviews WHERE goal_id = ? ORDER BY created_at ASC, rowid ASC",
            )
            .all(goalId) as ReviewRow[])
        : (this.#db
            .query(
              `SELECT * FROM goal_reviews
                WHERE goal_id = ? AND checkpoint_id = ?
                ORDER BY round ASC`,
            )
            .all(goalId, checkpointId) as ReviewRow[]);
    return rows.map(rowToReview);
  }

  setReviewStatus(reviewId: string, status: ReviewStatus): GoalReview {
    const review = this.requireReview(reviewId);
    if (review.status === status) return review;
    if (!isOneOf(status, REVIEW_STATUSES)) {
      throw new GoalRepositoryError(`未知 Review status：${String(status)}`);
    }
    if (!REVIEW_STATUS_TRANSITIONS[review.status].includes(status)) {
      throw new GoalRepositoryError(`非法 Review 状态转换：${review.status} -> ${status}`);
    }
    this.#db
      .query("UPDATE goal_reviews SET status = ?, updated_at = ? WHERE review_id = ?")
      .run(status, Date.now(), reviewId);
    return this.requireReview(reviewId);
  }

  completeReview(reviewId: string, result: ReviewResult): GoalReview {
    const review = this.requireReview(reviewId);
    if (review.status !== "running") {
      throw new GoalRepositoryError(`Review 只能在 running 时提交结果，当前为 ${review.status}`);
    }
    const status: ReviewStatus =
      result.verdict === "approve"
        ? "approved"
        : result.verdict === "changes_requested"
          ? "changes_requested"
          : "blocked";
    if (!REVIEW_STATUS_TRANSITIONS[review.status].includes(status)) {
      throw new GoalRepositoryError(`非法 Review 结果：${review.status} -> ${status}`);
    }

    const tx = this.#db.transaction(() => {
      this.#db
        .query(
          `UPDATE goal_reviews
              SET status = ?, verdict = ?, criteria_coverage = ?,
                  unresolved_questions = ?, updated_at = ?
            WHERE review_id = ?`,
        )
        .run(
          status,
          result.verdict,
          JSON.stringify(result.criteriaCoverage),
          JSON.stringify(result.unresolvedQuestions),
          Date.now(),
          reviewId,
        );
      for (const finding of result.findings) {
        this.#db
          .query(
            `INSERT INTO goal_review_findings
             (finding_id, review_id, severity, title, evidence, requested_change)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId("finding"),
            reviewId,
            finding.severity,
            nonEmpty(finding.title, "finding.title"),
            nonEmpty(finding.evidence, "finding.evidence"),
            finding.requestedChange ?? null,
          );
      }

      const checkpoint = this.requireCheckpoint(review.checkpointId);
      if (status === "changes_requested" && checkpoint.status === "reviewing") {
        this.#db
          .query("UPDATE goal_checkpoints SET status = 'active' WHERE checkpoint_id = ?")
          .run(checkpoint.id);
      } else if (status === "blocked" && checkpoint.status === "reviewing") {
        this.#db
          .query("UPDATE goal_checkpoints SET status = 'blocked' WHERE checkpoint_id = ?")
          .run(checkpoint.id);
      }
    });
    tx.immediate();
    return this.requireReview(reviewId);
  }

  listReviewFindings(reviewId: string): ReviewFinding[] {
    this.requireReview(reviewId);
    const rows = this.#db
      .query("SELECT * FROM goal_review_findings WHERE review_id = ? ORDER BY rowid ASC")
      .all(reviewId) as ReviewFindingRow[];
    return rows.map(rowToFinding);
  }
}
