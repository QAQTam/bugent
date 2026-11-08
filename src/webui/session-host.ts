/**
 * SessionHost —— SessionDelegate 的 agent 实现。
 *
 * 把一个 SessionRuntime 的 LoopHooks（src/core/loop.ts:38）1:1 翻译成 UiEvent
 * （spec §5），驱动 runUserTurn，托管 permission / capability / ask_user /
 * extension_role 的 request-id 往返（spec §6，first-wins）。
 *
 * block 模型（spec §5.1）：bridge 在 turn 内分配 blockId —— 文本 / reasoning /
 * 每个工具调用各一块；工具块开启时打断当前文本块（下一笔 delta 开新块），
 * 前端因此渲染出 `文本块 → 工具块 → 文本块…` 的有序序列（C6/C7）。
 *
 * 落库边界与 TUI 完全一致：reasoning 只进事件与 draft 快照，不落库；
 * protocol 层永不接触 provider API key。
 */

import type { SessionRuntime } from "../core/runtime.ts";
import { runUserTurn, type LoopHooks } from "../core/loop.ts";
import type { PermissionRequest } from "../permission/policy.ts";
import type { PermissionPolicy } from "../permission/policy.ts";
import type { SandboxMode } from "../permission/mode.ts";
import type { AuthorizationOutcome } from "../permission/authorization.ts";
import type { ToolCall, Usage } from "../provider/types.ts";
import type {
  AskUserAnswer,
  AskUserAnswerPayload,
  AskUserQuestion,
  DraftToolBlock,
  GoalSummary,
  MsgId,
  PendingInteraction,
  SessionDraft,
  SessionInfo,
  StoredMessage,
  UiEvent,
  UiReplyPayload,
} from "../protocol/types.ts";
import type { SessionDelegate } from "./hub.ts";

interface PendingEntry {
  id: string;
  kind: PendingInteraction["kind"];
  summary: string;
  /** permission 原请求（"总是允许"用它生成字面量规则；spec §6.4）。 */
  request?: PermissionRequest;
  /** 档位升级请求：不支持 always。 */
  modeChange?: boolean;
  /** ask_user 的答案暂存（answerAskUser 写入，finish 时读出）。 */
  value?: unknown;
  finish(outcome: string): void;
}

export interface SessionHostOptions {
  runtime: SessionRuntime;
  cwd: string;
  /** attach 快照尾部消息条数；与 hub 的 historyTail 同值。 */
  historyTail: number;
  /** "总是允许"的运行时加规则入口（spec §6.4）。 */
  policy: PermissionPolicy;
  /** 由 hub 提供：publish = (event) => hub.publish(sessionId, event)。 */
  publish: (event: UiEvent) => void;
}

export class SessionHost implements SessionDelegate {
  readonly id: string;

  #runtime: SessionRuntime;
  #cwd: string;
  #historyTail: number;
  #policy: PermissionPolicy;
  #publish: (event: UiEvent) => void;

  /** turn 内块计数器；blockId = "<turnId>#<n>"。 */
  #blockSeq = 0;
  #turnId: string | undefined;
  #textBlockId: string | undefined;
  #reasoningBlockId: string | undefined;
  #toolBlocks = new Map<string, { blockId: string; call: ToolCall; argsSoFar: string }>();
  #draftText = "";
  #draftReasoning = "";
  #pending = new Map<string, PendingEntry>();
  #abort: AbortController | undefined;
  #lastUsage: Usage | undefined;
  #lastSteps = 0;
  #watchers = 0;

  constructor(options: SessionHostOptions) {
    this.#runtime = options.runtime;
    this.id = options.runtime.session.id;
    this.#cwd = options.cwd;
    this.#historyTail = options.historyTail;
    this.#policy = options.policy;
    this.#publish = options.publish;
  }

  /* ------------------------- SessionDelegate 静态面 ------------------------- */

  info(): SessionInfo {
    const session = this.#runtime.session;
    return {
      sessionId: session.id,
      cwd: this.#cwd,
      mode: this.#runtime.mode,
      providerId: this.#runtime.providerId,
      model: session.model,
      turnActive: session.turnActive,
    };
  }

  goalSummary(): GoalSummary | null {
    const goal = this.#runtime.goalController?.currentGoal();
    if (goal === undefined || typeof goal.tokenBudget !== "number") return null;
    return { status: goal.status, tokensUsed: goal.tokensUsed, tokenBudget: goal.tokenBudget };
  }

