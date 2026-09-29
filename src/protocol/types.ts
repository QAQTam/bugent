/** bugent UI 协议 v1 类型（docs/ui-protocol-spec.md §10.1）。
 *  只做两件事：re-export 现有 core/permission/tools/tui 类型（不复制结构，避免漂移），
 *  以及定义信封 / 命令 / 事件联合类型。传输实现见 src/runtime/bridge.ts。 */

// ---- re-export：协议直接复用现有领域类型 ----
export type { StoredMessage, MsgId, MessageOrigin } from "../core/message";
export type { ToolCallDelta, LoopHooks, TurnResult } from "../core/loop";
export type { ToolCall, Usage, FinishReason, ChatChunk, Role, ContentPart } from "../provider/types";
export type { ToolExecution, CapabilityEscalation, ToolRegistry } from "../tools/types";
export type { ToolPresentation } from "../core/presentation";
export type { AskUserQuestion, AskUserAnswer } from "../tui/ask-user";
export type { PermissionRequest, PermissionRule, PermissionDecision } from "../permission/policy";
export type { ModeRequirement, SandboxMode, CapabilityGrant } from "../permission/mode";
export type { AuthorizationOutcome } from "../permission/authorization";

/** 当前协议版本（§9：只做破坏性变更递增）。 */
export const UI_PROTOCOL_VERSION = 1;

/** 消息信封（§3）。 */
export interface UiEnvelope<P = Record<string, unknown>> {
  v: number;
  /** 发送方消息 id，服务端原样回显。 */
  id: string;
  kind: "cmd" | "evt" | "reply";
  type: string;
  /** session 级消息必带；缺省视为协议层消息。 */
  sessionId?: string | undefined;
  payload: P;
  ts: number;
}

// ---- 命令（上行，§4）----

export interface HelloPayload {
  token: string;
  client: "webui" | "electron";
  protocolVersions: number[];
}
export interface SessionNewPayload {
  cwd?: string;
  title?: string;
}
export interface SessionIdPayload {
  sessionId: string;
}
export interface TurnSendPayload {
  text: string;
  /** 附件通道未实现（§4 预留表）：携带时 reply not_implemented。 */
  attachments?: unknown;
}
export interface PermissionResolvePayload {
  requestId: string;
  outcome: "approved" | "denied";
}
export interface PermissionAlwaysPayload {
  requestId: string;
}
export interface AskUserAnswerPayload {
  requestId: string;
  answers?: import("../tui/ask-user").AskUserAnswer[];
  abort?: boolean;
}
export interface ExtensionRoleFallbackPayload {
  requestId: string;
  allow: boolean;
}

export type UiReplyPayload =
  | { ok: true } & Record<string, unknown>
  | { ok: false; code: string; message: string };

// ---- 事件（下行，§5）----
// payload 形状与 §5 注册表一致；领域对象直接复用 re-export 的类型。

export type UiEventType =
  | "turn.started"
  | "user.message"
  | "text.delta"
  | "reasoning.delta"
  | "assistant.message"
  | "tool.call_delta"
  | "tool.call"
  | "tool.progress"
  | "tool.result"
  | "workspace.change"
  | "permission.request"
  | "capability.request"
  | "ask_user.request"
  | "extension_role.fallback_request"
  | "usage"
  | "turn.done"
  | "todo.state"
  | "turn.error"
  | "error";
