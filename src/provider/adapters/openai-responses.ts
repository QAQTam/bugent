/**
 * openai-responses adapter —— 对接 OpenAI `/v1/responses`（Responses API）。
 *
 * 本文件是 wire format 的唯一归属地。它把归一化 ChatMessage 翻译成 Responses
 * 的 instructions + input items 结构，把 SSE 流归一化成 ChatChunk。
 *
 * 与 openai-chat 的主要差异：
 *   - system/developer 是顶层 `instructions` 参数，不是消息；
 *   - 工具调用与结果是**平铺的 input items**（function_call / function_call_output），
 *     不要求 user/assistant 交替 —— 连续多条 tool 输出原样平铺即可；
 *   - freeform 工具（ToolSchema.format === "freeform"）在这里**首次兑现**为
 *     custom tool（`{type: "custom"}`）：模型按自由文本回参，不再强制 JSON schema；
 *   - 流式按 output_item 分块（output_text.delta / reasoning_summary_text.delta /
 *     function_call_arguments.delta）。
 *
 * reasoning replay：v0 忽略。Responses 的 reasoning item 内容不透明（官方以
 * encrypted/摘要形态回放），把归一化历史里的 reasoning 文本塞回去没有稳定 wire
 * 形态 —— 需要回放的网关应走 openai-chat / anthropic-messages。
 */

import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  FinishReason,
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

export interface OpenAIResponsesOptions {
  /** 形如 `https://api.openai.com/v1`；自动拼 `/responses`。 */
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** 额外塞进 body 的字段（如 `{"reasoning":{"effort":"low"}}`）。 */
  extraBody?: Record<string, unknown>;
  /**
   * assistant 历史里 reasoning 的回放策略。类型上与其它 adapter 保持一致，
   * 但本 adapter v0 忽略该值（见文件头注释）。
   */
  reasoningReplay?: ReasoningReplay;
  /** 显式代理；false 表示直连。 */
  proxy?: ProviderProxy;
  /** TLS 配置；字段与 Bun.fetch 的 tls 扩展兼容。 */
  tls?: ProviderTlsConfig;
}

/** Responses 用 max_output_tokens；缺省兜底与 anthropic-messages 对齐。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/* ------------------------------------------------------------------ */
/* 归一化 -> wire                                                      */
/* ------------------------------------------------------------------ */

export type WireInputItem =
  | { type: "message"; role: "user" | "assistant"; content: WireContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "custom_tool_call"; call_id: string; name: string; input: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "custom_tool_call_output"; call_id: string; output: string };

export type WireContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

export type WireTool =
  | { type: "function"; name: string; description: string; parameters: ToolSchema["parameters"]; strict: false }
  | { type: "custom"; name: string; description: string; format?: { type: "text" } };

export interface WireRequestParts {
  instructions?: string;
  input: WireInputItem[];
  tools?: WireTool[];
}

function stringifyArgs(args: unknown): string {
  if (typeof args === "string") return args;
  return JSON.stringify(args ?? {});
}

/**
 * 归一化消息 -> Responses 的 instructions + input items。
 *
 * 规则：
 *   - `system` / `developer` 都进顶层 instructions（developer 按 system 处理）；
 *   - tool 输出是独立的平铺 item；custom 工具的调用按名字查 freeform 工具集判定，
 *     以 `custom_tool_call_output` 回传（两种 output 的 item type 不能混用）；
 *   - 空文本段跳过（与 anthropic-messages 一致）。
 */
