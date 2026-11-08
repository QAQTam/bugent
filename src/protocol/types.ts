/** bugent UI 协议 v2 类型（docs/webui-v2-protocol-spec.md）。
 *
 * 只做两件事：re-export 现有 core/permission/tools 类型（不复制结构，避免漂移），
 * 以及定义信封 / 命令 / 事件联合类型。传输实现见 src/webui/（hub + session-host）。
 *
 * v2 相对 v1（随 8a75ce6 删除）的变化：
 *   - 信封加 `seq`（仅 evt）：session 内单调，断线按 lastSeq 补发（spec §9）；
 *   - 流内事件带 `turnId` + `blockId`：块模型渲染单位（spec §5.1）；
 *   - `session.attach` 回快照（尾部窗口 + draft 续看 + 待决交互），不再是全量历史；
 *   - 新命令 `history.before`（msgid 游标分页）、新事件 `permission.resolved` /
 *     `session.state`；
 *   - ask_user 类型来源从 tui 迁到 core（`src/core/ask-user.ts`）。
 */

// ---- re-export：协议直接复用现有领域类型 ----
// （本地联合类型也要引用这些名字，故同时 import type —— re-export 不引入作用域）
import type { StoredMessage, MsgId } from "../core/message.ts";
import type { TurnResult } from "../core/loop.ts";
import type { ToolCall, Usage } from "../provider/types.ts";
import type { ToolExecution, CapabilityEscalation } from "../tools/types.ts";
import type { WorkspaceFileEdit } from "../core/workspace.ts";
import type { AskUserQuestion, AskUserAnswer } from "../core/ask-user.ts";
import type { PermissionRequest } from "../permission/policy.ts";
import type { SandboxMode } from "../permission/mode.ts";
import type { AuthorizationOutcome } from "../permission/authorization.ts";
import type { GoalStatus } from "../goal/types.ts";

export type { StoredMessage, MsgId, MessageOrigin, InjectionSource } from "../core/message.ts";
export type { ToolCallDelta, LoopHooks, TurnResult } from "../core/loop.ts";
export type { ToolCall, Usage, FinishReason, Role, ContentPart } from "../provider/types.ts";
export type { ToolExecution, CapabilityEscalation, ToolRegistry } from "../tools/types.ts";
export type { ToolPresentation } from "../core/presentation.ts";
export type { WorkspaceFileEdit } from "../core/workspace.ts";
export type { AskUserQuestion, AskUserAnswer } from "../core/ask-user.ts";
export type { PermissionRequest, PermissionRule, PermissionDecision } from "../permission/policy.ts";
export type { ModeRequirement, SandboxMode, CapabilityGrant } from "../permission/mode.ts";
export type { AuthorizationOutcome } from "../permission/authorization.ts";
export type { GoalStatus } from "../goal/types.ts";

/** 当前协议版本（spec §11：只做破坏性变更递增）。 */
export const UI_PROTOCOL_VERSION = 2;

/** 消息信封（spec §3）。 */
export interface UiEnvelope<P = Record<string, unknown>> {
  v: number;
  /** 发送方消息 id，服务端原样回显；turn.send 以它做幂等键（spec §6.2）。 */
  id: string;
  kind: "cmd" | "evt" | "reply";
  type: string;
  /** session 级消息必带；缺省视为协议层消息。 */
  sessionId?: string | undefined;
  /** 仅 evt：session 内单调递增，从 1 开始（spec §9）。 */
  seq?: number | undefined;
  payload: P;
  ts: number;
}

// ---- 命令（上行，spec §4）----

export interface HelloPayload {
  token: string;
  client: "webui";
  protocolVersions: number[];
}
export interface SessionNewPayload {
  cwd?: string;
  title?: string;
}
export interface SessionAttachPayload {
  sessionId: string;
  /** 上次收到的最大 seq；缺失/过旧走快照（spec §9.2/§9.3）。 */
  lastSeq?: number;
}
export interface SessionIdPayload {
  sessionId: string;
}
export interface TurnSendPayload {
  text: string;
  /** 附件通道未实现（spec §4 预留表）：携带时 reply not_implemented。 */
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
  answers?: AskUserAnswer[];
  abort?: boolean;
}
export interface ExtensionRoleFallbackPayload {
  requestId: string;
  allow: boolean;
}
export interface HistoryBeforePayload {
  sessionId: string;
  /** 游标：返回 msgid 更旧的一页；首屏之后的翻页入口（spec §10）。 */
  beforeMsgId: MsgId;
  /** 上限 200。 */
  limit: number;
}

