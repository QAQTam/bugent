/**
 * 打开或恢复一个 AgentSession。
 *
 * 这是 CLI / daemon / 多 session runtime 共用的 session 生命周期入口：
 * 有历史就按 msgid 恢复，没有就创建 session 记录并写入 system message。
 */

import type { ModelClient } from "../provider/types.ts";
import { mainBranchId, type SessionStore } from "../store/repository.ts";
import { AgentSession } from "./session.ts";

export interface OpenSessionOptions {
  store: SessionStore | undefined;
  sessionId: string;
  /** 指定要恢复的分支；省略时使用 session.activeBranchId。 */
  branchId?: string;
  client: ModelClient;
  model: string;
  providerId: string;
  systemPrompt: string;
  cwd: string;
}

export function openSession(options: OpenSessionOptions): AgentSession {
  const { store, sessionId } = options;

  if (store === undefined) {
    return new AgentSession({
      id: sessionId,
      ...(options.branchId !== undefined ? { branchId: options.branchId } : {}),
      system: options.systemPrompt,
      client: options.client,
      model: options.model,
    });
  }

  const existing = store.getSession(sessionId);
  if (existing !== undefined) {
    const branchId = options.branchId ?? existing.activeBranchId ?? mainBranchId(sessionId);
    if (store.getBranch(sessionId, branchId) === undefined) {
      throw new Error(`会话 ${sessionId} 不存在分支：${branchId}`);
    }
    return new AgentSession({
      id: sessionId,
      branchId,
      system: existing.systemPrompt,
      client: options.client,
      model: options.model,
      restore: store.loadBranchPath(sessionId, branchId),
      nextMsgId: store.nextMsgId(sessionId),
      onMessage: (message) => {
        store.appendMessageToBranch(sessionId, branchId, message, message.createdAt);
      },
    });
  }

  const now = Date.now();
  if (options.branchId !== undefined) {
    throw new Error(`新会话 ${sessionId} 不能指定分支：${options.branchId}`);
  }
  store.createSession({
    id: sessionId,
    createdAt: now,
    updatedAt: now,
    model: options.model,
    providerId: options.providerId,
    systemPrompt: options.systemPrompt,
    cwd: options.cwd,
  });
  const branchId = mainBranchId(sessionId);

  return new AgentSession({
    id: sessionId,
    branchId,
    system: options.systemPrompt,
    client: options.client,
    model: options.model,
    onMessage: (message) => {
      store.appendMessageToBranch(sessionId, branchId, message, message.createdAt);
    },
  });
}
