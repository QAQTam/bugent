/**
 * Living Goal handoff.
 *
 * System facts are always rebuilt from SQLite. Model narrative is updated only
 * through structured patches, and every successful write creates a new
 * immutable handoff revision. Context Epoch snapshots are copied from one
 * revision and are never rewritten.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  GoalRepository,
  HandoffRevisionInput,
} from "../store/goal-repository.ts";
import type {
  Checkpoint,
  ContextEpoch,
  Evidence,
  Goal,
  GoalReview,
  HandoffActor,
  HandoffRevision,
  PlanRevision,
  TodoSnapshot,
} from "./types.ts";

export type HandoffNarrativeSection =
  | "work_log"
  | "decisions"
  | "risks"
  | "open_questions"
  | "file_map";

export interface HandoffPatch {
  section: HandoffNarrativeSection;
  operation: "append" | "correct";
  content: string;
  target?: string;
  reason?: string;
  evidence?: readonly string[];
}

export interface LivingHandoffBuilderOptions {
  repository: GoalRepository;
  sessionId: string;
  goalId: string;
  root: string;
}

const SECTION_TITLES: Record<HandoffNarrativeSection, string> = {
  work_log: "7. Work Log",
  decisions: "8. Decisions",
  risks: "9. Risks and Blockers",
  open_questions: "10. Open Questions",
  file_map: "11. File / Artifact Map",
};

const EMPTY_NARRATIVE: Record<HandoffNarrativeSection, string> = {
  work_log: "_No work log entries yet._",
  decisions: "_No decisions recorded yet._",
  risks: "| ID | Severity | Status | Risk / Blocker | Mitigation | Next Check |\n| --- | --- | --- | --- | --- | --- |\n| - | - | - | none | - | - |",
  open_questions:
    "| ID | Question | Needed For | Asked To | Status | Answer |\n| --- | --- | --- | --- | --- | --- |\n| - | - | - | - | - | - |",
  file_map:
    "| Path / Artifact | Purpose | State | Hash / Revision |\n| --- | --- | --- | --- |\n| - | - | - | - |",
};

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function canonicalHash(markdown: string): string {
  return sha256(markdown.replace(/^snapshot_hash: .*$/m, "snapshot_hash: pending"));
}

function renderGoalContract(goal: Goal): string {
  const criteria = goal.successCriteria
    .map((criterion) => `| ${criterion.id} | ${criterion.text} | pending | - |`)
    .join("\n");
  return [
    "### Objective",
    "",
    goal.objective,
    "",
    "### Success Criteria",
    "",
    "| ID | Criterion | Status | Evidence |",
    "| --- | --- | --- | --- |",
    criteria || "| - | - | - | - |",
    "",
    "### Constraints",
    "",
    goal.constraints.length > 0 ? goal.constraints.map((item) => `- ${item}`).join("\n") : "- (none)",
    "",
    "### Non-goals",
    "",
    goal.nonGoals.length > 0 ? goal.nonGoals.map((item) => `- ${item}`).join("\n") : "- (none)",
    "",
    "### Budget",
    "",
    "| Item | Used | Limit | Remaining |",
    "| --- | --- | --- | --- |",
    `| Tokens | ${goal.tokensUsed} | ${goal.tokenBudget ?? "-"} | ${
      goal.tokenBudget === undefined ? "-" : Math.max(0, goal.tokenBudget - goal.tokensUsed)
    } |`,
    `| Active time | ${goal.timeUsedSeconds}s | - | - |`,
  ].join("\n");
}

function renderCheckpoints(checkpoints: readonly Checkpoint[]): string {
  const rows = checkpoints
    .map(
      (checkpoint) =>
        `| ${checkpoint.id} | ${checkpoint.order} | ${checkpoint.title} | ${checkpoint.status} | ${checkpoint.acceptanceCriteria.join("; ")} |`,
    )
    .join("\n");
  return [
    "| ID | Order | Title | Status | Acceptance |",
    "| --- | --- | --- | --- | --- |",
    rows || "| - | - | - | - | - |",
  ].join("\n");
}

function renderPlan(plan: PlanRevision | undefined): string {
  if (plan === undefined) return "_No plan revision yet._";
  const phases = plan.phases
    .map(
      (phase) =>
        `| ${phase.id} | ${phase.checkpointIds.join(", ")} | ${phase.title} | ${phase.verification.join("; ")} |`,
    )
    .join("\n");
  return [
    `### Revision ${plan.revision}`,
    "",
    "| Phase | Checkpoints | Title | Verification |",
    "| --- | --- | --- | --- |",
    phases || "| - | - | - | - |",
    "",
    "### Assumptions",
    "",
    plan.assumptions.length > 0 ? plan.assumptions.map((item) => `- ${item}`).join("\n") : "- (none)",
  ].join("\n");
}

function renderTodos(snapshot: TodoSnapshot | undefined): string {
  if (snapshot === undefined) return "_No todo snapshot yet._";
  const rows = snapshot.todos
    .map(
      (todo) =>
        `| ${todo.id} | ${todo.checkpointId} | ${todo.content} | ${todo.status} | ${(todo.completionEvidence ?? []).join("; ") || "-"} |`,
    )
    .join("\n");
  return [
    `Snapshot revision: ${snapshot.revision}`,
    "",
    "| ID | Checkpoint | Task | Status | Evidence |",
    "| --- | --- | --- | --- | --- |",
    rows || "| - | - | - | - | - |",
  ].join("\n");
}

function renderEvidence(evidence: readonly Evidence[]): string {
  const rows = evidence
    .map(
      (item) =>
        `| ${item.id} | ${item.checkpointId ?? "-"} | ${item.kind} | ${item.reference} | ${item.digest ?? "-"} |`,
    )
    .join("\n");
  return [
    "| ID | Checkpoint | Kind | Command / Artifact | Digest |",
    "| --- | --- | --- | --- | --- |",
    rows || "| - | - | - | - | - |",
  ].join("\n");
}

function renderReviews(reviews: readonly GoalReview[]): string {
  const rows = reviews
    .map(
      (review) =>
        `| ${review.round} | ${review.checkpointId} | ${review.status} | ${review.verdict ?? "-"} |`,
    )
    .join("\n");
  return [
    "| Round | Checkpoint | Verdict | Findings |",
    "| --- | --- | --- | --- |",
    rows || "| - | - | - | - |",
  ].join("\n");
}

function renderEpochs(epochs: readonly ContextEpoch[]): string {
  const rows = epochs
    .map(
      (epoch) =>
        `| ${epoch.id} | ${epoch.branchId} | ${epoch.reason} | ${epoch.handoffRevision} | ${epoch.handoffSnapshotHash} |`,
    )
    .join("\n");
  return [
    "| Epoch | Branch | Reason | Handoff Revision | Snapshot |",
    "| --- | --- | --- | --- | --- |",
    rows || "| - | - | - | - | - |",
  ].join("\n");
}

function extractSection(markdown: string, title: string): string | undefined {
  const marker = `## ${title}`;
  const start = markdown.indexOf(marker);
  if (start < 0) return undefined;
  const contentStart = start + marker.length;
  const next = markdown.indexOf("\n## ", contentStart);
  return markdown.slice(contentStart, next < 0 ? markdown.length : next).trim();
}

function replaceSection(markdown: string, title: string, content: string): string {
  const marker = `## ${title}`;
  const start = markdown.indexOf(marker);
  if (start < 0) return `${markdown.trimEnd()}\n\n${marker}\n\n${content}\n`;
  const contentStart = start + marker.length;
  const next = markdown.indexOf("\n## ", contentStart);
  const end = next < 0 ? markdown.length : next;
  return `${markdown.slice(0, contentStart)}\n\n${content}\n${markdown.slice(end).replace(/^\n+/, "\n")}`;
}

function narrativeFrom(markdown: string | undefined): Record<HandoffNarrativeSection, string> {
  const result = { ...EMPTY_NARRATIVE };
  if (markdown === undefined) return result;
  for (const section of Object.keys(SECTION_TITLES) as HandoffNarrativeSection[]) {
    result[section] = extractSection(markdown, SECTION_TITLES[section]) ?? EMPTY_NARRATIVE[section];
  }
  return result;
}

function applyNarrativePatch(
  markdown: string,
  patch: HandoffPatch,
  actor: HandoffActor,
): string {
  const content = patch.content.trim();
  if (content.length === 0) throw new Error("handoff patch content must not be empty");
  const sectionTitle = SECTION_TITLES[patch.section];
  const current = extractSection(markdown, sectionTitle) ?? EMPTY_NARRATIVE[patch.section];
  const entryId = `${patch.section === "work_log" ? "W" : "H"}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const block =
    patch.operation === "correct"
      ? [
          `### ${entryId} · correction`,
          `- Actor: ${actor}`,
          `- Corrects: ${patch.target ?? "(unspecified)"}`,
          `- Reason: ${patch.reason ?? "(not provided)"}`,
          `- New value: ${content}`,
          ...(patch.evidence !== undefined && patch.evidence.length > 0
            ? [`- Evidence: ${patch.evidence.join(", ")}`]
            : []),
        ].join("\n")
      : [
          `### ${entryId}`,
          `- Actor: ${actor}`,
          `- Entry: ${content}`,
          ...(patch.evidence !== undefined && patch.evidence.length > 0
            ? [`- Evidence: ${patch.evidence.join(", ")}`]
            : []),
        ].join("\n");
  const next = current.startsWith("_No ") ? block : `${current}\n\n${block}`;
  return replaceSection(markdown, sectionTitle, next);
}

export function defaultHandoffRoot(home = homedir()): string {
  return join(home, ".bugent", "handoffs");
}

export class LivingHandoffBuilder {  readonly repository: GoalRepository;
  readonly sessionId: string;
  readonly goalId: string;
  readonly root: string;

  constructor(options: LivingHandoffBuilderOptions) {
    this.repository = options.repository;
    this.sessionId = options.sessionId;
    this.goalId = options.goalId;
    this.root = options.root;
  }

  get canonicalPath(): string {
    return join(this.root, this.sessionId, this.goalId, "HANDOFF.md");
  }

  snapshotPath(epochId: string): string {
    return join(this.root, this.sessionId, this.goalId, "epochs", `${epochId}.md`);
  }

  async readCanonical(): Promise<string | undefined> {
    try {
      return await readFile(this.canonicalPath, "utf8");
    } catch {
      return undefined;
    }
  }

  async sync(updatedBy: HandoffActor = "system"): Promise<HandoffRevision> {
    const goal = this.repository.requireGoal(this.goalId);
    const existing = await this.readCanonical();
    const narrative = narrativeFrom(existing);
    const checkpoints = this.repository.listCheckpoints(goal.id);
    const currentCheckpoint =
      goal.activeCheckpointId === undefined
        ? checkpoints.find((checkpoint) => checkpoint.status === "completed")
        : this.repository.getCheckpoint(goal.activeCheckpointId);
    const latestPlan = this.repository.latestPlanRevision(goal.id);
    const latestTodo = this.repository.latestTodoSnapshot(goal.id);
    const evidence = this.repository.listEvidence(goal.id);
    const reviews = this.repository.listReviews(goal.id);
    const epochs = this.repository.listEpochs(goal.id);
    const handoffRevisions = this.repository.listHandoffRevisions(goal.id);
    const nextRevision = (handoffRevisions.at(-1)?.revision ?? 0) + 1;

    const body = [
      `# Goal Handoff: ${goal.objective}`,
      "",
      "> This is the continuously maintained authoritative work document. Fact sections are maintained by the system; narrative sections are appended or corrected, never deleting earlier facts.",
      "",
      "## 1. Goal Contract",
      "",
      renderGoalContract(goal),
      "",
      "## 2. Current State",
      "",
      `- Goal status: ${goal.status}`,
      `- Phase: ${goal.phase}`,
      `- Current checkpoint: ${currentCheckpoint?.id ?? "-"}`,
      `- Last verified revision: ${reviews.at(-1)?.headRevision ?? "-"}`,
      `- Next action: continue current checkpoint until verifier/review passes`,
      `- Blockers: ${goal.status === "blocked" ? "yes" : "none"}`,
      "- Open questions: see section 10",
      "",
      "## 3. Checkpoints",
      "",
      renderCheckpoints(checkpoints),
      "",
      "## 4. Plan",
      "",
      renderPlan(latestPlan),
      "",
      "## 5. Todo Snapshot",
      "",
      renderTodos(latestTodo),
      "",
      "## 6. Evidence Ledger",
      "",
      renderEvidence(evidence),
      "",
      `## ${SECTION_TITLES.work_log}`,
      "",
      narrative.work_log,
      "",
      `## ${SECTION_TITLES.decisions}`,
      "",
      narrative.decisions,
      "",
      `## ${SECTION_TITLES.risks}`,
      "",
      narrative.risks,
      "",
      `## ${SECTION_TITLES.open_questions}`,
      "",
      narrative.open_questions,
      "",
      `## ${SECTION_TITLES.file_map}`,
      "",
      narrative.file_map,
      "",
      "## 12. Verification",
      "",
      renderReviews(reviews),
      "",
      "## 13. Review History",
      "",
      renderReviews(reviews),
      "",
      "## 14. Context Epoch Index",
      "",
      renderEpochs(epochs),
      "",
      "## 15. Revision History",
      "",
      `- Revision ${nextRevision} · ${new Date().toISOString()} · ${updatedBy} · sync`,
    ].join("\n");
    const draft = [
      "---",
      "handoff_version: 1",
      `goal_id: ${goal.id}`,
      `session_id: ${this.sessionId}`,
      `status: ${goal.status}`,
      `phase: ${goal.phase}`,
      `current_checkpoint: ${currentCheckpoint?.id ?? "-"}`,
      `revision: ${nextRevision}`,
      `updated_at: ${new Date().toISOString()}`,
      `updated_by: ${updatedBy}`,
      "snapshot_hash: pending",
      "---",
      "",
      body,
      "",
    ].join("\n");
    const snapshotHash = canonicalHash(draft);
    const markdown = draft.replace(
      /^snapshot_hash: pending$/m,
      `snapshot_hash: ${snapshotHash}`,
    );

    await mkdir(dirname(this.canonicalPath), { recursive: true });
    const temporary = `${this.canonicalPath}.tmp-${process.pid}`;
    await writeFile(temporary, markdown, "utf8");
    await rename(temporary, this.canonicalPath);

    const input: HandoffRevisionInput = {
      updatedBy,
      currentState: `${goal.status} · ${goal.phase} · checkpoint ${currentCheckpoint?.id ?? "-"}`,
      markdownPath: this.canonicalPath,
      snapshotHash,
    };
    return this.repository.createHandoffRevision(goal.id, input);
  }

  async applyPatches(
    baseRevision: number,
    actor: HandoffActor,
    patches: readonly HandoffPatch[],
  ): Promise<HandoffRevision> {
    const current = this.repository.getCanonicalHandoff(this.goalId);
    if (current === undefined) throw new Error("canonical handoff has not been created");
    if (current.revision !== baseRevision) {
      throw new Error(`handoff base revision is stale: expected ${current.revision}, received ${baseRevision}`);
    }
    if (patches.length === 0) throw new Error("handoff patch must not be empty");

    let markdown = await this.readCanonical();
    if (markdown === undefined) throw new Error("canonical HANDOFF.md does not exist");
    for (const patch of patches) {
      if (!Object.prototype.hasOwnProperty.call(SECTION_TITLES, patch.section)) {
        throw new Error(`patching system fact sections is not allowed: ${patch.section}`);
      }
      if (patch.operation !== "append" && patch.operation !== "correct") {
        throw new Error(`unsupported handoff patch operation: ${String(patch.operation)}`);
      }
      markdown = applyNarrativePatch(markdown, patch, actor);
    }

    const nextRevision = current.revision + 1;
    markdown = markdown.replace(/^revision: .*$/m, `revision: ${nextRevision}`);
    markdown = markdown.replace(/^updated_at: .*$/m, `updated_at: ${new Date().toISOString()}`);
    markdown = markdown.replace(/^updated_by: .*$/m, `updated_by: ${actor}`);
    markdown = markdown.replace(/^snapshot_hash: .*$/m, "snapshot_hash: pending");
    markdown = `${markdown.trimEnd()}\n- Revision ${nextRevision} · ${new Date().toISOString()} · ${actor} · patch\n`;
    const snapshotHash = canonicalHash(markdown);
    markdown = markdown.replace(
      /^snapshot_hash: pending$/m,
      `snapshot_hash: ${snapshotHash}`,
    );

    await mkdir(dirname(this.canonicalPath), { recursive: true });
    const temporary = `${this.canonicalPath}.tmp-${process.pid}`;
    await writeFile(temporary, markdown, "utf8");
    await rename(temporary, this.canonicalPath);

    return this.repository.createHandoffRevision(this.goalId, {
      updatedBy: actor,
      currentState: current.currentState,
      markdownPath: this.canonicalPath,
      snapshotHash,
      supersedesRevision: current.revision,
    });
  }

  async writeEpochSnapshot(epochId: string): Promise<{
    markdown: string;
    hash: string;
    path: string;
  }> {
    const markdown = await this.readCanonical();
    if (markdown === undefined) throw new Error("canonical HANDOFF.md does not exist");
    const path = this.snapshotPath(epochId);
    const hash = canonicalHash(markdown);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, markdown, "utf8");
    await rename(temporary, path);
    return { markdown, hash, path };
  }
}