export function toWireRequest(
  messages: ChatMessage[],
  tools: ToolSchema[] | undefined,
  _reasoningReplay: ReasoningReplay = "none",
): WireRequestParts {
  const instructions: string[] = [];
  const input: WireInputItem[] = [];
  // call_id -> 是否 custom 调用：由 assistant 消息里的 toolCalls 按名字判定
  const customCalls = new Set<string>();
  const freeformNames = new Set(
    (tools ?? []).filter((tool) => tool.format === "freeform").map((tool) => tool.name),
  );

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = messageText(msg);
      if (text.length > 0) instructions.push(text);
      continue;
    }

    if (msg.role === "tool") {
      const callId = msg.toolCallId ?? "";
      const output = messageText(msg);
      if (customCalls.has(callId)) {
        input.push({ type: "custom_tool_call_output", call_id: callId, output });
      } else {
        input.push({ type: "function_call_output", call_id: callId, output });
      }
      continue;
    }

    if (msg.role === "assistant" && (msg.toolCalls?.length ?? 0) > 0) {
      for (const call of msg.toolCalls ?? []) {
        if (freeformNames.has(call.name)) customCalls.add(call.id);
        if (customCalls.has(call.id)) {
          input.push({
            type: "custom_tool_call",
            call_id: call.id,
            name: call.name,
            input: stringifyArgs(call.args),
          });
        } else {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: stringifyArgs(call.args),
          });
        }
      }
    }

    const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
    const content: WireContentPart[] = [];
    for (const part of msg.parts) {
      if (part.type === "text") {
        if (part.text.length === 0) continue;
        content.push(
          role === "assistant"
            ? { type: "output_text", text: part.text }
            : { type: "input_text", text: part.text },
        );
      } else {
        content.push({
          type: "input_image",
          image_url: `data:${part.mime};base64,${part.data}`,
        });
      }
    }
    if (content.length > 0) input.push({ type: "message", role, content });
  }

  const parts: WireRequestParts = { input };
  if (instructions.length > 0) parts.instructions = instructions.join("\n\n");
  if (tools !== undefined && tools.length > 0) {
    parts.tools = tools.map((tool) =>
      tool.format === "freeform"
        ? { type: "custom" as const, name: tool.name, description: tool.description, format: { type: "text" as const } }
        : {
            type: "function" as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: false as const,
          },
    );
  }
  return parts;
}

/* ------------------------------------------------------------------ */
/* SSE 归一化                                                          */
/* ------------------------------------------------------------------ */

interface WireStreamEvent {
  type?: string;
  /** output_item.added / output_item.done */
  output_index?: number;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    input?: string;
  };
  /** *.delta 事件的增量载荷 */
  delta?: string;
  item_id?: string;
  /** response.completed / response.failed / response.incomplete */
  response?: {
    status?: string;
    incomplete_details?: { reason?: string };
    error?: { message?: string } | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_token_details?: { cached_tokens?: number };
      output_token_details?: { reasoning_tokens?: number };
    };
  };
}

/** 流内工具调用的身份（item_id/output_index -> call_id + name）。 */
export type ToolIdentity = Map<string, { id: string; name: string }>;

function identityKey(event: WireStreamEvent): string {
  return event.item_id ?? String(event.output_index ?? 0);
}

