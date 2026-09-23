/**
 * 工作区变更与行级 patch。
 *
 * 设计目标：
 *   1. 工具只报告 before/after，不直接关心 undo；
 *   2. 变更脚本挂在 tool result 消息上，天然跟随分支、恢复和回放；
 *   3. 不存整份文件，只存反向编辑脚本 + hash；
 *   4. apply 时逐行校验，冲突就拒绝，绝不做“尽力而为”的写坏文件。
 */

export interface WorkspaceFileEdit {
  path: string;
  before: string;
  after: string;
  beforeExists: boolean;
  afterExists: boolean;
  reversible?: boolean;
  irreversibleReason?: string;
}

export interface PatchOp {
  /** 在 before 文本中的起始行号（0-based）。 */
  at: number;
  /** 被删除的行，不含换行符。 */
  remove: string[];
  /** 插入的行，不含换行符。 */
  insert: string[];
}

export interface WorkspacePatch {
  ops: PatchOp[];
  beforeTrailingNewline: boolean;
  afterTrailingNewline: boolean;
}

export interface WorkspaceFileChange {
  path: string;
  beforeHash: string;
  afterHash: string;
  beforeExists: boolean;
  afterExists: boolean;
  reverse: WorkspacePatch;
  reversible: boolean;
  irreversibleReason?: string;
}

export interface WorkspaceChange {
  files: readonly WorkspaceFileChange[];
  reversible: boolean;
  irreversibleReason?: string;
}

export interface ApplyPatchOk {
  ok: true;
  text: string;
}

export interface ApplyPatchConflict {
  ok: false;
  at: number;
  expected: string[];
  actual: string[];
}

export type ApplyPatchResult = ApplyPatchOk | ApplyPatchConflict;

/** 按行切分，但保留“末尾是否有换行”的信息。 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function joinLines(lines: readonly string[], trailingNewline: boolean): string {
  if (lines.length === 0) return trailingNewline ? "\n" : "";
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

function lcsOps(a: readonly string[], b: readonly string[], offset: number): PatchOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: PatchOp[] = [];
  let i = 0;
  let j = 0;
  let pending: PatchOp | undefined;

  const flush = (): void => {
    if (pending !== undefined && (pending.remove.length > 0 || pending.insert.length > 0)) {
      ops.push(pending);
    }
    pending = undefined;
  };

  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i += 1;
      j += 1;
      continue;
    }
    if (pending === undefined) pending = { at: offset + i, remove: [], insert: [] };
    if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      pending.insert.push(b[j]!);
      j += 1;
    } else if (i < n) {
      pending.remove.push(a[i]!);
      i += 1;
    }
  }
  flush();
  return ops;
}

/** before -> after 的编辑脚本。 */
export function diffPatch(before: string, after: string): WorkspacePatch {
  const a = splitLines(before);
  const b = splitLines(after);
  const beforeTrailingNewline = before.endsWith("\n");
  const afterTrailingNewline = after.endsWith("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  if (middleA.length === 0 && middleB.length === 0) {
    return { ops: [], beforeTrailingNewline, afterTrailingNewline };
  }

  // 超长中间段退化为整体替换：仍然正确，只是 patch 不一定最小。
  const maxLcsCells = 250_000;
  if (middleA.length * middleB.length > maxLcsCells) {
    return {
      ops: [{ at: start, remove: middleA, insert: middleB }],
      beforeTrailingNewline,
      afterTrailingNewline,
    };
  }

  return {
    ops: lcsOps(middleA, middleB, start),
    beforeTrailingNewline,
    afterTrailingNewline,
  };
}

/** 把 before -> after 的 patch 翻成 after -> before。 */
export function reversePatch(patch: WorkspacePatch): WorkspacePatch {
  const ops: PatchOp[] = [];
  let delta = 0;
  for (const op of patch.ops) {
    ops.push({ at: op.at + delta, remove: op.insert, insert: op.remove });
    delta += op.insert.length - op.remove.length;
  }
  return {
    ops,
    beforeTrailingNewline: patch.afterTrailingNewline,
    afterTrailingNewline: patch.beforeTrailingNewline,
  };
}

export function applyPatch(text: string, patch: WorkspacePatch): ApplyPatchResult {
  const lines = splitLines(text);
  const out: string[] = [];
  let cursor = 0;

  for (const op of patch.ops) {
    if (op.at < cursor) {
      return { ok: false, at: op.at, expected: op.remove, actual: [] };
    }
    while (cursor < op.at && cursor < lines.length) out.push(lines[cursor++]!);
    const actual = lines.slice(op.at, op.at + op.remove.length);
    if (actual.length !== op.remove.length || !actual.every((line, index) => line === op.remove[index])) {
      return { ok: false, at: op.at, expected: op.remove, actual };
    }
    out.push(...op.insert);
    cursor = op.at + op.remove.length;
  }

  while (cursor < lines.length) out.push(lines[cursor++]!);
  return { ok: true, text: joinLines(out, patch.afterTrailingNewline) };
}

export function hashContent(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex").slice(0, 16);
}

/** 把工具报告的原始 before/after 转成可持久化的变更记录。 */
export function createWorkspaceChange(
  edits: readonly WorkspaceFileEdit[],
): WorkspaceChange | undefined {
  if (edits.length === 0) return undefined;

  const files = edits.map((edit): WorkspaceFileChange => {
    const reversible = edit.reversible !== false;
    return {
      path: edit.path,
      beforeHash: hashContent(edit.before),
      afterHash: hashContent(edit.after),
      beforeExists: edit.beforeExists,
      afterExists: edit.afterExists,
      reverse: reversePatch(diffPatch(edit.before, edit.after)),
      reversible,
      ...(edit.irreversibleReason !== undefined
        ? { irreversibleReason: edit.irreversibleReason }
        : {}),
    };
  });

  const reversible = files.every((file) => file.reversible);
  return {
    files,
    reversible,
    ...(!reversible ? { irreversibleReason: "包含不可逆工作区变更" } : {}),
  };
}
