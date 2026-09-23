/**
 * 工作区 undo —— 从分支路径里的 tool result 消息推导反向 patch。
 *
 * 约束：
 *   - 只撤销当前分支会被移出的消息；
 *   - 预览不写文件；
 *   - 应用是 all-or-nothing，先全部校验，再统一写；
 *   - 每个文件先检查最后一次 afterHash，避免覆盖用户/外部进程的新修改。
 */

import type { StoredMessage } from "./message.ts";
import { applyPatch, hashContent, type WorkspaceFileChange } from "./workspace.ts";

export interface WorkspaceFs {
  read(path: string): Promise<string | undefined>;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface WorkspaceUndoPlan {
  /** 按消息逆序排列的变更；应用时也按这个顺序执行。 */
  changes: readonly WorkspaceFileChange[];
  /** 将被反向 patch 的文件（去重）。 */
  files: readonly string[];
  /** 当前内容与记录不一致，不能安全撤销。 */
  conflicts: readonly string[];
  /** 无法撤销的变更描述。 */
  irreversible: readonly string[];
}

export interface WorkspaceUndoResult {
  ok: boolean;
  applied: readonly string[];
  conflicts: readonly string[];
  skipped: readonly string[];
}

function describeIrreversible(file: WorkspaceFileChange): string {
  return `${file.path}${file.irreversibleReason !== undefined ? `（${file.irreversibleReason}）` : ""}`;
}

function matchesAfterState(text: string | undefined, file: WorkspaceFileChange): boolean {
  if (!file.afterExists) return text === undefined;
  return text !== undefined && hashContent(text) === file.afterHash;
}

/**
 * 计算预览。read 失败或内容不匹配都按冲突处理，绝不静默覆盖。
 */
export async function planWorkspaceUndo(
  removedMessages: readonly StoredMessage[],
  fs: WorkspaceFs,
): Promise<WorkspaceUndoPlan> {
  const changes: WorkspaceFileChange[] = [];
  const latestByPath = new Map<string, WorkspaceFileChange>();
  const files: string[] = [];
  const irreversible: string[] = [];

  for (let index = removedMessages.length - 1; index >= 0; index -= 1) {
    const workspace = removedMessages[index]?.workspace;
    if (workspace === undefined) continue;

    for (const file of workspace.files) {
      changes.push(file);
      if (!file.reversible) {
        irreversible.push(describeIrreversible(file));
        continue;
      }
      if (!files.includes(file.path)) files.push(file.path);
      if (!latestByPath.has(file.path)) latestByPath.set(file.path, file);
    }
  }

  const conflicts: string[] = [];
  for (const [path, file] of latestByPath) {
    try {
      const current = await fs.read(path);
      if (!matchesAfterState(current, file)) conflicts.push(path);
    } catch {
      conflicts.push(path);
    }
  }

  return { changes, files, conflicts, irreversible };
}

/** 执行已通过预览的反向 patch；任何失败都不落盘。 */
export async function applyWorkspaceUndo(
  plan: WorkspaceUndoPlan,
  fs: WorkspaceFs,
): Promise<WorkspaceUndoResult> {
  if (plan.conflicts.length > 0) {
    return { ok: false, applied: [], conflicts: [...plan.conflicts], skipped: [...plan.irreversible] };
  }

  const staged = new Map<string, string | undefined>();
  const applied: string[] = [];
  const readStaged = async (path: string): Promise<string | undefined> => {
    if (staged.has(path)) return staged.get(path);
    const text = await fs.read(path);
    staged.set(path, text);
    return text;
  };

  for (const file of plan.changes) {
    if (!file.reversible) continue;

    const current = await readStaged(file.path);
    if (!matchesAfterState(current, file)) {
      return { ok: false, applied: [], conflicts: [file.path], skipped: [...plan.irreversible] };
    }

    if (!file.beforeExists) {
      // before 不存在：撤销就是删除文件。
      staged.set(file.path, undefined);
    } else if (!file.afterExists) {
      // after 不存在：撤销就是恢复 before 内容。
      const restored = applyPatch("", file.reverse);
      if (!restored.ok) {
        return { ok: false, applied: [], conflicts: [file.path], skipped: [...plan.irreversible] };
      }
      staged.set(file.path, restored.text);
    } else {
      if (current === undefined) {
        return { ok: false, applied: [], conflicts: [file.path], skipped: [...plan.irreversible] };
      }
      const reversed = applyPatch(current, file.reverse);
      if (!reversed.ok) {
        return { ok: false, applied: [], conflicts: [file.path], skipped: [...plan.irreversible] };
      }
      staged.set(file.path, reversed.text);
    }
    if (!applied.includes(file.path)) applied.push(file.path);
  }

  for (const [path, text] of staged) {
    if (text === undefined) await fs.remove(path);
    else await fs.write(path, text);
  }

  return { ok: true, applied, conflicts: [], skipped: [...plan.irreversible] };
}
