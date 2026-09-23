/**
 * 打开或恢复一个 AgentSession。
 *
 * 这是 CLI / daemon / 多 session runtime 共用的 session 生命周期入口：
 * 有历史就按 msgid 恢复，没有就创建 session 记录并写入 system message。
 */

import type { ModelClient } from "../provider/types.ts";
import type { SessionStore } from "../store/repository.ts";
import { AgentSession } from "./session.ts";

export interface OpenSessionOptions {
  store: SessionStore | undefined;
  sessionId: string;
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
      system: options.systemPrompt,
      client: options.client,
      model: options.model,
    });
  }

  const existing = store.getSession(sessionId);
  if (existing !== undefined) {
    return new AgentSession({
      id: sessionId,
      system: existing.systemPrompt,
      client: options.client,
      model: options.model,
      restore: store.loadMessages(sessionId),
      onMessage: (message) => {
        store.appendMessageAndTouch(sessionId, message, message.createdAt);
      },
    });
  }

  const now = Date.now();
  store.createSession({
    id: sessionId,
    createdAt: now,
    updatedAt: now,
    model: options.model,
    providerId: options.providerId,
    systemPrompt: options.systemPrompt,
    cwd: options.cwd,
  });

  return new AgentSession({
    id: sessionId,
    system: options.systemPrompt,
    client: options.client,
    model: options.model,
    onMessage: (message) => {
      store.appendMessageAndTouch(sessionId, message, message.createdAt);
    },
  });
}
