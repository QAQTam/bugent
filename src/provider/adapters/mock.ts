/**
 * mock adapter —— Phase 1 的"免网络"实现。
 *
 * 存在的意义：让 P2 / P4 在没有 API key、没有网络的情况下也能端到端测试。
 * 它是脚本化的：你给它一串"这一轮要说的话"，它按顺序吐出来。
 */

import type { ChatChunk, ChatRequest, FinishReason, ModelClient, Usage } from "../types.ts";
import { estimateTokens } from "../../util/tokenizer.ts";

/** 一轮对话的脚本：要么直接给 chunks，要么根据请求现算。 */
export type MockTurn =
  | { text?: string; toolCalls?: { id: string; name: string; args: unknown }[]; reason?: FinishReason }
  | { chunks: ChatChunk[] }
  | ((req: ChatRequest, turn: number) => ChatChunk[]);

export interface MockClientOptions {
  id?: string;
  script: MockTurn[];
  /** 默认 0，模拟流式逐字吐字时可设小一点。 */
  chunkDelayMs?: number;
  /**
   * 回传一份"看起来像真的"usage（输入按请求文本估算、输出按回复估算、命中按
   * 固定比例）。默认关闭 —— 多数测试关心的是"provider 不回传 usage 时也不炸"，
   * 打开它是为了测状态栏那三项指标有没有接上。
   */
  syntheticUsage?: boolean;
}

function normalizeTurn(turn: MockTurn, req: ChatRequest, index: number): ChatChunk[] {
  if (typeof turn === "function") return turn(req, index);
  if ("chunks" in turn) return turn.chunks;

  const chunks: ChatChunk[] = [];
  if (turn.text) chunks.push({ type: "text", delta: turn.text });

  for (const call of turn.toolCalls ?? []) {
    chunks.push({ type: "tool_call", id: call.id, name: call.name, argsDelta: "" });
    chunks.push({ type: "tool_call", id: call.id, name: call.name, argsDelta: JSON.stringify(call.args) });
  }

  const reason: FinishReason = turn.reason ?? ((turn.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop");
  chunks.push({ type: "usage", usage: { input: 0, output: 0 } });
  chunks.push({ type: "done", reason });
  return chunks;
}

export function createMockClient(options: MockClientOptions): ModelClient {
  const id = options.id ?? "mock/mock/mock";
  const delay = options.chunkDelayMs ?? 0;
  let turn = 0;

  /** 命中比例固定 60%：够用来验证"命中率 = cached / input"这条链路。 */
  const syntheticUsage = (req: ChatRequest, chunks: ChatChunk[]): Usage => {
    let reply = "";
    for (const chunk of chunks) {
      if (chunk.type === "text") reply += chunk.delta;
    }
    const promptText = req.messages
      .map((message) => message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))
      .join("\n");
    const input = Math.max(1, Math.round(estimateTokens(promptText)));
    const output = Math.max(1, Math.round(estimateTokens(reply)));
    const cached = Math.round(input * 0.6);
    return { input, output, cached, cacheMiss: input - cached };
  };

  const withSyntheticUsage = (req: ChatRequest, chunks: ChatChunk[]): ChatChunk[] => {
    const usage: ChatChunk = { type: "usage", usage: syntheticUsage(req, chunks) };
    const kept = chunks.filter((chunk) => chunk.type !== "usage");
    const doneAt = kept.findIndex((chunk) => chunk.type === "done");
    if (doneAt < 0) return [...kept, usage];
    return [...kept.slice(0, doneAt), usage, ...kept.slice(doneAt)];
  };

  return {
    id,
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const scripted = options.script[turn];
      turn += 1;

      if (scripted === undefined) {
        // 脚本用完了：给一个明确的收尾，避免 loop 空转。
        yield { type: "text", delta: "[mock] script exhausted" };
        yield { type: "done", reason: "stop" };
        return;
      }

      const chunks = normalizeTurn(scripted, req, turn - 1);
      const out = options.syntheticUsage === true ? withSyntheticUsage(req, chunks) : chunks;
      for (const chunk of out) {
        if (req.signal?.aborted) {
          yield { type: "done", reason: "error" };
          return;
        }
        if (delay > 0) await Bun.sleep(delay);
        yield chunk;
      }
    },
  };
}
