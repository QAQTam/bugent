/**
 * Transcript —— loop 事件 -> 显示条目的映射。
 *
 * 为什么单独抽出来：
 *   一次 runTurn 内部可能产生**多条** assistant 消息（工具调用一轮 + 收尾一轮），
 *   早期实现把它们拼进了同一个显示块，导致 "我来看看目录。命令执行完毕。" 挤在一行。
 *   这段逻辑是纯的，抽出来就能单测，不必依赖 PTY。
 */

import type { ToolCall, Usage } from "../provider/types.ts";
import { mergeUsage } from "../provider/types.ts";
import type { ToolCallDelta } from "../core/loop.ts";
import type { PatchProgress } from "../patch/streaming-progress.ts";
import type { FileArgsProgress } from "../tools/file-progress.ts";
import { storedText, type MsgId, type StoredMessage } from "../core/message.ts";
import type { ToolPresentation } from "../core/presentation.ts";

/**
 * 布局层消费的增量变更。
 *
 * 这是避免每帧重扫全部历史的唯一事实来源：
 *   - `rebuild` 表示结构被替换/删除，必须全量重建；
 *   - `appendedFrom` 表示从这里到 items.length 都是新增 block；
 *   - `dirty` 表示已有 block 的内容版本发生变化。
 */
export interface TranscriptLayoutChanges {
  rebuild: boolean;
  appendedFrom?: number;
  dirty: readonly number[];
}

export type DisplayItem =
  | { kind: "user"; text: string; msgid?: MsgId }
  | {
      kind: "assistant";
      text: string;
      msgid?: MsgId;
      /** PERF-002：超出保留窗口后正文移出内存；点击带此标记的卡片回放。 */
      evicted?: true;
    }
  | {
      kind: "reasoning";
      /** UI 内稳定 id；不随完成、恢复或 msgid 绑定而变化。 */
      id: string;
      /** live 阶段为空；完成后保存完整 reasoning 原文。 */
      text: string;
      done: boolean;
      /** 默认 false：完成后必须由用户主动点击 Thought 头部才展开。 */
      expanded: boolean;
      /** live 阶段开始时间，仅用于计算当前进程内的耗时。 */
      startedAt?: number;
      /** 完成态耗时；恢复会话时通常没有该字段。 */
      durationMs?: number;
      /** 可选 token 估算。 */
      tokens?: number;
      /** 完成后绑定所属 assistant 消息。 */
      msgid?: MsgId;
      /** 当前 turn 内序号，从 1 开始。 */
      sequence?: number;
      /** 中断时标记，不伪装成正常完成。 */
      interrupted?: boolean;
      /** PERF-002：超出保留窗口后正文移出内存；点击卡片回放。 */
      evicted?: true;
    }
  | {
      kind: "tool";
      callId: string;
      name: string;
      args: unknown;
      output: string;
      ok: boolean;
      done: boolean;
      /** 请求该工具的 assistant 消息；没有文本时这是工具卡片唯一的来源消息。 */
      assistantMsgid?: MsgId;
      /** 工具结果消息；完成后优先用它作为操作目标。 */
      msgid?: MsgId;
      /** 运行中的流式输出。**只保留最后几行** ——
       * 一个跑十分钟的命令可能产出几十万行，全留着会拖垮渲染。
       */
      progress: string;
      /** 当前进度缓冲最后收到的输出流，用于实时语义着色。 */
      progressStream?: "stdout" | "stderr";
      /** 结构化展示信息；不进入模型上下文。 */
      presentation?: ToolPresentation;
      /** 参数仍在流式到达，尚未进入真实工具执行。 */
      streaming?: boolean;
      /** apply_patch 参数增量解析出的实时 diff 统计。 */
      patchProgress?: PatchProgress;
      /** write_file / edit_file 参数增量解析出的实时路径与行数。 */
      fileProgress?: FileArgsProgress;
      /** 用户点击折叠行后展开全文（鼠标交互）。 */
      expanded: boolean;
      /** PERF-002：超出保留窗口后输出移出内存；点击卡片重新加载回放。 */
      evicted?: true;
    }
  | { kind: "error"; text: string };