  pending(): readonly PendingInteraction[] {
    return [...this.#pending.values()].map((entry) => ({
      kind: entry.kind,
      requestId: entry.id,
      summary: entry.summary,
    }));
  }

  draft(): SessionDraft | null {
    if (this.#turnId === undefined) return null;
    return {
      turnId: this.#turnId,
      text: this.#draftText,
      ...(this.#draftReasoning.length > 0 ? { reasoning: this.#draftReasoning } : {}),
      tools: [...this.#toolBlocks.values()].map(
        ({ blockId, call, argsSoFar }): DraftToolBlock => ({ blockId, call, argsSoFar }),
      ),
    };
  }

  history(): { messages: readonly StoredMessage[]; hasMore: boolean } {
    const all = this.#runtime.session.messages;
    return {
      messages: all.slice(Math.max(0, all.length - this.#historyTail)),
      hasMore: all.length > this.#historyTail,
    };
  }

  historyBefore(
    beforeMsgId: MsgId,
    limit: number,
  ): { messages: readonly StoredMessage[]; hasMore: boolean } {
    const all = this.#runtime.session.messages;
    const index = all.findIndex((message) => message.msgid === beforeMsgId);
    if (index <= 0) return { messages: [], hasMore: false };
    const start = Math.max(0, index - limit);
    return { messages: all.slice(start, index), hasMore: start > 0 };
  }

  /* ------------------------------ turn 驱动 ------------------------------ */

  sendTurn(text: string): UiReplyPayload {
    if (this.#turnId !== undefined || this.#runtime.session.turnActive) {
      return { ok: false, code: "turn_busy", message: "当前 session 已有活跃 turn" };
    }
    const turnId = `t-${crypto.randomUUID().slice(0, 8)}`;
    this.#turnId = turnId;
    this.#blockSeq = 0;
    this.#textBlockId = undefined;
    this.#reasoningBlockId = undefined;
    this.#toolBlocks.clear();
    this.#draftText = "";
    this.#draftReasoning = "";
    this.#abort = new AbortController();
    this.#publish({ type: "turn.started", turnId });
    this.#publishState();
    void this.#run(text, turnId, this.#abort.signal);
    return { ok: true, turnId };
  }

  cancelTurn(): { aborted: boolean } {
    if (this.#abort === undefined) return { aborted: false };
    this.#abort.abort();
    return { aborted: true };
  }

  async #run(text: string, turnId: string, signal: AbortSignal): Promise<void> {
    try {
      const result = await runUserTurn(this.#runtime.session, text, {
        tools: this.#runtime.tools,
        hooks: this.#hooks(),
        cwd: this.#cwd,
        signal,
      });
      this.#lastUsage = result.usage;
      this.#lastSteps = result.steps;
      this.#publish({ type: "turn.done", turnId, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 取消不是错误（§8：cancel 后到 turn.done 之间的残余事件 UI 必须容忍）
      if (!signal.aborted) this.#publish({ type: "turn.error", turnId, message });
      // §5：turn.error 之后必须有 turn.done —— 错误路径也补一条，text 带上
      // 已流出的草稿，UI 至少能读到半截答复。
      this.#publish({
        type: "turn.done",
        turnId,
        result: {
          text: this.#draftText,
          toolCalls: [],
          steps: this.#lastSteps,
          reason: signal.aborted ? "stop" : "error",
          usage: this.#lastUsage ?? { input: 0, output: 0 },
        },
      });
    } finally {
      this.#turnId = undefined;
      this.#abort = undefined;
      this.#textBlockId = undefined;
      this.#reasoningBlockId = undefined;
      this.#toolBlocks.clear();
      this.#draftText = "";
      this.#draftReasoning = "";
      this.#publishState();
    }
  }

  #publishState(): void {
    this.#publish({
      type: "session.state",
      mode: this.#runtime.mode,
      turnActive: this.#runtime.session.turnActive,
      goal: this.goalSummary(),
    });
  }

  /* ------------------------- request-id 往返（§6） ------------------------- */

  /** SessionInteraction 入口（gate prompter）：权限确认。 */
  askPermission(request: PermissionRequest): Promise<AuthorizationOutcome> {
    return this.#openRequest<AuthorizationOutcome>({
      kind: "permission",
      summary: request.summary,
      request,
      event: (requestId) => ({ type: "permission.request", requestId, request }),
      map: (outcome) => (outcome === "approved" ? "approved" : "denied"),
    });
  }

  /** SessionInteraction 入口（gate onEscalate）：档位升级确认。不支持 always。 */
  confirmModeChange(request: PermissionRequest, needed: SandboxMode): Promise<AuthorizationOutcome> {
    return this.#openRequest<AuthorizationOutcome>({
      kind: "permission",
      summary: `档位升级为 ${needed}：${request.summary}`,
      modeChange: true,
      event: (requestId) => ({ type: "permission.request", requestId, request }),
      map: (outcome) => (outcome === "approved" ? "approved" : "denied"),
    });
  }

  resolvePermission(requestId: string, outcome: "approved" | "denied"): boolean {
    const entry = this.#pending.get(requestId);
    if (entry === undefined) return false;
    entry.finish(outcome);
    return true;
  }

  alwaysAllow(requestId: string): UiReplyPayload {
    const entry = this.#pending.get(requestId);
    if (entry === undefined) {
      return { ok: false, code: "already_resolved", message: "该请求已被解决" };
    }
    // 越界能力与提问按次授权是有意设计；档位升级同理（§6.4）
    if (entry.modeChange || entry.request === undefined) {
      return { ok: false, code: "not_allowed", message: "该请求不支持「总是允许」（spec §6.4）" };
    }
    // 字面量规则：用户批准的是眼前这条具体调用（PermissionPolicy.addRule 语义）
    this.#policy.addRule({
      tool: entry.request.tool,
      resource: entry.request.resource,
      decision: "allow",
    });
    entry.finish("approved");
    return { ok: true };
  }

  answerAskUser(payload: AskUserAnswerPayload): boolean {
    const entry = this.#pending.get(payload.requestId);
    if (entry === undefined) return false;
    if (payload.abort === true) {
      entry.finish("aborted");
      return true;
    }
    entry.value = payload.answers ?? [];
    entry.finish("answered");
    return true;
  }

  resolveExtensionRole(requestId: string, allow: boolean): boolean {
    const entry = this.#pending.get(requestId);
    if (entry === undefined) return false;
    entry.finish(allow ? "allowed" : "denied");
    return true;
  }

  #openRequest<T>(options: {
    kind: PendingInteraction["kind"];
    summary: string;
    request?: PermissionRequest;
    modeChange?: boolean;
    event: (requestId: string) => UiEvent;
    map: (outcome: string, value: unknown) => T;
  }): Promise<T> {
    const requestId = `r-${crypto.randomUUID().slice(0, 8)}`;
    return new Promise<T>((resolve) => {
      const entry: PendingEntry = {
        id: requestId,
        kind: options.kind,
        summary: options.summary,
        ...(options.request !== undefined ? { request: options.request } : {}),
        ...(options.modeChange === true ? { modeChange: true } : {}),
        finish: (outcome: string) => {
          this.#pending.delete(requestId);
          this.#publish({ type: "interaction.resolved", requestId, kind: entry.kind, outcome });
          resolve(options.map(outcome, entry.value));
        },
      };
      this.#pending.set(requestId, entry);
      this.#publish(options.event(requestId));
      // 无人在线时请求永远等不到结论：按"用户拒绝"处理（§6.3）
      if (this.#watchers === 0) entry.finish("denied");
    });
  }

  onWatchers(count: number): void {
    this.#watchers = count;
    if (count > 0) return;
    // 所有连接都断开：挂起请求给默认结论（§6.3）——denied / aborted
    for (const entry of [...this.#pending.values()]) {
      entry.finish(entry.kind === "ask_user" ? "aborted" : "denied");
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  close(): void {
    this.#abort?.abort();
    this.#runtime.dispose();
  }

  /* ------------------------------ LoopHooks ------------------------------ */

  #hooks(): LoopHooks {
    return {
      onUser: (message) => {
        this.#publish({ type: "user.message", message });
      },

      onText: (delta) => {
        this.#textBlockId ??= this.#nextBlockId();
        this.#draftText += delta;
        this.#publish({
          type: "text.delta",
          turnId: this.#turnId!,
          blockId: this.#textBlockId,
          delta,
        });
      },

      onReasoning: (delta) => {
        this.#reasoningBlockId ??= this.#nextBlockId();
        this.#draftReasoning += delta;
        this.#publish({
          type: "reasoning.delta",
          turnId: this.#turnId!,
          blockId: this.#reasoningBlockId,
          delta,
        });
      },

      onAssistant: (message) => {
        this.#publish({ type: "assistant.message", message });
        // 落库即定格：draft 清空，后续 delta 属于新块（§5.1）
        this.#draftText = "";
        this.#draftReasoning = "";
        this.#textBlockId = undefined;
        this.#reasoningBlockId = undefined;
      },

      onToolCallDelta: (delta) => {
        const block = this.#ensureToolBlock(delta.id, delta.name);
        if (delta.reset === true) {
          // provider 重试：provisional 内容作废，块保留（UI 据此清空卡片）
          block.argsSoFar = "";
        } else {
          block.argsSoFar += delta.argsDelta;
        }
        this.#publish({
          type: "tool.call_delta",
          turnId: this.#turnId!,
          blockId: block.blockId,
          call: { id: delta.id, name: delta.name },
          argsDelta: delta.argsDelta,
          rawArgs: delta.rawArgs,
          args: delta.args,
          ...(delta.reset === true ? { reset: true } : {}),
        });
      },

      onToolCall: (call) => {
        const block = this.#ensureToolBlock(call.id, call.name);
        // 工具块开启 = 文本流被打断：下一笔 text 开新块（§5.1）
        this.#textBlockId = undefined;
        this.#reasoningBlockId = undefined;
        this.#publish({ type: "tool.call", turnId: this.#turnId!, blockId: block.blockId, call });
      },

      onToolProgress: (call, chunk, stream) => {
        const block = this.#ensureToolBlock(call.id, "");
        this.#publish({
          type: "tool.progress",
          turnId: this.#turnId!,
          blockId: block.blockId,
          call: { id: call.id },
          chunk,
          stream,
        });
      },

      onToolResult: (call, result, message) => {
        const block = this.#toolBlocks.get(call.id);
        const blockId = block?.blockId ?? this.#nextBlockId();
        this.#toolBlocks.delete(call.id);
        this.#textBlockId = undefined;
        this.#reasoningBlockId = undefined;
        this.#publish({
          type: "tool.result",
          turnId: this.#turnId!,
          blockId,
          call,
          result,
          ...(message !== undefined ? { message } : {}),
        });
      },

      // BUG-023 对齐：能力授权绕过 gate.check，必须单独进审计（与 CLI/TUI 同款）
      onRequestCapability: async (_call, escalation) => {
        const outcome = await this.#openRequest<AuthorizationOutcome>({
          kind: "capability",
          summary: escalation.reason,
          event: (requestId) => ({
            type: "capability.request",
            requestId,
            call: _call,
            escalation,
          }),
          map: (raw) => (raw === "approved" ? "approved" : "denied"),
        });
        this.#runtime.audit?.capability({
          capability: escalation.capability,
          reason: escalation.reason,
          outcome,
        });
        return outcome;
      },

      onAskUser: async (call, questions) => this.#requestAskUser(call, questions),

      onUsage: (usage) => {
        this.#lastUsage = usage;
        this.#publish({ type: "usage", usage });
      },

      onExtensionRoleFallback: (error) =>
        this.#openRequest<boolean>({
          kind: "extension_role",
          summary: "provider 拒绝 developer role，是否改用 system role 重发 MCP/skills manifest？",
          event: (requestId) => ({
            type: "extension_role.fallback_request",
            requestId,
            error: error instanceof Error ? error.message : String(error),
          }),
          map: (outcome) => outcome === "allowed",
        }),
    };
  }

  #requestAskUser(
    call: ToolCall,
    questions: readonly AskUserQuestion[],
  ): Promise<AskUserAnswer[] | undefined> {
    return this.#openRequest<AskUserAnswer[] | undefined>({
      kind: "ask_user",
      summary: questions[0]?.question ?? "ask_user",
      event: (requestId) => ({ type: "ask_user.request", requestId, call, questions }),
      map: (outcome, value) => (outcome === "answered" ? (value as AskUserAnswer[]) : undefined),
    });
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  #nextBlockId(): string {
    this.#blockSeq += 1;
    return `${this.#turnId}#${this.#blockSeq}`;
  }

  #ensureToolBlock(callId: string, name: string): { blockId: string; call: ToolCall; argsSoFar: string } {
    let block = this.#toolBlocks.get(callId);
    if (block === undefined) {
      block = { blockId: this.#nextBlockId(), call: { id: callId, name: "", args: undefined }, argsSoFar: "" };
      this.#toolBlocks.set(callId, block);
    }
    if (name.length > 0) block.call.name = name;
    return block;
  }
}
