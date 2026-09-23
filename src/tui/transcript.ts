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
  /** 当前正在接收流式文本的 assistant 块；undefined 表示下段文本要开新块。 */
  #streamingIndex: number | undefined;

  get items(): readonly DisplayItem[] {
    return this.#items;
  }

  pushUser(text: string): void {
    this.#items.push({ kind: "user", text });
  }

  /** 流式文本增量。同一段回复的增量会累积到同一个显示块。 */
  appendAssistantText(delta: string): void {
    if (delta.length === 0) return;

    let index = this.#streamingIndex;
    if (index === undefined) {
      this.#items.push({ kind: "assistant", text: "" });
      index = this.#items.length - 1;
      this.#streamingIndex = index;
    }

    const item = this.#items[index];
    if (item !== undefined && item.kind === "assistant") item.text += delta;
  }

  /**
   * 一条 assistant 消息结束（loop 的 onAssistant 回调）。
   * 关键：这里必须断开流式块，否则下一条 assistant 消息会被拼到同一块里。
   */
  endAssistant(): void {
    this.#streamingIndex = undefined;
  }

  startTool(call: ToolCall): void {
    this.#items.push({
      kind: "tool",
      callId: call.id,
      name: call.name,
      args: call.args,
      output: "",
      ok: true,
      done: false,
      progress: "",
    });
  }

  /** 工具运行中的流式输出。只保留末尾若干行，内存有界。 */
  appendToolProgress(callId: string, chunk: string): void {
    if (chunk.length === 0) return;
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const item = this.#items[i];
      if (item !== undefined && item.kind === "tool" && item.callId === callId && !item.done) {
        item.progress = keepLastLines(item.progress + chunk, TOOL_PROGRESS_LINES);
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
        return;
      }
    }
  }

  pushError(text: string): void {
    this.#items.push({ kind: "error", text });
  }

  pushNotice(text: string): void {
    this.#items.push({ kind: "assistant", text });
  }

  /** 供 TuiApp 记录 token 用量（不进条目流）。 */
  static mergeUsage(total: Usage, delta: Usage): Usage {
    const merged: Usage = { input: total.input + delta.input, output: total.output + delta.output };
    const cached = (total.cached ?? 0) + (delta.cached ?? 0);
    if (cached > 0) merged.cached = cached;
    return merged;
  }
}
