/**
 * Transcript —— loop 事件 -> 显示条目的映射。
 *
 * 为什么单独抽出来：
 *   一次 runTurn 内部可能产生**多条** assistant 消息（工具调用一轮 + 收尾一轮），
 *   早期实现把它们拼进了同一个显示块，导致 "我来看看目录。命令执行完毕。" 挤在一行。
 *   这段逻辑是纯的，抽出来就能单测，不必依赖 PTY。
 */

import type { ToolCall, Usage } from "../provider/types.ts";
import { storedText, type MsgId, type StoredMessage } from "../core/message.ts";

export type DisplayItem =
  | { kind: "user"; text: string; msgid?: MsgId }
  | { kind: "assistant"; text: string; msgid?: MsgId }
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
      /**
       * 运行中的流式输出。**只保留最后几行** ——
       * 一个跑十分钟的命令可能产出几十万行，全留着会拖垮渲染。
       */
      progress: string;
      /** 用户点击折叠行后展开全文（鼠标交互）。 */
      expanded: boolean;
    }
  | { kind: "error"; text: string };

/** 一个显示块可以落到哪个消息节点；没有对应持久消息时返回 undefined。 */
export function displayMsgId(item: DisplayItem): MsgId | undefined {
  if (item.kind === "error") return undefined;
  if (item.kind === "tool") return item.msgid ?? item.assistantMsgid;
  return item.msgid;
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
  #items: DisplayItem[] = [];
  /** 与 #items 对齐的内容版本；布局缓存用它判断某个块是否要重渲染。 */
  #versions: number[] = [];
  /** 全局内容版本；布局层可在没有变化时直接跳过重建。 */
  #revision = 0;
  /** 当前正在接收流式文本的 assistant 块；undefined 表示下段文本要开新块。 */
  #streamingIndex: number | undefined;

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

  #push(item: DisplayItem): void {
    this.#items.push(item);
    this.#versions.push(0);
    this.#revision += 1;
  }

  #bump(index: number): void {
    this.#versions[index] = (this.#versions[index] ?? 0) + 1;
    this.#revision += 1;
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

  startTool(call: ToolCall, assistantMsgid?: MsgId): void {
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
  appendToolProgress(callId: string, chunk: string): void {
    if (chunk.length === 0) return;
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const item = this.#items[i];
      if (item !== undefined && item.kind === "tool" && item.callId === callId && !item.done) {
        item.progress = keepLastLines(item.progress + chunk, TOOL_PROGRESS_LINES);
        this.#bump(i);
        return;
      }
    }
  }

  finishTool(callId: string, output: string, ok: boolean, msgid?: MsgId): boolean {
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const item = this.#items[i];
      if (item !== undefined && item.kind === "tool" && item.callId === callId && !item.done) {
        item.output = output;
        item.ok = ok;
        item.done = true;
        if (msgid !== undefined) item.msgid = msgid;
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
    this.#items = [];
    this.#versions = [];
    this.#streamingIndex = undefined;
    this.#revision += 1;

    for (const message of messages) {
      if (message.role === "system") continue;
      const text = storedText(message);

      if (message.role === "user") {
        this.pushUser(text, message.msgid);
        continue;
      }

      if (message.role === "assistant") {
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
    const merged: Usage = { input: total.input + delta.input, output: total.output + delta.output };
    const cached = (total.cached ?? 0) + (delta.cached ?? 0);
    if (cached > 0) merged.cached = cached;
    return merged;
  }
}