/** 一个显示块可以落到哪个消息节点；没有对应持久消息时返回 undefined。 */
export function displayMsgId(item: DisplayItem): MsgId | undefined {
  if (item.kind === "error") return undefined;
  if (item.kind === "tool") return item.msgid ?? item.assistantMsgid;
  return item.msgid;
}

/**
 * 消息操作使用的锚点。
 *
 * 工具卡片完成后显示的是 tool result，但“撤销这次工具动作”真正需要移除的
 * 是请求它的 assistant tool-call 消息，以及紧随其后的 tool result。因此操作
 * 锚点优先指向 assistantMsgid。
 */
export function displayActionMsgId(item: DisplayItem): MsgId | undefined {
  if (item.kind === "tool") return item.assistantMsgid ?? item.msgid;
  return displayMsgId(item);
}

/** 运行中保留的进度行数。 */
export const TOOL_PROGRESS_LINES = 6;

/** 只保留末尾 N 行，防止进度缓冲无限增长。 */
export function keepLastLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(-maxLines).join("\n");
}

export class Transcript {
  /**
   * 保留窗口（PERF-002）：窗口外的已完成条目把正文移出内存，只留
   * "已释放"占位卡片；用户点击占位卡片时 app 调 rebuildFrom() 从会话
   * 消息（其持久层是 SQLite）整体回放。
   */
  #retention: number;
  #evictedCount = 0;
  /** 已扫过高水位（见 #sweepEviction）。 */
  #sweptUpTo = 0;
  #items: DisplayItem[] = [];
  /** 与 #items 对齐的内容版本；布局缓存用它判断某个块是否要重渲染。 */
  #versions: number[] = [];
  /** 全局内容版本；布局层可在没有变化时直接跳过重建。 */
  #revision = 0;
  /** 当前正在接收流式文本的 assistant 块；undefined 表示下段文本要开新块。 */
  #streamingIndex: number | undefined;
  /** 当前 assistant step 的 live reasoning item；完成后清空。 */
  #liveReasoningIndex: number | undefined;
  /** reasoning UI id 计数器；只保证当前 Transcript 内稳定唯一。 */
  #reasoningId = 1;
  /**
   * 内容变更通知。TUI 用它把"改了就重画"变成结构性保证 ——
   * 以前每个流式回调各自记得请求重绘，漏一处不会报错、只会让界面变慢。
   */
  #onChange: (() => void) | undefined;
  /** 布局层增量变更；由 consumeLayoutChanges() 取走并清空。 */
  #layoutRebuild = false;
  #layoutAppendedFrom: number | undefined;
  #layoutDirty = new Set<number>();

  constructor(options: { retentionItems?: number } = {}) {
    this.#retention = options.retentionItems ?? 400;
  }

  set onChange(handler: (() => void) | undefined) {
    this.#onChange = handler;
  }

  get items(): readonly DisplayItem[] {
    return this.#items;
  }

  /** 任意条目内容变化时递增。 */
  get revision(): number {
    return this.#revision;
  }

  /** 某个显示条目的内容版本。 */
  itemVersion(index: number): number {
    return this.#versions[index] ?? 0;
  }

  /**
   * 取走自上次调用以来的布局变更。
   *
   * 只有 TuiApp 的布局更新会消费它；消费后清空，避免同一批变更重复应用。
   */
  consumeLayoutChanges(): TranscriptLayoutChanges {
    const changes: TranscriptLayoutChanges = {
      rebuild: this.#layoutRebuild,
      ...(this.#layoutAppendedFrom !== undefined
        ? { appendedFrom: this.#layoutAppendedFrom }
        : {}),
      dirty: [...this.#layoutDirty],
    };
    this.#layoutRebuild = false;
    this.#layoutAppendedFrom = undefined;
    this.#layoutDirty.clear();
    return changes;
  }

  /** 已被移出内存的条目数（用于 UI 提示"可点击回放"）。 */
  get evictedCount(): number {
    return this.#evictedCount;
  }

  /**
   * **唯一**的内容变更原语：版本号递增与外部通知必须成对发生。
   *
   * 所有改动条目的方法都必须经过这里（或经过 `#push` / `#bump`），
   * 否则布局缓存会看到旧版本、或者界面压根不重画。
   */
  #touch(): void {
    this.#revision += 1;
    this.#onChange?.();
  }

  #push(item: DisplayItem): void {
    const index = this.#items.length;
    this.#items.push(item);
    this.#versions.push(0);
    if (this.#layoutAppendedFrom === undefined || index < this.#layoutAppendedFrom) {
      this.#layoutAppendedFrom = index;
    }
    this.#layoutDirty.add(index);
    this.#touch();
    this.#sweepEviction();
  }

