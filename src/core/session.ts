/**
 * AgentSession —— loop 唯一的有状态对象。
 *
 * 它持有：msgid 序列、目标 ModelClient、turn 计数，以及"上一次实际发给模型的
 * 前缀指纹"（用来验证缓存前缀确实没变）。
 *
 * 除了消息序列，它还负责两条协议边界：
 *   1. ToolBatch：assistant 的 tool_calls 与对应 tool results 必须成对且连续；
 *   2. 消息队列：user / injection 不能在 turn 或 ToolBatch 中间插队。
 */

import type { ChatMessage, ModelClient, ToolCall } from "../provider/types.ts";
import { buildContext, lastMsgId, prefixHash } from "./context.ts";
import { makeMessage, SYSTEM_MSGID, textPart, type MsgId, type StoredMessage } from "./message.ts";
import { createWorkspaceChange, type WorkspaceFileEdit } from "./workspace.ts";

export interface SessionInit {
  id: string;
  /** 当前活动分支；用于 daemon / 多分支恢复。 */
  branchId?: string;
  /** system prompt，写进 msgid 0，之后不可变。 */
  system: string;
  /** msgid 1：MCP manifest（以 developer 协议角色注入）。 */
  mcpManifest?: string;
  /** msgid 2：skills manifest（以 developer 协议角色注入）。 */
  skillsManifest?: string;
  /** MCP/skills manifest 的协议角色；默认 developer。 */
  extensionRole?: "developer" | "system";
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

export type InjectionSource = "mcp" | "skill" | "system" | "snapshot";

export type SubmitResult =
  | { status: "started"; msgid: MsgId }
  | { status: "queued"; position: number };

interface OpenToolBatch {
  readonly calls: readonly ToolCall[];
  /** 结果先暂存原始输入，flush 时才分配 msgid，保证 msgid/顺序一致。 */
  readonly results: Map<string, PendingToolResult>;
  nextToFlush: number;
}

interface PendingToolResult {
  readonly text: string;
  readonly workspaceEdits?: readonly WorkspaceFileEdit[];
}

interface QueuedUser {
  readonly kind: "user";
  readonly text: string;
  readonly createdAt: number;
}

interface QueuedInjection {
  readonly kind: "inject";
  readonly text: string;
  readonly source: InjectionSource;
  readonly createdAt: number;
}

const MISSING_TOOL_RESULT_ABORT = "Error: tool result missing due abort";
const MISSING_TOOL_RESULT_CRASH = "Error: tool result missing due to interrupted session";
const DEFAULT_MCP_MANIFEST = "# MCP servers\n\n(none)";
const DEFAULT_SKILLS_MANIFEST = "# Skills\n\n(none)";

function sameCalls(a: readonly ToolCall[], b: readonly ToolCall[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((call, index) => call.id === b[index]?.id);
}

export class AgentSession {
  readonly id: string;
  readonly branchId: string | undefined;
  readonly client: ModelClient;
  readonly model: string;

  #messages: StoredMessage[] = [];
  #nextMsgId: MsgId = SYSTEM_MSGID;
  #turn = 0;
  #turnActive = false;
  #now: () => number;
  #onMessage: ((message: StoredMessage) => void) | undefined;
  #lastSentPrefixHash: string | undefined;
  #extensionRole: "developer" | "system";

  /** 当前打开的 tool batch；有值时禁止 user / injection / 新 assistant。 */
  #openToolBatch: OpenToolBatch | undefined;
  /** turn 期间到达的用户消息，默认排到下一 turn。 */
  #userQueue: QueuedUser[] = [];
  /** turn / tool batch 期间到达的注入，在安全模型步边界 flush。 */
  #injectionQueue: QueuedInjection[] = [];

  constructor(init: SessionInit) {
    this.id = init.id;
    this.branchId = init.branchId;
    this.client = init.client;
    this.model = init.model;
    this.#now = init.now ?? (() => Date.now());
    this.#onMessage = init.onMessage;
    this.#extensionRole = init.extensionRole ?? "developer";

    if (init.restore !== undefined && init.restore.length > 0) {
      // 恢复路径：历史里已经包含 msgid 0 的 system prompt，不再新建
      this.#messages = [...init.restore];
      this.#nextMsgId = init.nextMsgId ?? lastMsgId(this.#messages) + 1;
      this.#repairOrphanedToolCalls();
      this.#assertToolCallSequences();
    } else {
      // Context Layout v2：msgid0 system prompt，msgid1 MCP manifest，msgid2 skills manifest。
      this.#nextMsgId = init.nextMsgId ?? SYSTEM_MSGID;
      this.#append({ role: "system", origin: "system", parts: [textPart(init.system)] });
      this.#append({
        role: "system",
        origin: "inject",
        injectionSource: "mcp",
        parts: [textPart(init.mcpManifest ?? DEFAULT_MCP_MANIFEST)],
      });
      this.#append({
        role: "system",
        origin: "inject",
        injectionSource: "skill",
        parts: [textPart(init.skillsManifest ?? DEFAULT_SKILLS_MANIFEST)],
      });
    }
  }

  get messages(): readonly StoredMessage[] {
    return this.#messages;
  }

  get turn(): number {
    return this.#turn;
  }

  get turnActive(): boolean {
    return this.#turnActive;
  }

  get queuedUserCount(): number {
    return this.#userQueue.length;
  }

  get queuedInjectionCount(): number {
    return this.#injectionQueue.length;
  }

  /** 上一次发给模型的上下文前缀指纹（用于缓存命中验证）。 */
  get lastSentPrefixHash(): string | undefined {
    return this.#lastSentPrefixHash;
  }

  get lastMsgId(): MsgId {
    return lastMsgId(this.#messages);
  }

  get extensionRole(): "developer" | "system" {
    return this.#extensionRole;
  }

  /** 渲染期切换 MCP/skills manifest 的协议角色；不修改历史消息。 */
  setExtensionRole(role: "developer" | "system"): void {
    this.#extensionRole = role;
  }

  /* --------------------------- 追加消息 --------------------------- */

  appendUser(text: string): StoredMessage {
    this.#assertAppendable("user message");
    return this.#append({ role: "user", origin: "user", parts: [textPart(text)] });
  }

  /** 系统侧注入（工具说明变更、文件快照等）。永远是新 msgid，绝不插队。 */
  appendInjection(text: string, source: InjectionSource = "system"): StoredMessage {
    this.#assertAppendable("injection");
    return this.#append({
      role: "system",
      origin: "inject",
      injectionSource: source,
      parts: [textPart(text)],
    });
  }

  appendAssistant(text: string, toolCalls?: readonly ToolCall[], reasoning?: string): StoredMessage {
    if (this.#openToolBatch !== undefined) {
      throw new Error("assistant message cannot be appended while a tool batch is open");
    }
    const message = this.#append({
      role: "assistant",
      origin: "assistant",
      parts: text.length > 0 ? [textPart(text)] : [],
      ...(reasoning !== undefined && reasoning.length > 0 ? { reasoning } : {}),
      ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
    });
    if (toolCalls !== undefined && toolCalls.length > 0) {
      this.beginToolBatch(toolCalls);
    }
    return message;
  }

  /**
   * 记录一条 tool result。
   *
   * 顺序正常时它会立即 flush 并返回消息；乱序到达时返回 undefined，
   * 等缺失的前序结果补齐后由 flushToolResultsInOrder 统一按 call 顺序落库。
   */
  appendToolResult(
    toolCallId: string,
    text: string,
    workspaceEdits?: readonly WorkspaceFileEdit[],
  ): StoredMessage | undefined {
    const batch = this.#openToolBatch;
    if (batch === undefined) {
      throw new Error(`tool result ${toolCallId} cannot be appended without an open tool batch`);
    }
    if (!batch.calls.some((call) => call.id === toolCallId)) {
      throw new Error(`tool result ${toolCallId} does not belong to the open tool batch`);
    }
    if (batch.results.has(toolCallId)) {
      throw new Error(`duplicate tool result for ${toolCallId}`);
    }
    batch.results.set(toolCallId, {
      text,
      ...(workspaceEdits !== undefined ? { workspaceEdits } : {}),
    });
    const flushed = this.flushToolResultsInOrder();
    return flushed[0];
  }

  /* --------------------------- ToolBatch --------------------------- */

  hasOpenToolBatch(): boolean {
    return this.#openToolBatch !== undefined;
  }

  openToolBatchCalls(): readonly ToolCall[] | undefined {
    return this.#openToolBatch?.calls;
  }

  beginToolBatch(calls: readonly ToolCall[]): void {
    if (calls.length === 0) throw new Error("cannot open an empty tool batch");
    const current = this.#openToolBatch;
    if (current !== undefined) {
      if (sameCalls(current.calls, calls)) return;
      throw new Error("cannot open a new tool batch while another tool batch is open");
    }
    this.#openToolBatch = { calls: [...calls], results: new Map(), nextToFlush: 0 };
  }

  /** 按 assistant 的 tool_calls 顺序，把已经到齐的结果落库。 */
  flushToolResultsInOrder(): StoredMessage[] {
    const batch = this.#openToolBatch;
    if (batch === undefined) return [];

    const flushed: StoredMessage[] = [];
    while (batch.nextToFlush < batch.calls.length) {
      const call = batch.calls[batch.nextToFlush]!;
      const pending = batch.results.get(call.id);
      if (pending === undefined) break;
      batch.results.delete(call.id);

      const workspace =
        pending.workspaceEdits === undefined
          ? undefined
          : createWorkspaceChange(pending.workspaceEdits);
      flushed.push(
        this.#append({
          role: "tool",
          origin: "tool",
          parts: [textPart(pending.text)],
          toolCallId: call.id,
          ...(workspace !== undefined ? { workspace } : {}),
        }),
      );
      batch.nextToFlush += 1;
    }

    if (batch.nextToFlush >= batch.calls.length) this.#openToolBatch = undefined;
    return flushed;
  }

  /**
   * 关闭当前 batch；缺失的结果按原 tool call 顺序补 synthetic error。
   *
   * 正常流程应已由 flushToolResultsInOrder 自动关闭；这里主要服务 abort、
   * 工具执行异常和低层调用方漏结果三种场景。
   */
  finishToolBatch(missingText: string = MISSING_TOOL_RESULT_ABORT): StoredMessage[] {
    const batch = this.#openToolBatch;
    if (batch === undefined) return [];

    const appended: StoredMessage[] = this.flushToolResultsInOrder();
    // flush 可能因为缺前序结果而停下；补齐后再 flush，直到所有 call 都有结果。
    while (batch.nextToFlush < batch.calls.length) {
      const call = batch.calls[batch.nextToFlush]!;
      appended.push(
        this.#append({
          role: "tool",
          origin: "tool",
          parts: [textPart(missingText)],
          toolCallId: call.id,
        }),
      );
      batch.nextToFlush += 1;
      appended.push(...this.flushToolResultsInOrder());
    }
    this.#openToolBatch = undefined;
    return appended;
  }

  abortToolBatch(reason: string = MISSING_TOOL_RESULT_ABORT): StoredMessage[] {
    return this.finishToolBatch(reason);
  }

  /* --------------------------- 消息队列 --------------------------- */

  /**
   * 提交用户消息：空闲时立即落库并返回 started；turn / batch 中则排队。
   *
   * 注意：这里只负责消息落库，不负责推进 turn。真正跑 turn 仍由 loop 负责。
   */
  submitUser(text: string): SubmitResult {
    if (this.#turnActive || this.#openToolBatch !== undefined) {
      return { status: "queued", position: this.enqueueUser(text) };
    }
    return { status: "started", msgid: this.appendUser(text).msgid };
  }

  enqueueUser(text: string): number {
    this.#userQueue.push({ kind: "user", text, createdAt: this.#now() });
    return this.#userQueue.length;
  }

  enqueueInjection(text: string, source: InjectionSource = "system"): void {
    if (this.#turnActive || this.#openToolBatch !== undefined) {
      this.#injectionQueue.push({ kind: "inject", text, source, createdAt: this.#now() });
      return;
    }
    this.appendInjection(text, source);
  }

  /** turn 正常结束后由调用方取一条排队用户消息。 */
  dequeueUserAfterTurn(): string | undefined {
    if (this.#turnActive || this.#openToolBatch !== undefined) {
      throw new Error("cannot dequeue user message while a turn or tool batch is active");
    }
    return this.#userQueue.shift()?.text;
  }

  /** 在没有 open tool batch 的模型步边界，按 FIFO flush 注入消息。 */
  drainInjectionsAtSafeBoundary(): StoredMessage[] {
    if (this.#openToolBatch !== undefined) {
      throw new Error("cannot drain injections while a tool batch is open");
    }
    const drained: StoredMessage[] = [];
    while (this.#injectionQueue.length > 0) {
      const item = this.#injectionQueue.shift()!;
      // 已通过 open-batch 检查；这里在 turn 内也允许落库，因为这是安全边界。
      drained.push(
        this.#append({
          role: "system",
          origin: "inject",
          injectionSource: item.source,
          parts: [textPart(item.text)],
        }),
      );
    }
    return drained;
  }

  clearQueues(): void {
    this.#userQueue = [];
    this.#injectionQueue = [];
  }

  /* --------------------------- 上下文 --------------------------- */

  buildContext(): ChatMessage[] {
    return buildContext(this.#messages, { extensionRole: this.#extensionRole });
  }

  prefixHash(uptoMsgId?: MsgId): string {
    return prefixHash(this.#messages, uptoMsgId, { extensionRole: this.#extensionRole });
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

  /** 开始一个 turn；turn 期间普通 user / injection 只能排队。 */
  beginTurn(): void {
    if (this.#turnActive) throw new Error("session already has an active turn");
    if (this.#openToolBatch !== undefined) {
      throw new Error("cannot start a turn while a tool batch is open");
    }
    this.#turnActive = true;
    this.#turn += 1;
  }

  endTurn(): void {
    this.#turnActive = false;
  }

  /** 兼容旧调用；语义等同 beginTurn。 */
  advanceTurn(): void {
    this.beginTurn();
  }

  snapshot(): readonly StoredMessage[] {
    return [...this.#messages];
  }

  /* --------------------------- 内部 --------------------------- */

  #assertAppendable(kind: string): void {
    if (this.#openToolBatch !== undefined) {
      throw new Error(`${kind} cannot be appended while a tool batch is open`);
    }
    if (this.#turnActive) {
      throw new Error(`${kind} cannot be appended inside an active turn`);
    }
  }

  /**
   * 恢复时修复进程崩溃留下的尾部孤立 tool calls。
   *
   * 只修复"已有 tool results 恰好是 calls 的前缀、后续缺失"这一种可安全
   * 自动恢复的形态；已经插入了 user / assistant 的旧历史无法靠追加修复，
   * 会明确报错而不是生成更坏的上下文。
   */
  #repairOrphanedToolCalls(): void {
    let index = this.#messages.length - 1;
    const trailing: StoredMessage[] = [];
    while (index >= 0 && this.#messages[index]?.role === "tool") {
      trailing.unshift(this.#messages[index]!);
      index -= 1;
    }
    const assistant = this.#messages[index];
    if (assistant === undefined || assistant.role !== "assistant") return;
    const calls = assistant.toolCalls;
    if (calls === undefined || calls.length === 0) return;

    for (let i = 0; i < trailing.length; i += 1) {
      if (trailing[i]?.toolCallId !== calls[i]?.id) {
        throw new Error(
          `无法自动修复孤立的 tool call：历史中的 tool result 顺序与 assistant tool_calls 不匹配（msgid ${assistant.msgid}）`,
        );
      }
    }
    if (trailing.length >= calls.length) return;

    for (let i = trailing.length; i < calls.length; i += 1) {
      const call = calls[i]!;
      this.#append({
        role: "tool",
        origin: "tool",
        parts: [textPart(MISSING_TOOL_RESULT_CRASH)],
        toolCallId: call.id,
      });
    }
  }

  /**
   * 校验恢复出来的历史没有第二种不可修复的协议破坏：tool call 与 tool result
   * 中间插了 user / assistant / injection，或 tool result 没有对应 call。
   */
  #assertToolCallSequences(): void {
    const consumed = new Set<number>();
    for (let index = 0; index < this.#messages.length; index += 1) {
      const message = this.#messages[index]!;
      if (message.role !== "assistant") continue;
      const calls = message.toolCalls;
      if (calls === undefined || calls.length === 0) continue;

      for (let offset = 0; offset < calls.length; offset += 1) {
        const resultIndex = index + 1 + offset;
        const result = this.#messages[resultIndex];
        const call = calls[offset]!;
        if (result === undefined || result.role !== "tool" || result.toolCallId !== call.id) {
          throw new Error(
            `无法自动修复 tool call 序列：assistant msgid ${message.msgid} 的 tool call ${call.id} 后没有连续的对应 tool result`,
          );
        }
        consumed.add(resultIndex);
      }
    }

    for (let index = 0; index < this.#messages.length; index += 1) {
      const message = this.#messages[index]!;
      if (message.role === "tool" && !consumed.has(index)) {
        throw new Error(`无法自动修复 tool call 序列：msgid ${message.msgid} 的 tool result 没有对应 assistant tool call`);
      }
    }
  }

  #append(input: {
    role: StoredMessage["role"];
    origin: StoredMessage["origin"];
    injectionSource?: InjectionSource;
    parts: StoredMessage["parts"];
    reasoning?: string;
    toolCallId?: string;
    toolCalls?: readonly ToolCall[];
    workspace?: StoredMessage["workspace"];
  }): StoredMessage {
    const msgid = this.#nextMsgId;
    this.#nextMsgId += 1;
    const parent = lastMsgId(this.#messages);

    const msg = makeMessage({
      msgid,
      ...(parent >= 0 ? { parentMsgId: parent } : {}),
      role: input.role,
      origin: input.origin,
      ...(input.injectionSource !== undefined ? { injectionSource: input.injectionSource } : {}),
      parts: input.parts,
      createdAt: this.#now(),
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    });

    this.#messages.push(msg);
    this.#onMessage?.(msg);
    return msg;
  }
}
