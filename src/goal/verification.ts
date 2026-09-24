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
  if (input.todos.length === 0) errors.push("当前 Checkpoint 没有 Todo snapshot");
  for (const todo of input.todos) {
    if (todo.status !== "completed") {
      errors.push(`Todo 未完成：${todo.id} (${todo.status})`);
    }
    if (
      todo.status === "completed" &&
      (todo.completionEvidence === undefined || todo.completionEvidence.length === 0)
    ) {
      errors.push(`Todo 缺少 completionEvidence：${todo.id}`);
    }
  }

  if (input.evidence.length === 0) {
    errors.push("Checkpoint 至少需要一条 Evidence");
  }

  const kinds = new Set(input.evidence.map((evidence) => evidence.kind));
  for (const requirement of input.checkpoint.evidenceRequired) {
    const requiredKind = (["test", "command", "file", "diff", "runtime", "review", "user"] as const).find(
      (kind) => requirement.toLowerCase().includes(kind),
    );
    if (requiredKind !== undefined && !kinds.has(requiredKind)) {
      errors.push(`Evidence 缺少要求类型 ${requiredKind}：${requirement}`);
    }
  }

  for (let index = 0; index < input.evidence.length; index += 1) {
    const evidence = input.evidence[index]!;
    const at = `evidence[${index}]`;
    if (evidence.summary.trim().length === 0) errors.push(`${at}.summary 不能为空`);
    if (evidence.reference.trim().length === 0) errors.push(`${at}.reference 不能为空`);

    if (evidence.kind === "test" || evidence.kind === "command" || evidence.kind === "runtime") {
      if (evidence.command === undefined || evidence.command.trim().length === 0) {
        errors.push(`${at} 缺少 command`);
      }
      if (evidence.exitCode !== 0) {
        errors.push(`${at} 命令退出码不是 0：${String(evidence.exitCode)}`);
      }
    }

    if (evidence.kind === "file") {
      try {
        const path = resolveWithin(input.cwd, evidence.reference);
        const stat = statSync(path);
        if (!stat.isFile()) {
          errors.push(`${at} 不是普通文件：${evidence.reference}`);
        } else if (evidence.digest !== undefined) {
          const actual = await hashFile(path);
          if (normalizeDigest(evidence.digest).toLowerCase() !== actual.toLowerCase()) {
            errors.push(`${at} 文件 hash 不匹配：${evidence.reference}`);
          }
        }
      } catch (error) {
        errors.push(
          `${at} 文件不可验证：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, checkedEvidence: input.evidence.length };
}