  /**
   * 保留窗口清扫（PERF-002）：窗口外的已完成条目把正文移出内存。
   *
   * 移除的只是 transcript 这份渲染拷贝 —— 会话正文（session.messages，
   * 持久层是 SQLite）不受影响，那是 provider 上下文必需的；点击占位卡片
   * 时由 app 调 rebuildFrom() 整体回放。
   */
  #sweepEviction(): void {
    const cutoff = this.#items.length - this.#retention;
    if (cutoff <= this.#sweptUpTo) return;
    // #sweptUpTo 是已扫过高水位：evict 过的条目不会复活，从水位往后扫即可，
    // restore 大会话时整体 O(n) 而不是 O(n²)。
    for (let index = Math.max(0, this.#sweptUpTo); index < cutoff; index += 1) {
      const item = this.#items[index]!;
      if (item.kind === "user" || item.kind === "error") continue; // 短文本，不参与释放
      if (item.evicted === true) continue;
      if (item.kind === "assistant" || item.kind === "reasoning") {
        if (item.text.length === 0) continue;
        item.text = "";
        item.evicted = true;
        if (item.kind === "reasoning") item.expanded = false;
      } else if (item.kind === "tool") {
        if (!item.done || item.output.length === 0) continue; // 运行中的不动
        item.output = "";
        item.expanded = false;
        delete item.presentation;
        delete item.patchProgress;
        delete item.fileProgress;
        item.evicted = true;
      } else {
        continue;
      }
      this.#evictedCount += 1;
      this.#bump(index);
    }
  }

  #bump(index: number): void {
    this.#versions[index] = (this.#versions[index] ?? 0) + 1;
    this.#layoutDirty.add(index);
    this.#touch();
  }

  pushUser(text: string, msgid?: MsgId): void {
    this.#push({ kind: "user", text, ...(msgid !== undefined ? { msgid } : {}) });
  }

  /** 流式文本增量。同一段回复的增量会累积到同一个显示块。 */
  appendAssistantText(delta: string): void {
    if (delta.length === 0) return;

    let index = this.#streamingIndex;
    if (index === undefined) {
      this.#push({ kind: "assistant", text: "" });
      index = this.#items.length - 1;
      this.#streamingIndex = index;
    }

    const item = this.#items[index];
    if (item !== undefined && item.kind === "assistant") {
      item.text += delta;
      this.#bump(index);
    }
  }

  /**
   * 一条 assistant 消息结束（loop 的 onAssistant 回调）。
   * 关键：这里必须断开流式块，否则下一条 assistant 消息会被拼到同一块里。
   */
  endAssistant(msgid?: MsgId): void {
    const index = this.#streamingIndex;
    if (index !== undefined && msgid !== undefined) {
      const item = this.#items[index];
      if (item !== undefined && item.kind === "assistant") {
        item.msgid = msgid;
        this.#bump(index);
      }
    }
    this.#streamingIndex = undefined;
  }

