/**
 * Transcript —— loop 事件 -> 显示条目的映射。
 *
 * 为什么单独抽出来：
 *   一次 runTurn 内部可能产生**多条** assistant 消息（工具调用一轮 + 收尾一轮），
 *   早期实现把它们拼进了同一个显示块，导致 "我来看看目录。命令执行完毕。" 挤在一行。
 *   这段逻辑是纯的，抽出来就能单测，不必依赖 PTY。
 */

import type { ToolCall, Usage } from "../provider/types.ts";

export type DisplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      callId: string;
      name: string;
      args: unknown;
      output: string;
      ok: boolean;
      done: boolean;
      /**
       * 运行中的流式输出。**只保留最后几行** ——
       * 一个跑十分钟的命令可能产出几十万行，全留着会拖垮渲染。
       */
      progress: string;
      /** 用户点击折叠行后展开全文（鼠标交互）。 */
      expanded: boolean;
    }
  | { kind: "error"; text: string };

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

  pushUser(text: string): void {
    this.#push({ kind: "user", text });
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
  endAssistant(): void {
    this.#streamingIndex = undefined;
  }

  startTool(call: ToolCall): void {
    this.#push({
      kind: "tool",
      callId: call.id,
      name: call.name,
      args: call.args,
      output: "",
      ok: true,
      done: false,
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

  finishTool(callId: string, output: string, ok: boolean): void {
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const item = this.#items[i];
      if (item !== undefined && item.kind === "tool" && item.callId === callId && !item.done) {
        item.output = output;
        item.ok = ok;
        item.done = true;
        this.#bump(i);
        return;
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