export type UiReplyPayload =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; code: string; message: string };

// ---- session 状态形状（spec §7）----

export interface SessionInfo {
  sessionId: string;
  title?: string;
  cwd: string;
  mode: SandboxMode;
  providerId: string;
  model: string;
  turnActive: boolean;
}

export interface GoalSummary {
  status: GoalStatus;
  tokensUsed: number;
  tokenBudget: number;
}

/** attach 快照里的待决交互（裁决 A6：晚接入的能看到待审批项）。 */
export interface PendingInteraction {
  kind: "permission" | "capability" | "ask_user" | "extension_role";
  requestId: string;
  summary: string;
}

/** turn 进行中的流式草稿（spec §7 draft；B7 续看）。 */
export interface DraftToolBlock {
  blockId: string;
  call: ToolCall;
  argsSoFar: string;
}

export interface SessionDraft {
  turnId: string;
  text: string;
  /** reasoning 不落库，快照内以明文续看，刷新即失。 */
  reasoning?: string;
  tools: DraftToolBlock[];
}

/** `session.attach` 的 reply.state。 */
export interface SessionSnapshot {
  sessionId: string;
  info: SessionInfo;
  goal: GoalSummary | null;
  /** 尾部窗口（默认最近 200 条）；更旧走 history.before。 */
  messages: readonly StoredMessage[];
  hasMoreHistory: boolean;
  /** 整份快照都是回放内容：前端不得触发动画/音效。 */
  replay: true;
  turnActive: boolean;
  draft: SessionDraft | null;
  /** 待决交互列表（§6 的 request 流程进行中）。 */
  pending: readonly PendingInteraction[];
  /** 快照对应的 seq；后续事件从 lastSeq+1 开始（B6）。 */
  lastSeq: number;
  /** true = lastSeq 已滑出日志窗口，快照即真相、丢弃本地 draft（spec §9.3）。 */
  resync?: boolean;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

// ---- 事件（下行，spec §5）----
// 与 LoopHooks 的映射是规范性的；领域对象直接复用 re-export 的类型。

export type UiEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "user.message"; message: StoredMessage }
  | { type: "text.delta"; turnId: string; blockId: string; delta: string }
  | { type: "reasoning.delta"; turnId: string; blockId: string; delta: string }
  | { type: "assistant.message"; message: StoredMessage }
  | {
      type: "tool.call_delta";
      turnId: string;
      blockId: string;
      call: Pick<ToolCall, "id" | "name">;
      argsDelta: string;
      rawArgs: string;
      args: unknown;
      /** provider 重试：丢弃 provisional 卡片。 */
      reset?: boolean;
    }
  | { type: "tool.call"; turnId: string; blockId: string; call: ToolCall }
  | {
      type: "tool.progress";
      turnId: string;
      blockId: string;
      call: Pick<ToolCall, "id">;
      chunk: string;
      stream: "stdout" | "stderr";
    }
  | {
      type: "tool.result";
      turnId: string;
      blockId: string;
      call: ToolCall;
      result: ToolExecution;
      message?: StoredMessage;
    }
  | { type: "workspace.change"; edit: WorkspaceFileEdit }
  | { type: "permission.request"; requestId: string; request: PermissionRequest }
  | {
      /** 广播：request 流程的结论（含断连默认 denied）；所有观察者据此关卡片（A5）。 */
      type: "interaction.resolved";
      requestId: string;
      kind: PendingInteraction["kind"];
      /** permission/capability: approved\|denied\|timeout；ask_user: answered\|aborted；extension_role: allowed\|denied。 */
      outcome: string;
    }
  | { type: "capability.request"; requestId: string; call: ToolCall; escalation: CapabilityEscalation }
  | { type: "ask_user.request"; requestId: string; call: ToolCall; questions: readonly AskUserQuestion[] }
  | {
      type: "permission.resolved";
      requestId: string;
      outcome: AuthorizationOutcome;
    }
  | { type: "extension_role.fallback_request"; requestId: string; error: string }
  | { type: "usage"; usage: Usage }
  | { type: "session.state"; mode: SandboxMode; turnActive: boolean; goal: GoalSummary | null }
  | { type: "todo.state"; todos: readonly TodoItem[] }
  | { type: "turn.done"; turnId: string; result: TurnResult }
  | { type: "turn.error"; turnId: string; message: string }
  | { type: "error"; code: string; message: string; fatal?: boolean };

export type UiEventType = UiEvent["type"];