  /**
   * 开始一个 live reasoning 占位。
   *
   * 同一 assistant step 的多个 reasoning delta 只复用同一个 item；调用方应只在
   * 第一次 delta 时调用。返回值是稳定 UI id，完成后仍可用它切换展开状态。
   */
  beginReasoning(startedAt = Date.now()): string {
    const live = this.#liveReasoningIndex;
    if (live !== undefined) {
      const item = this.#items[live];
      if (item !== undefined && item.kind === "reasoning" && !item.done) return item.id;
      this.#liveReasoningIndex = undefined;
    }

    const id = `reasoning-${this.#reasoningId}`;
    this.#reasoningId += 1;
    this.#push({
      kind: "reasoning",
      id,
      text: "",
      done: false,
      expanded: false,
      startedAt,
    });
    this.#liveReasoningIndex = this.#items.length - 1;
    return id;
  }

  /**
   * 原地结束 live reasoning。
   *
   * 必须保留原 index，否则后续 assistant 文本和工具卡片会跑到 Thought 前面。
   * 完成后固定保持折叠，展开只能由用户点击触发。
   */
  finishReasoning(options: {
    text: string;
    msgid: MsgId;
    durationMs: number;
    tokens?: number;
  }): void {
    const sequence = this.#nextReasoningSequence();
    const index = this.#liveReasoningIndex;
    if (index !== undefined) {
      const item = this.#items[index];
      if (item !== undefined && item.kind === "reasoning" && !item.done) {
        item.text = options.text;
        item.done = true;
        item.expanded = false;
        item.msgid = options.msgid;
        item.durationMs = Math.max(0, options.durationMs);
        item.sequence = sequence;
        if (options.tokens !== undefined) item.tokens = options.tokens;
        this.#liveReasoningIndex = undefined;
        this.#bump(index);
        return;
      }
      this.#liveReasoningIndex = undefined;
    }

    if (options.text.length === 0) return;
    const id = `reasoning-${this.#reasoningId}`;
    this.#reasoningId += 1;
    this.#push({
      kind: "reasoning",
      id,
      text: options.text,
      done: true,
      expanded: false,
      durationMs: Math.max(0, options.durationMs),
      ...(options.tokens !== undefined ? { tokens: options.tokens } : {}),
      msgid: options.msgid,
      sequence,
    });
  }

  /** 丢弃尚未完成的 live reasoning；用于 abort / provider error。 */
  discardReasoning(): void {
    const index = this.#liveReasoningIndex;
    this.#liveReasoningIndex = undefined;
    if (index === undefined) return;
    const item = this.#items[index];
    if (item === undefined || item.kind !== "reasoning" || item.done) return;

    this.#items.splice(index, 1);
    this.#versions.splice(index, 1);
    if (this.#streamingIndex !== undefined && index < this.#streamingIndex) {
      this.#streamingIndex -= 1;
    }
    this.#layoutRebuild = true;
    this.#touch();
  }

  /** 切换已完成 Thought 的展开状态。 */
  toggleReasoningExpanded(id: string): boolean {
    for (let index = 0; index < this.#items.length; index += 1) {
      const item = this.#items[index];
      if (item !== undefined && item.kind === "reasoning" && item.id === id && item.done) {
        item.expanded = !item.expanded;
        this.#bump(index);
        return true;
      }
    }
    return false;
  }

  /** PERF-002：该工具卡片是否是"已释放"占位（点击 = 回放而不是展开）。 */
  isEvictedTool(callId: string): boolean {
    return this.#items.some(
      (item) => item.kind === "tool" && item.callId === callId && item.evicted === true,
    );
  }

  /** PERF-002：该 Thought 是否是"已释放"占位。 */
  isEvictedReasoning(id: string): boolean {
    return this.#items.some(
      (item) => item.kind === "reasoning" && item.id === id && item.evicted === true,
    );
  }

  /** 当前 turn 内已完成 Thought 的数量 + 1。 */
  #nextReasoningSequence(): number {
    let sequence = 1;
    for (let index = this.#items.length - 1; index >= 0; index -= 1) {
      const item = this.#items[index];
      if (item === undefined) continue;
      if (item.kind === "user") break;
      if (item.kind === "reasoning" && item.done) sequence += 1;
    }
    return sequence;
  }

  #openToolIndex(callId: string): number | undefined {
    for (let index = this.#items.length - 1; index >= 0; index -= 1) {
      const item = this.#items[index];
      if (item !== undefined && item.kind === "tool" && item.callId === callId && !item.done) {
        return index;
      }
    }
    return undefined;
  }

  /** 参数增量到达时创建或更新 provisional 工具卡片。 */
  updateToolCallDelta(delta: ToolCallDelta): void {
    if (delta.id.length === 0) return;
    const existing = this.#openToolIndex(delta.id);
    if (existing !== undefined) {
      const item = this.#items[existing];
      if (item !== undefined && item.kind === "tool") {
        if (delta.name.length > 0) item.name = delta.name;
        item.args = delta.args;
        item.streaming = true;
        this.#bump(existing);
      }
      return;
    }

    this.#push({
      kind: "tool",
      callId: delta.id,
      name: delta.name || "tool",
      args: delta.args,
      output: "",
      ok: true,
      done: false,
      streaming: true,
      progress: "",
      expanded: false,
    });
  }

  /** provider 重试时丢弃尚未执行、也没有持久化 msgid 的 provisional 卡片。 */
  clearStreamingTools(): void {
    let removed = false;
    for (let index = this.#items.length - 1; index >= 0; index -= 1) {
      const item = this.#items[index];
      if (item !== undefined && item.kind === "tool" && item.streaming === true && !item.done) {
        this.#items.splice(index, 1);
        this.#versions.splice(index, 1);
        removed = true;
        // 流式 assistant 可能排在 provisional 工具卡之后（工具执行完后的收尾
        // 回复）；删除前面的条目必须同步移动 streamingIndex，否则后续增量
        // 会写到错误 block，甚至越界丢失。
        if (this.#streamingIndex !== undefined && index < this.#streamingIndex) {
          this.#streamingIndex -= 1;
        }
        if (this.#liveReasoningIndex !== undefined && index < this.#liveReasoningIndex) {
          this.#liveReasoningIndex -= 1;
        }
      }
    }
    if (removed) this.#layoutRebuild = true;
    this.#touch();
  }

  setToolPatchProgress(callId: string, progress: PatchProgress): void {
    const index = this.#openToolIndex(callId);
    if (index === undefined) return;
    const item = this.#items[index];
    if (item !== undefined && item.kind === "tool") {
      item.patchProgress = progress;
      this.#bump(index);
    }
  }

  setToolFileProgress(callId: string, progress: FileArgsProgress): void {
    const index = this.#openToolIndex(callId);
    if (index === undefined) return;
    const item = this.#items[index];
    if (item !== undefined && item.kind === "tool") {
      item.fileProgress = progress;
      this.#bump(index);
    }
  }

  startTool(call: ToolCall, assistantMsgid?: MsgId): void {
    const existing = this.#openToolIndex(call.id);
    if (existing !== undefined) {
      const item = this.#items[existing];
      if (item !== undefined && item.kind === "tool") {
        item.name = call.name;
        item.args = call.args;
        item.streaming = false;
        if (assistantMsgid !== undefined) item.assistantMsgid = assistantMsgid;
        this.#bump(existing);
        return;
      }
    }

    this.#push({
      kind: "tool",
      callId: call.id,
      name: call.name,
      args: call.args,
      output: "",
      ok: true,
      done: false,
      ...(assistantMsgid !== undefined ? { assistantMsgid } : {}),
      progress: "",
      expanded: false,
    });
  }

  /** 切换展开状态；返回是否命中了某个工具条目。 */
  toggleToolExpanded(callId: string): boolean {
    for (let i = 0; i < this.#items.length; i += 1) {
      const item = this.#items[i];
      if (item !== undefined && item.kind === "tool" && item.callId === callId) {
        item.expanded = !item.expanded;
        this.#bump(i);
        return true;
      }
    }
    return false;
  }

  /** 工具运行中的流式输出。只保留末尾若干行，内存有界。 */
  appendToolProgress(
    callId: string,
    chunk: string,
    stream: "stdout" | "stderr" = "stdout",
  ): void {
    if (chunk.length === 0) return;
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const item = this.#items[i];
      if (item !== undefined && item.kind === "tool" && item.callId === callId && !item.done) {
        item.progress = keepLastLines(item.progress + chunk, TOOL_PROGRESS_LINES);
        item.progressStream = stream;
        this.#bump(i);
        return;
      }
    }
  }

  finishTool(
    callId: string,
    output: string,
    ok: boolean,
    msgid?: MsgId,
    presentation?: ToolPresentation,
  ): boolean {
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const item = this.#items[i];
      if (item !== undefined && item.kind === "tool" && item.callId === callId && !item.done) {
        item.output = output;
        item.ok = ok;
        item.done = true;
        item.streaming = false;
        if (item.patchProgress !== undefined) {
          item.patchProgress = { ...item.patchProgress, complete: true };
        }
        if (item.fileProgress !== undefined) {
          item.fileProgress = { ...item.fileProgress, complete: true };
        }
        if (msgid !== undefined) item.msgid = msgid;
        if (presentation !== undefined) item.presentation = presentation;
        this.#bump(i);
        return true;
      }
    }
    return false;
  }

  /**
   * 从持久化消息路径重建显示流。
   *
   * 分支切换后不能沿用旧 transcript：它可能包含另一条分支上已经流式显示、
   * 但不在新路径里的消息。这里按 msgid 升序重放，确保 UI 与 session 上下文一致。
   */
  restore(messages: readonly StoredMessage[]): void {
    this.#resetForRebuild();
    this.#buildFromMessages(messages);
    this.#sweepEviction();
  }

  /**
   * 点击"回放"后整体重建（PERF-002）：把被移出内存的条目从会话消息
   * （其持久层是 SQLite）重新装载并渲染。重建期间暂停清扫 —— 回放的内容
   * 就是要读的；之后的追加继续移动保留窗口，旧内容照常再次释放。
   */
  rebuildFrom(messages: readonly StoredMessage[]): void {
    this.#resetForRebuild();
    const retention = this.#retention;
    this.#retention = Number.MAX_SAFE_INTEGER;
    try {
      this.#buildFromMessages(messages);
    } finally {
      this.#retention = retention;
    }
  }

  #resetForRebuild(): void {
    this.#items = [];
    this.#versions = [];
    this.#streamingIndex = undefined;
    this.#liveReasoningIndex = undefined;
    this.#reasoningId = 1;
    this.#evictedCount = 0;
    this.#sweptUpTo = 0;
    this.#layoutRebuild = true;
    this.#layoutAppendedFrom = undefined;
    this.#layoutDirty.clear();
    this.#touch();
  }

  #buildFromMessages(messages: readonly StoredMessage[]): void {
    let reasoningSequence = 0;
    for (const message of messages) {
      if (message.role === "system") continue;
      const text = storedText(message);

      if (message.role === "user") {
        reasoningSequence = 0;
        this.pushUser(text, message.msgid);
        continue;
      }

      if (message.role === "assistant") {
        if (message.reasoning !== undefined && message.reasoning.length > 0) {
          reasoningSequence += 1;
          const id = `reasoning-${this.#reasoningId}`;
          this.#reasoningId += 1;
          this.#push({
            kind: "reasoning",
            id,
            text: message.reasoning,
            done: true,
            expanded: false,
            msgid: message.msgid,
            sequence: reasoningSequence,
          });
        }
        if (text.length > 0) {
          this.appendAssistantText(text);
          this.endAssistant(message.msgid);
        }
        for (const call of message.toolCalls ?? []) this.startTool(call, message.msgid);
        continue;
      }

      if (message.role === "tool") {
        const callId = message.toolCallId;
        if (callId === undefined) continue;
        const ok = !text.startsWith("Error: ");
        if (!this.finishTool(callId, text, ok, message.msgid)) {
          this.#push({
            kind: "tool",
            callId,
            name: "tool",
            args: {},
            output: text,
            ok,
            done: true,
            msgid: message.msgid,
            progress: "",
            expanded: false,
          });
        }
      }
    }
  }

  pushError(text: string): void {
    this.#push({ kind: "error", text });
  }

  pushNotice(text: string): void {
    this.#push({ kind: "assistant", text });
  }

  /** 供 TuiApp 记录 token 用量（不进条目流）。 */
  static mergeUsage(total: Usage, delta: Usage): Usage {
    return mergeUsage(total, delta);
  }
}
