/**
 * anthropic-messages adapter —— 对接 Anthropic `/v1/messages` 及其兼容实现。
 *
 * 本文件是 wire format 的唯一归属地。它把归一化 ChatMessage 翻译成 Messages API
 * 的 system 数组 + blocks 结构，把 SSE 流归一化成 ChatChunk。
 *
 * 与 openai-chat 的主要差异：
 *   - system prompt 是顶层参数，不是消息；
 *   - 工具结果是 user 消息里的 `tool_result` block（连续多条会合并进一条 user 消息）；
 *   - `max_tokens` 必填；
 *   - 流式按 content_block 分块（text_delta / thinking_delta / input_json_delta）。
 */

import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  FinishReason,
  JSONSchema,
  ModelClient,
  ToolSchema,
} from "../types.ts";
import { messageText } from "../types.ts";
import { stripAnsi } from "../../util/sanitize.ts";
import type { ReasoningReplay } from "./openai-chat.ts";
import {
  ensureLoopbackNoProxy,
  isLoopbackHost,
  readLines,
  resolveTlsConfig,
  type FetchInit,
  type ProviderProxy,
  type ProviderTlsConfig,
} from "./http.ts";

export interface AnthropicMessagesOptions {
  /** 形如 `https://api.anthropic.com/v1`；自动拼 `/messages`。 */
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** 额外塞进 body 的字段（如 `{"thinking":{"type":"enabled","budget_tokens":4096}}`）。 */
  extraBody?: Record<string, unknown>;
  /**
   * assistant 历史里 reasoning 的回放策略：
   * `none`（默认）不回放；其余值以 `thinking` block 回放。
   * 注意：官方 API 对带 tool use 的 thinking block 校验 signature，回放签名缺失
   * 的历史会被拒 —— 只在兼容网关或明确知道安全的场景打开。
   */
  reasoningReplay?: ReasoningReplay;
  /** 显式代理；false 表示直连。 */
  proxy?: ProviderProxy;
  /** TLS 配置；字段与 Bun.fetch 的 tls 扩展兼容。 */
  tls?: ProviderTlsConfig;
}

/** Anthropic 必填；extraBody / req.maxTokens 可覆盖。 */
const DEFAULT_MAX_TOKENS = 8192;

/* ------------------------------------------------------------------ */
/* 归一化 -> wire                                                      */
/* ------------------------------------------------------------------ */

export type WireBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: string }
  | { type: "thinking"; thinking: string };

export interface WireMessage {
  role: "user" | "assistant";
  content: WireBlock[];
}

export interface WireRequestParts {
  system?: { type: "text"; text: string }[];
  messages: WireMessage[];
  tools?: { name: string; description: string; input_schema: JSONSchema }[];
}

function toolResultBlock(msg: ChatMessage): WireBlock {
  const text = messageText(msg);
  const block: WireBlock = { type: "tool_result", tool_use_id: msg.toolCallId ?? "" };
  if (text.length > 0) block.content = text;
  return block;
}

/**
 * 归一化消息 -> Messages API 的 system + messages。
 *
 * 规则：
 *   - `system` / `developer` 都进顶层 system（developer 按 system 处理）；
 *   - 连续同 role 的消息合并成一条（Anthropic 要求 user/assistant 严格交替，
 *     多工具并行时 loop 会产出连续的 tool 消息）；
 *   - 空文本块直接丢弃（空 content 会被 API 拒绝）。
 */
export function toWireRequest(
  messages: ChatMessage[],
  tools: ToolSchema[] | undefined,
  reasoningReplay: ReasoningReplay = "none",
): WireRequestParts {
  const system: { type: "text"; text: string }[] = [];
  const out: WireMessage[] = [];

  const pushBlock = (role: "user" | "assistant", block: WireBlock): void => {
    const last = out[out.length - 1];
    if (last !== undefined && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = messageText(msg);
      if (text.length > 0) system.push({ type: "text", text });
      continue;
    }

    const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";

    if (msg.role === "tool") {
      pushBlock("user", toolResultBlock(msg));
      continue;
    }

    if (role === "assistant" && msg.reasoning !== undefined && msg.reasoning.length > 0 && reasoningReplay !== "none") {
      pushBlock(role, { type: "thinking", thinking: msg.reasoning });
    }

    for (const part of msg.parts) {
      if (part.type === "text") {
        if (part.text.length > 0) pushBlock(role, { type: "text", text: part.text });
      } else {
        pushBlock(role, {
          type: "image",
          source: { type: "base64", media_type: part.mime, data: part.data },
        });
      }
    }

    for (const call of msg.toolCalls ?? []) {
      pushBlock(role, {
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: typeof call.args === "string" ? JSON.parse(call.args) : (call.args ?? {}),
      });
    }
  }

  const parts: WireRequestParts = { messages: out };
  if (system.length > 0) parts.system = system;
  if (tools !== undefined && tools.length > 0) {
    // freeform 工具也必须带兼容 schema（见 ToolSchema.format 的约定），这里统一发 input_schema。
    parts.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  return parts;
}

/* ------------------------------------------------------------------ */
/* SSE 归一化                                                          */
/* ------------------------------------------------------------------ */

interface WireStreamEvent {
  type?: string;
  /** message_start */
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  /** content_block_start */
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  /** content_block_delta / message_delta 的增量；按 type 取对应字段。 */
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
    /** signature_delta 的签名；不进归一化协议，仅留位防误读。 */
    signature?: string;
    /** message_delta 的结束原因。 */
    stop_reason?: string | null;
  };
  /** message_delta */
  usage?: { output_tokens?: number };
}

