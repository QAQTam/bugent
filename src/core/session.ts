/**
 * AgentSession —— loop 唯一的有状态对象。
 *
 * 它持有：msgid 序列、目标 ModelClient、turn 计数，以及"上一次实际发给模型的
 * 前缀指纹"（用来验证缓存前缀确实没变）。
 */

import type { ChatMessage, ModelClient, ToolCall } from "../provider/types.ts";
import { buildContext, lastMsgId, prefixHash } from "./context.ts";
import { makeMessage, SYSTEM_MSGID, textPart, type MsgId, type StoredMessage } from "./message.ts";

export interface SessionInit {
  id: string;
  /** 当前活动分支；用于 daemon / 多分支恢复。 */
  branchId?: string;
  /** system prompt，写进 msgid 0，之后不可变。 */
  system: string;
  client: ModelClient;
  model: string;
  /** 从全局最大 msgid + 1 继续；分支恢复时必须由 store 提供。 */
  nextMsgId?: MsgId;
  now?: () => number;
  /** 每追加一条消息就回调一次（Phase 10 用它即时落盘）。 */
  onMessage?: (message: StoredMessage) => void;
  /** 从历史恢复：传入当前分支路径（含 msgid 0）。 */
  restore?: readonly StoredMessage[];
}

export class AgentSession {
  readonly id: string;
  readonly branchId: string | undefined;
  readonly client: ModelClient;
  readonly model: string;

  #messages: StoredMessage[] = [];
  #nextMsgId: MsgId = SYSTEM_MSGID;
  #turn = 0;
  #now: () => number;
  #onMessage: ((message: StoredMessage) => void) | undefined;
  #lastSentPrefixHash: string | undefined;

  constructor(init: SessionInit) {
    this.id = init.id;
    this.branchId = init.branchId;
    this.client = init.client;
    this.model = init.model;
    this.#now = init.now ?? (() => Date.now());
    this.#onMessage = init.onMessage;

    if (init.restore !== undefined && init.restore.length > 0) {
      // 恢复路径：历史里已经包含 msgid 0 的 system prompt，不再新建
      this.#messages = [...init.restore];
      this.#nextMsgId = init.nextMsgId ?? lastMsgId(this.#messages) + 1;
    } else {
      // msgid 0：system prompt。写一次，永不修改。
      this.#nextMsgId = init.nextMsgId ?? SYSTEM_MSGID;
      this.#append({ role: "system", origin: "system", parts: [textPart(init.system)] });
    }
  }

  get messages(): readonly StoredMessage[] {
    return this.#messages;
  }

  get turn(): number {
    return this.#turn;
  }

  /** 上一次发给模型的上下文前缀指纹（用于缓存命中验证）。 */
  get lastSentPrefixHash(): string | undefined {
    return this.#lastSentPrefixHash;
  }

  get lastMsgId(): MsgId {
    return lastMsgId(this.#messages);
  }

  /* --------------------------- 追加消息 --------------------------- */

  appendUser(text: string): StoredMessage {
    return this.#append({ role: "user", origin: "user", parts: [textPart(text)] });
  }

  /** 系统侧注入（工具说明变更、文件快照等）。永远是新 msgid，绝不插队。 */
  appendInjection(text: string): StoredMessage {
    return this.#append({ role: "user", origin: "inject", parts: [textPart(text)] });
  }

  appendAssistant(text: string, toolCalls?: readonly ToolCall[]): StoredMessage {
    return this.#append({
      role: "assistant",
      origin: "assistant",
      parts: text.length > 0 ? [textPart(text)] : [],
      ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }

  appendToolResult(toolCallId: string, text: string): StoredMessage {
    return this.#append({
      role: "tool",
      origin: "tool",
      parts: [textPart(text)],
      toolCallId,
    });
  }

  /* --------------------------- 上下文 --------------------------- */

  buildContext(): ChatMessage[] {
    return buildContext(this.#messages);
  }

  prefixHash(uptoMsgId?: MsgId): string {
    return prefixHash(this.#messages, uptoMsgId);
  }

  /** loop 在真正发请求前调用，记录"这一轮发出去的前缀"。 */
  noteContextSent(): void {
    this.#lastSentPrefixHash = this.prefixHash(this.lastMsgId);
  }

  /** 上一轮发出去的前缀是否与当前前缀一致（一致 = 缓存该命中）。 */
  prefixStillMatches(): boolean {
    if (this.#lastSentPrefixHash === undefined) return false;
    return this.#lastSentPrefixHash === this.prefixHash(this.lastMsgId);
  }

  advanceTurn(): void {
    this.#turn += 1;
  }

  snapshot(): readonly StoredMessage[] {
    return [...this.#messages];
  }

  /* --------------------------- 内部 --------------------------- */

  #append(input: {
    role: StoredMessage["role"];
    origin: StoredMessage["origin"];
    parts: StoredMessage["parts"];
    toolCallId?: string;
    toolCalls?: readonly ToolCall[];
  }): StoredMessage {
    const msgid = this.#nextMsgId;
    this.#nextMsgId += 1;
    const parent = lastMsgId(this.#messages);

    const msg = makeMessage({
      msgid,
      ...(parent >= 0 ? { parentMsgId: parent } : {}),
      role: input.role,
      origin: input.origin,
      parts: input.parts,
      createdAt: this.#now(),
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
    });

    this.#messages.push(msg);
    this.#onMessage?.(msg);
    return msg;
  }
}
