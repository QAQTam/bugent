/**
 * Goal Mode 2.0 domain model.
 *
 * These types are deliberately independent from the tool layer. Goal state is
 * durable and survives UI/tool changes; tool schemas only project parts of it.
 */

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

export type GoalPhase =
  | "draft"
  | "inspecting"
  | "clarifying"
  | "planning"
  | "ready"
  | "executing"
  | "checkpoint_audit"
  | "handoff"
  | "epoch_switch"
  | "final_audit";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ReviewPolicy = "off" | "medium" | "high" | "always";

export interface RiskPolicy {
  level: RiskLevel;
  requireUserApproval: boolean;
  reviewPolicy: ReviewPolicy;
  notes: string[];
}

export interface Criterion {
  id: string;
  text: string;
  evidenceRequired: string[];
}

export interface Goal {
  id: string;
  sessionId: string;
  rawIntent: string;
  objective: string;
  successCriteria: Criterion[];
  constraints: string[];
  nonGoals: string[];
  riskPolicy: RiskPolicy;
  status: GoalStatus;
  phase: GoalPhase;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  continuationCount: number;
  blockedStreak: number;
  activeCheckpointId?: string;
  activeEpochId?: string;
  createdAt: number;
  updatedAt: number;
}

export type CheckpointStatus =
  | "pending"
  | "active"
  | "verifying"
  | "reviewing"
  | "completed"
  | "blocked";

export interface Checkpoint {
  id: string;
  goalId: string;
  order: number;
  title: string;
  deliverable: string;
  acceptanceCriteria: string[];
  evidenceRequired: string[];
  dependsOn: string[];
  status: CheckpointStatus;
  createdAt: number;
  completedAt?: number;
}

export interface PlanPhase {
  id: string;
  title: string;
  objective: string;
  checkpointIds: string[];
  dependsOn: string[];
  risks: string[];
  verification: string[];
}

export interface PlanRevision {
  id: string;
  goalId: string;
  revision: number;
  phases: PlanPhase[];
  assumptions: string[];
  createdAt: number;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface GoalTodo {
  id: string;
  checkpointId: string;
  content: string;
  activeForm?: string;
  status: TodoStatus;
  completionEvidence?: string[];
}

export interface TodoSnapshot {
  id: string;
  goalId: string;
  checkpointId: string;
  revision: number;
  summary?: string;
  todos: GoalTodo[];
  createdAt: number;
}

export type EvidenceKind =
  | "test"
  | "command"
  | "file"
  | "diff"
  | "runtime"
  | "review"
  | "user";

export interface Evidence {
  id: string;
  goalId: string;
  checkpointId?: string;
  kind: EvidenceKind;
  summary: string;
  reference: string;
  digest?: string;
  command?: string;
  exitCode?: number;
  createdAt: number;
}

export type HandoffStatus = "active" | "frozen" | "archived";
export type HandoffActor = "system" | "worker" | "reviewer" | "user";

export interface HandoffRevision {
  id: string;
  goalId: string;
  revision: number;
  status: HandoffStatus;
  updatedBy: HandoffActor;
  currentState: string;
  markdownPath: string;
  snapshotHash?: string;
  supersedesRevision?: number;
  createdAt: number;
  updatedAt: number;
}

export type ContextEpochReason =
  | "checkpoint"
  | "context_limit"
  | "resume"
  | "blocked"
  | "manual";

export interface ContextEpoch {
  id: string;
  goalId: string;
  branchId: string;
  parentEpochId?: string;
  checkpointId?: string;
  handoffId: string;
  handoffRevision: number;
  handoffSnapshotHash: string;
  reason: ContextEpochReason;
  createdAt: number;
}

export type TurnOutcome = "progress" | "verified_wait" | "no_progress" | "error" | "aborted";

export interface TurnAccounting {
  id: number;
  goalId: string;
  turnId: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  activeSeconds: number;
  outcome: TurnOutcome;
  startedAt: number;
  endedAt: number;
}

export type ReviewStatus =
  | "requested"
  | "running"
  | "approved"
  | "changes_requested"
  | "blocked"
  | "stale";

export type ReviewVerdict = "approve" | "changes_requested" | "blocked";

export interface CriteriaCoverage {
  criterion: string;
  status: "proven" | "partial" | "missing";
  evidence: string[];
}

export interface ReviewFinding {
  id: string;
  reviewId: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  evidence: string;
  requestedChange?: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  criteriaCoverage: CriteriaCoverage[];
  findings: Array<Omit<ReviewFinding, "id" | "reviewId">>;
  unresolvedQuestions: string[];
}

export interface GoalReview {
  id: string;
  goalId: string;
  checkpointId: string;
  round: number;
  status: ReviewStatus;
  reviewer: string;
  baseRevision: string;
  headRevision: string;
  diffHash: string;
  verdict?: ReviewVerdict;
  criteriaCoverage: CriteriaCoverage[];
  unresolvedQuestions: string[];
  createdAt: number;
  updatedAt: number;
}

export const GOAL_STATUSES: readonly GoalStatus[] = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
];

export const GOAL_PHASES: readonly GoalPhase[] = [
  "draft",
  "inspecting",
  "clarifying",
  "planning",
  "ready",
  "executing",
  "checkpoint_audit",
  "handoff",
  "epoch_switch",
  "final_audit",
];

export const CHECKPOINT_STATUSES: readonly CheckpointStatus[] = [
  "pending",
  "active",
  "verifying",
  "reviewing",
  "completed",
  "blocked",
];

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "test",
  "command",
  "file",
  "diff",
  "runtime",
  "review",
  "user",
];

export const REVIEW_STATUSES: readonly ReviewStatus[] = [
  "requested",
  "running",
  "approved",
  "changes_requested",
  "blocked",
  "stale",
];