export function mapStopReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      // end_turn / stop_sequence / pause_turn / refusal …
      return "stop";
  }
}

/**
 * 把一条 SSE event 映射成 0..n 个 ChatChunk。
 *
 * `toolByIndex` 跨事件携带 content_block_start 登记的 tool_use id/name，
 * 让后续 input_json_delta 能补上身份。usage 在 message_start（输入侧）与
 * message_delta（输出侧）分两次到达，发成增量由消费端 mergeUsage 累加。
 */
export function mapStreamEvent(
  event: WireStreamEvent,
  toolByIndex: Map<number, { id: string; name: string }>,
): { chunks: ChatChunk[]; finish?: FinishReason } {
  const chunks: ChatChunk[] = [];
  let finish: FinishReason | undefined;

  switch (event.type) {
    case "message_start": {
      const usage = event.message?.usage ?? {};
      const cachedCandidates = [usage.cache_read_input_tokens, usage.cache_creation_input_tokens];
      const cached = cachedCandidates.find((value) => typeof value === "number" && value > 0);
      chunks.push({
        type: "usage",
        usage: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          ...(cached !== undefined ? { cached } : {}),
        },
      });
      break;
    }
    case "content_block_start": {
      const block = event.content_block;
      if (block?.type === "tool_use" && block.id !== undefined) {
        const index = event.index ?? 0;
        const id = block.id;
        const name = block.name ?? "";
        toolByIndex.set(index, { id, name });
        chunks.push({ type: "tool_call", id, name, argsDelta: "" });
      }
      break;
    }
    case "content_block_delta": {
      const delta = event.delta;
      if (delta === undefined) break;
      if (delta.type === "text_delta") {
        if (delta.text) chunks.push({ type: "text", delta: delta.text });
      } else if (delta.type === "thinking_delta") {
        if (delta.thinking) chunks.push({ type: "reasoning", delta: delta.thinking });
      } else if (delta.type === "input_json_delta") {
        const tool = toolByIndex.get(event.index ?? 0);
        if (delta.partial_json) {
          chunks.push({
            type: "tool_call",
            id: tool?.id ?? "",
            name: "",
            argsDelta: delta.partial_json,
          });
        }
      }
      // signature_delta：签名不进归一化协议。
      break;
    }
    case "message_delta": {
      if (typeof event.usage?.output_tokens === "number" && event.usage.output_tokens > 0) {
        chunks.push({ type: "usage", usage: { input: 0, output: event.usage.output_tokens } });
      }
      if (event.delta?.stop_reason !== undefined && event.delta.stop_reason !== null) {
        finish = mapStopReason(event.delta.stop_reason);
      }
      break;
    }
    case "error": {
      // Anthropic 用 error 事件表达流内失败（如 overloaded）。
      throw new Error(`anthropic-messages stream error: ${JSON.stringify(event)}`);
    }
    default:
      break; // ping / content_block_stop / message_stop
  }

  return finish === undefined ? { chunks } : { chunks, finish };
}

/* ------------------------------------------------------------------ */
/* ModelClient 实现                                                    */
/* ------------------------------------------------------------------ */

export function createAnthropicMessagesClient(
  model: string,
  options: AnthropicMessagesOptions = {},
): ModelClient {
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
  const url = `${baseUrl}/messages`;
  const target = new URL(url);
  const loopback = isLoopbackHost(target.hostname);
  const tls = resolveTlsConfig(options.tls);

  // 与 openai-chat 相同的策略：没显式指定代理（或显式直连）时，帮本地
  // endpoint 绕过环境代理；用户明确给了代理地址就尊重用户。
  if (loopback && (options.proxy === undefined || options.proxy === false)) {
    ensureLoopbackNoProxy();
  }

  return {
    id: `anthropic-messages/${model}`,
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const wire = toWireRequest(req.messages, req.tools, options.reasoningReplay ?? "none");
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
        ...(wire.system !== undefined ? { system: wire.system } : {}),
        messages: wire.messages,
        ...(wire.tools !== undefined ? { tools: wire.tools } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(options.extraBody ?? {}),
      };

      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(options.headers ?? {}),
      };
      if (options.apiKey !== undefined) headers["x-api-key"] = options.apiKey;

      const init: FetchInit = {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        ...(options.proxy !== undefined ? { proxy: options.proxy } : {}),
        ...(tls !== undefined ? { tls } : {}),
      };
      const res = await fetch(url, init);

      if (!res.ok || res.body === null) {
        const detail = await res.text().catch(() => "");
        // 错误体来自远端服务器，进终端/转写前剥掉转义序列（BUG-027）
        const retryAfter = res.headers.get("retry-after");
        throw new Error(
          `anthropic-messages ${res.status} ${res.statusText}: ${stripAnsi(detail.slice(0, 500))}${
            retryAfter !== null ? ` (retry-after: ${retryAfter})` : ""
          }`,
        );
      }

      const toolByIndex = new Map<number, { id: string; name: string }>();
      let finish: FinishReason | undefined;

      for await (const line of readLines(res.body)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload.length === 0) continue;

        let event: WireStreamEvent;
        try {
          event = JSON.parse(payload) as WireStreamEvent;
        } catch {
          continue; // 忽略半截/心跳等非 JSON 行
        }

        const mapped = mapStreamEvent(event, toolByIndex);
        for (const chunk of mapped.chunks) yield chunk;
        if (mapped.finish !== undefined) finish = mapped.finish;
      }

      const resolved: FinishReason = finish ?? (toolByIndex.size > 0 ? "tool_calls" : "stop");
      yield { type: "done", reason: resolved };
    },
  };
}
