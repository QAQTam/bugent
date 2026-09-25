/**
 * Deterministic Goal checkpoint verification.
 *
 * This layer never trusts a model's prose. It only accepts structured evidence
 * and verifies the parts that can be checked without semantic judgment:
 * todo completion, command exit codes, file existence/hashes, and evidence
 * categories required by the checkpoint.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { Checkpoint, Evidence, GoalTodo } from "./types.ts";
import { resolveWithin } from "../tools/paths.ts";

export interface VerificationEvidenceInput {
  kind: Evidence["kind"];
  summary: string;
  reference: string;
  digest?: string;
  command?: string;
  exitCode?: number;
}

export interface DeterministicVerificationInput {
  checkpoint: Checkpoint;
  todos: readonly GoalTodo[];
  evidence: readonly VerificationEvidenceInput[];
  cwd: string;
}

export interface DeterministicVerificationResult {
  ok: boolean;
  errors: string[];
  checkedEvidence: number;
}

function normalizeDigest(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

async function hashFile(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const hash = createHash("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}

export async function verifyCheckpointDeterministically(
  input: DeterministicVerificationInput,
): Promise<DeterministicVerificationResult> {
  const errors: string[] = [];
  if (input.todos.length === 0) errors.push("the active checkpoint has no todo snapshot");
  for (const todo of input.todos) {
    if (todo.status !== "completed") {
      errors.push(`todo not completed: ${todo.id} (${todo.status})`);
    }
    if (
      todo.status === "completed" &&
      (todo.completionEvidence === undefined || todo.completionEvidence.length === 0)
    ) {
      errors.push(`todo is missing completionEvidence: ${todo.id}`);
    }
  }

  if (input.evidence.length === 0) {
    errors.push("a checkpoint needs at least one piece of evidence");
  }

  const kinds = new Set(input.evidence.map((evidence) => evidence.kind));
  for (const requirement of input.checkpoint.evidenceRequired) {
    const requiredKind = (["test", "command", "file", "diff", "runtime", "review", "user"] as const).find(
      (kind) => requirement.toLowerCase().includes(kind),
    );
    if (requiredKind !== undefined && !kinds.has(requiredKind)) {
      errors.push(`evidence is missing required kind ${requiredKind}: ${requirement}`);
    }
  }

  for (let index = 0; index < input.evidence.length; index += 1) {
    const evidence = input.evidence[index]!;
    const at = `evidence[${index}]`;
    if (evidence.summary.trim().length === 0) errors.push(`${at}.summary must not be empty`);
    if (evidence.reference.trim().length === 0) errors.push(`${at}.reference must not be empty`);

    if (evidence.kind === "test" || evidence.kind === "command" || evidence.kind === "runtime") {
      if (evidence.command === undefined || evidence.command.trim().length === 0) {
        errors.push(`${at} is missing command`);
      }
      if (evidence.exitCode !== 0) {
        errors.push(`${at} command exit code is not 0: ${String(evidence.exitCode)}`);
      }
    }

    if (evidence.kind === "file") {
      try {
        const path = resolveWithin(input.cwd, evidence.reference);
        const stat = statSync(path);
        if (!stat.isFile()) {
          errors.push(`${at} is not a regular file: ${evidence.reference}`);
        } else if (evidence.digest !== undefined) {
          const actual = await hashFile(path);
          if (normalizeDigest(evidence.digest).toLowerCase() !== actual.toLowerCase()) {
            errors.push(`${at} file hash mismatch: ${evidence.reference}`);
          }
        }
      } catch (error) {
        errors.push(
          `${at} file could not be verified: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, checkedEvidence: input.evidence.length };
}
