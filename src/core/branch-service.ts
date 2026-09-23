/**
 * BranchService —— fork / undo / retry 的分支规划。
 *
 * 这里只做三件事：
 *   1. 校验目标消息确实在当前活动分支上；
 *   2. 计算新分支应该从哪个 msgid 长出来；
 *   3. 通过 SessionStore 创建分支并切换 active branch。
 *
 * 原消息永不删除。所谓 undo 只是把 active branch 指向一条更短的新路径，
 * 旧路径仍留在消息树里，后续 branch switcher 可以重新打开。
 */

import type { MsgId, StoredMessage } from "./message.ts";
import { storedText } from "./message.ts";
import type { SessionStore } from "../store/repository.ts";

export type UndoMode = "at" | "before";

export interface BranchSelection {
  sessionId: string;
  /** 新创建、并已成为 active 的分支。 */
  branchId: string;
  /** 操作前所在的分支；用于解释“原分支保留在哪里”。 */
  sourceBranchId: string;
  /** 新分支的起点消息（inclusive）。 */
  fromMsgid: MsgId;
}

export interface UndoPreview {
  sessionId: string;
  /** 操作前所在的分支；用于解释“原分支保留在哪里”。 */
  sourceBranchId: string;
  /** 新分支的起点消息（inclusive）。 */
  fromMsgid: MsgId;
  targetMsgid: MsgId;
  mode: UndoMode;
  /** 新分支会保留的消息，包含起点消息。 */
  retained: readonly StoredMessage[];
  /** 将从当前分支移出的消息。 */
  removed: readonly StoredMessage[];
}

export interface RetryPlan {
  sessionId: string;
  /** 操作前所在的分支。 */
  sourceBranchId: string;
  /** 新分支的起点消息（inclusive）。 */
  fromMsgid: MsgId;
  /** 触发重试的可见消息。 */
  targetMsgid: MsgId;
  /** 实际要重发的 user 消息。 */
  userMsgid: MsgId;
  input: string;
  retained: readonly StoredMessage[];
  removed: readonly StoredMessage[];
}

function describeTarget(target: StoredMessage): string {
  const text = storedText(target).trim().replace(/\s+/g, " ");
  const preview = text.length > 42 ? `${text.slice(0, 41)}…` : text;
  return preview.length > 0 ? preview : target.role;
}

export class BranchService {
  #store: SessionStore;

  constructor(store: SessionStore) {
    this.#store = store;
  }

  #activePath(sessionId: string): { branchId: string; path: readonly StoredMessage[] } {
    const branchId = this.#store.getActiveBranchId(sessionId);
    if (branchId === undefined) throw new Error(`会话没有活动分支：${sessionId}`);
    return { branchId, path: this.#store.loadBranchPath(sessionId, branchId) };
  }

  #targetIndex(path: readonly StoredMessage[], targetMsgid: MsgId): number {
    if (targetMsgid === 0) throw new Error("不能对 system 消息执行分支操作");
    const index = path.findIndex((message) => message.msgid === targetMsgid);
    if (index < 0) throw new Error(`消息 ${targetMsgid} 不在当前活动分支上`);
    return index;
  }

  #createAndActivate(
    sessionId: string,
    sourceBranchId: string,
    fromMsgid: MsgId,
    title: string,
  ): BranchSelection {
    const branchId = this.#store.createBranch(sessionId, fromMsgid, {
      parentBranchId: sourceBranchId,
      title,
    });
    this.#store.setActiveBranch(sessionId, branchId);
    return { sessionId, branchId, sourceBranchId, fromMsgid };
  }

  /**
   * 从目标消息（inclusive）分叉。
   *
   * 适合“保留到这里的上下文，再换一种回答/实现继续走”。
   */
  fork(sessionId: string, fromMsgid: MsgId): BranchSelection {
    const { branchId, path } = this.#activePath(sessionId);
    const index = this.#targetIndex(path, fromMsgid);
    const target = path[index]!;
    return this.#createAndActivate(
      sessionId,
      branchId,
      fromMsgid,
      `fork #${fromMsgid} ${describeTarget(target)}`,
    );
  }

  /**
   * 只计算 undo 会保留/移出哪些消息，不修改 store。
   *
   * mode = "at"：保留目标消息，移除它之后的内容。
   * mode = "before"：目标消息本身也移除。
   */
  previewUndo(sessionId: string, targetMsgid: MsgId, mode: UndoMode = "at"): UndoPreview {
    const { branchId, path } = this.#activePath(sessionId);
    const index = this.#targetIndex(path, targetMsgid);
    const retainedCount = mode === "at" ? index + 1 : index;
    if (retainedCount <= 0) throw new Error("撤回不能移除 system 消息");
    const fromMsgid = path[retainedCount - 1]!.msgid;
    return {
      sessionId,
      sourceBranchId: branchId,
      fromMsgid,
      targetMsgid,
      mode,
      retained: path.slice(0, retainedCount),
      removed: path.slice(retainedCount),
    };
  }

  /** 创建撤回分支；原分支完整保留。 */
  undoTo(
    sessionId: string,
    targetMsgid: MsgId,
    mode: UndoMode = "at",
  ): UndoPreview & BranchSelection {
    const preview = this.previewUndo(sessionId, targetMsgid, mode);
    const target = preview.retained.at(-1)!;
    const selection = this.#createAndActivate(
      sessionId,
      preview.sourceBranchId,
      preview.fromMsgid,
      `undo #${targetMsgid} ${describeTarget(target)}`,
    );
    return { ...preview, ...selection };
  }

  /**
   * 规划一次 retry：找到目标之前最近的真实 user 消息，从它的父节点重新长分支。
   *
   * 如果点击的是 assistant/tool，重试语义就是重新回答它前面那条 user 消息；
   * 如果点击的就是 user，则重发这条 user。
   */
  planRetry(sessionId: string, targetMsgid: MsgId): RetryPlan {
    const { branchId, path } = this.#activePath(sessionId);
    const targetIndex = this.#targetIndex(path, targetMsgid);

    let userIndex = -1;
    for (let index = targetIndex; index >= 0; index -= 1) {
      if (path[index]?.role === "user" && path[index]?.origin === "user") {
        userIndex = index;
        break;
      }
    }
    if (userIndex < 0) throw new Error("目标之前没有可重试的 user 消息");

    const user = path[userIndex]!;
    const retainedCount = userIndex;
    if (retainedCount <= 0) throw new Error("重试不能移除 system 消息");
    const fromMsgid = path[retainedCount - 1]!.msgid;

    return {
      sessionId,
      sourceBranchId: branchId,
      fromMsgid,
      targetMsgid,
      userMsgid: user.msgid,
      input: storedText(user),
      retained: path.slice(0, retainedCount),
      removed: path.slice(retainedCount),
    };
  }

  retryFrom(sessionId: string, targetMsgid: MsgId): RetryPlan & BranchSelection {
    const plan = this.planRetry(sessionId, targetMsgid);
    const selection = this.#createAndActivate(
      sessionId,
      plan.sourceBranchId,
      plan.fromMsgid,
      `retry #${targetMsgid}`,
    );
    return { ...plan, ...selection };
  }
}
