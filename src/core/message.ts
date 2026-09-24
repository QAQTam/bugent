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
import type { WorkspaceChange } from "./workspace.ts";

export type MsgId = number;

/** 消息从哪来。用于调试、审计，以及区分"人说的"和"系统注入的"。 */
export type MessageOrigin = "system" | "user" | "assistant" | "tool" | "inject";
export type InjectionSource =
  | "mcp"
  | "skill"
  | "goal"
  | "plan"
  | "checkpoint"
  | "handoff"
  | "review"
  | "agent"
  | "system"
  | "snapshot";

export const SYSTEM_MSGID: MsgId = 0;

export interface StoredMessage {
  readonly msgid: MsgId;
  /** 分支树里的父消息；msgid 0 没有父节点。 */
  readonly parentMsgId?: MsgId;
  readonly role: Role;
  readonly parts: readonly ContentPart[];
  readonly origin: MessageOrigin;
  /** origin === "inject" 时的来源；用于 MCP/skills 的协议 role 渲染。 */
  readonly injectionSource?: InjectionSource;
  /** assistant 的思考链路；用于 provider reasoning replay，不作为正文展示。 */
  readonly reasoning?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ToolCall[];
  /**
   * 本次 tool result 造成的工作区变更。
   *
   * 只用于 undo / 回放，不进入模型上下文；挂在消息上而不是单独建 journal，
   * 是为了让分支路径天然决定“哪些变更还属于当前上下文”。
   */
  readonly workspace?: WorkspaceChange;
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
  if (msg.workspace !== undefined) {
    for (const file of msg.workspace.files) {
      for (const op of file.reverse.ops) {
        Object.freeze(op.remove);
        Object.freeze(op.insert);
        Object.freeze(op);
      }
      Object.freeze(file.reverse.ops);
      Object.freeze(file.reverse);
      Object.freeze(file);
    }
    Object.freeze(msg.workspace.files);
    Object.freeze(msg.workspace);
  }
  return Object.freeze(msg);
}

/** 存储态 -> 归一化协议态。 */
export function toChatMessage(
  msg: StoredMessage,
  options: { extensionRole?: "developer" | "system" } = {},
): ChatMessage {
  const extension =
    msg.injectionSource === "mcp" ||
    msg.injectionSource === "skill" ||
    msg.injectionSource === "goal" ||
    msg.injectionSource === "plan" ||
    msg.injectionSource === "checkpoint" ||
    msg.injectionSource === "handoff" ||
    msg.injectionSource === "review" ||
    msg.injectionSource === "agent";
  const role: Role = extension ? (options.extensionRole ?? "developer") : msg.role;
  const out: ChatMessage = { role, parts: [...msg.parts] };
  if (msg.reasoning !== undefined) out.reasoning = msg.reasoning;
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
  injectionSource?: InjectionSource;
  parts: readonly ContentPart[];
  createdAt: number;
  reasoning?: string;
  toolCallId?: string;
  toolCalls?: readonly ToolCall[];
  workspace?: WorkspaceChange;
}): StoredMessage {
  const msg: StoredMessage = {
    msgid: input.msgid,
    ...(input.parentMsgId !== undefined ? { parentMsgId: input.parentMsgId } : {}),
    role: input.role,
    parts: input.parts,
    origin: input.origin,
    ...(input.injectionSource !== undefined ? { injectionSource: input.injectionSource } : {}),
    createdAt: input.createdAt,
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
    ...(input.toolCalls !== undefined && input.toolCalls.length > 0
      ? { toolCalls: input.toolCalls }
      : {}),
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
  };
  return freezeMessage(msg);
}

export { messageText };