export function mapStreamEvent(
  event: WireStreamEvent,
  toolIdentity: ToolIdentity,
): { chunks: ChatChunk[]; finish?: FinishReason } {
  const chunks: ChatChunk[] = [];
  let finish: FinishReason | undefined;

  switch (event.type) {
    case "response.output_item.added": {
      const item = event.item;
      if (item === undefined) break;
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        const id = item.call_id ?? item.id ?? "";
        const name = item.name ?? "";
        const key = identityKey(event);
        toolIdentity.set(key, { id, name });
        // delta 事件带的是 item_id（即 item.id），added 事件只有 output_index ——
        // 两个 key 都登记，后续查找才不会 miss。
        if (item.id !== undefined && item.id !== key) {
          toolIdentity.set(item.id, { id, name });
        }
        // 身份先行（与 anthropic 的 content_block_start 同型）：deltas 靠它归属。
        chunks.push({ type: "tool_call", id, name, argsDelta: "" });
      }
      break;
    }
    case "response.output_text.delta": {
      if (event.delta) chunks.push({ type: "text", delta: event.delta });
      break;
    }
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      if (event.delta) chunks.push({ type: "reasoning", delta: event.delta });
      break;
    }
    case "response.function_call_arguments.delta":
    case "response.custom_tool_call_input.delta": {
      if (!event.delta) break;
      const tool = toolIdentity.get(identityKey(event));
      chunks.push({ type: "tool_call", id: tool?.id ?? "", name: "", argsDelta: event.delta });
      break;
    }
    case "response.completed":
    case "response.incomplete": {
      const response = event.response ?? {};
      const usage = response.usage ?? {};
      const cached = usage.input_token_details?.cached_tokens;
      const reasoning = usage.output_token_details?.reasoning_tokens;
      chunks.push({
        type: "usage",
        usage: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          ...(typeof cached === "number" && cached > 0 ? { cached } : {}),
          ...(typeof reasoning === "number" && reasoning > 0 ? { reasoning } : {}),
        },
      });
      if (
        response.status === "incomplete" ||
        response.incomplete_details?.reason === "max_output_tokens"
      ) {
        finish = "length";
      }
      break;
    }
    case "response.failed":
    case "response.error":
    case "error": {
      const detail = event.response?.error?.message ?? JSON.stringify(event);
      throw new Error(`openai-responses stream error: ${stripAnsi(detail.slice(0, 500))}`);
    }
    default:
      break; // ping / output_item.done（deltas 已拼完整）/ response.created 等
  }

  return finish === undefined ? { chunks } : { chunks, finish };
}

/* ------------------------------------------------------------------ */
/* ModelClient 实现                                                    */
/* ------------------------------------------------------------------ */

export function createOpenAIResponsesClient(
  model: string,
  options: OpenAIResponsesOptions = {},
): ModelClient {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = `${baseUrl}/responses`;
  const target = new URL(url);
  const loopback = isLoopbackHost(target.hostname);
  const tls = resolveTlsConfig(options.tls);

  // 与 openai-chat / anthropic-messages 相同的策略：没显式指定代理（或显式
  // 直连）时，帮本地 endpoint 绕过环境代理；用户明确给了代理地址就尊重用户。
  if (loopback && (options.proxy === undefined || options.proxy === false)) {
    ensureLoopbackNoProxy();
  }

  return {
    id: `openai-responses/${model}`,
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const wire = toWireRequest(req.messages, req.tools, options.reasoningReplay ?? "none");
      const body: Record<string, unknown> = {
        model: req.model,
        input: wire.input,
        max_output_tokens: req.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        stream: true,
        // 会话历史由调用方全量携带，服务端不需要保存（也避免关联存储策略）。
        store: false,
        ...(wire.instructions !== undefined ? { instructions: wire.instructions } : {}),
        ...(wire.tools !== undefined ? { tools: wire.tools } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(options.extraBody ?? {}),
      };

      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
        ...(options.headers ?? {}),
      };

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
          `openai-responses ${res.status} ${res.statusText}: ${stripAnsi(detail.slice(0, 500))}${
            retryAfter !== null ? ` (retry-after: ${retryAfter})` : ""
          }`,
        );
      }

      const toolIdentity: ToolIdentity = new Map();
      let sawToolCall = false;
      let finish: FinishReason | undefined;

      for await (const line of readLines(res.body)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload.length === 0 || payload === "[DONE]") continue;

        let event: WireStreamEvent;
        try {
          event = JSON.parse(payload) as WireStreamEvent;
        } catch {
          continue; // 忽略半截/心跳等非 JSON 行
        }

        const mapped = mapStreamEvent(event, toolIdentity);
        for (const chunk of mapped.chunks) {
          if (chunk.type === "tool_call") sawToolCall = true;
          yield chunk;
        }
        if (mapped.finish !== undefined) finish = mapped.finish;
      }

      const resolved: FinishReason = finish ?? (sawToolCall ? "tool_calls" : "stop");
      yield { type: "done", reason: resolved };
    },
  };
}
