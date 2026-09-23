/**
 * 消息存储模型 —— Phase 2 的基石。
 *
 * 铁律：
 *   1. `msgid` 从 0 开始严格递增，**msgid 0 永远是 system prompt**。
 *   2. 消息一旦写入即冻结（Object.freeze），**只追加、不修改历史**。
 *      任何"上下文注入"都是新增 msgid，绝不插队、绝不改写旧消息。
 *   3. 顺序即语义：上下文 = [msgid 0] + 其余按 msgid 升序。
 *
 * 这三条合起来保证「已发出的前缀永远逐字节不变」→ provider 的前缀缓存必命中。
 */

import type { ChatMessage, ContentPart, Role, ToolCall } from "../provider/types.ts";
import { messageText } from "../provider/types.ts";

export type MsgId = number;

/** 消息从哪来。用于调试、审计，以及区分"人说的"和"系统注入的"。 */
export type MessageOrigin = "system" | "user" | "assistant" | "tool" | "inject";

export const SYSTEM_MSGID: MsgId = 0;

export interface StoredMessage {
  readonly msgid: MsgId;
  /** 分支树里的父消息；msgid 0 没有父节点。 */
  readonly parentMsgId?: MsgId;
  readonly role: Role;
  readonly parts: readonly ContentPart[];
  readonly origin: MessageOrigin;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly createdAt: number;
}

export function textPart(text: string): ContentPart {
  return { type: "text", text };
}

/** 取出消息的全部文本（多模态里忽略图片部分）。 */
export function storedText(msg: StoredMessage): string {
  let out = "";
  for (const part of msg.parts) {
    if (part.type === "text") out += part.text;
  }
  return out;
}

/** 冻结一条消息（含嵌套结构），杜绝后续误改。 */
export function freezeMessage(msg: StoredMessage): StoredMessage {
  for (const part of msg.parts) Object.freeze(part);
  Object.freeze(msg.parts);
  if (msg.toolCalls !== undefined) {
    for (const call of msg.toolCalls) Object.freeze(call);
    Object.freeze(msg.toolCalls);
  }
  return Object.freeze(msg);
}

/** 存储态 -> 归一化协议态。 */
export function toChatMessage(msg: StoredMessage): ChatMessage {
  const out: ChatMessage = { role: msg.role, parts: [...msg.parts] };
  if (msg.toolCallId !== undefined) out.toolCallId = msg.toolCallId;
  if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) out.toolCalls = [...msg.toolCalls];
  return out;
}

/** 从任意文本构造一条已冻结的存储消息。 */
export function makeMessage(input: {
  msgid: MsgId;
  parentMsgId?: MsgId;
  role: Role;
  origin: MessageOrigin;
  parts: readonly ContentPart[];
  createdAt: number;
  toolCallId?: string;
  toolCalls?: readonly ToolCall[];
}): StoredMessage {
  const msg: StoredMessage = {
    msgid: input.msgid,
    ...(input.parentMsgId !== undefined ? { parentMsgId: input.parentMsgId } : {}),
    role: input.role,
    parts: input.parts,
    origin: input.origin,
    createdAt: input.createdAt,
    ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
    ...(input.toolCalls !== undefined && input.toolCalls.length > 0
      ? { toolCalls: input.toolCalls }
      : {}),
  };
  return freezeMessage(msg);
}

export { messageText };
