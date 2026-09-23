/**
 * openai-chat adapter —— 对接 OpenAI `/chat/completions` 及其兼容实现
 * （DeepSeek / Moonshot / 通义 / Ollama / llama.cpp / vLLM / OpenRouter …）。
 *
 * 本文件是**唯一**知道 wire format 的地方。它把 SSE 流归一化成 ChatChunk。
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

export interface OpenAIChatOptions {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** 额外塞进 body 的字段（如 `{"reasoning_effort":"high"}`）。 */
  extraBody?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 归一化 -> wire                                                      */
/* ------------------------------------------------------------------ */

type WireContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface WireMessage {
  role: string;
  content: string | WireContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toWireContent(msg: ChatMessage): string | WireContentPart[] | null {
  const onlyText = msg.parts.every((p) => p.type === "text");
  if (onlyText) {
    const text = messageText(msg);
    return text.length > 0 ? text : null;
  }
  const parts: WireContentPart[] = [];
  for (const part of msg.parts) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    else parts.push({ type: "image_url", image_url: { url: `data:${part.mime};base64,${part.data}` } });
  }
  return parts;
}

export function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  return messages.map((msg) => {
    const content = toWireContent(msg);
    const out: WireMessage = { role: msg.role, content };

    if (msg.toolCallId !== undefined) out.tool_call_id = msg.toolCallId;

    if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
      out.tool_calls = msg.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {}),
        },
      }));
    }
    return out;
  });
}

export function toWireTools(tools: ToolSchema[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/* ------------------------------------------------------------------ */
/* SSE 解析                                                            */
/* ------------------------------------------------------------------ */

async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        yield buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

function mapFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "stop":
    case "end_turn":
      return "stop";
    default:
      return "stop";
  }
}

/* ------------------------------------------------------------------ */
/* wire -> 归一化                                                      */
/* ------------------------------------------------------------------ */

interface WireToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireStreamEvent {
  choices?: {
    index?: number;
    delta?: {
      content?: string | null;
      /** DeepSeek / 部分国产模型的思考链路字段。 */
      reasoning_content?: string | null;
      /** 另一派命名（OpenRouter / 部分网关）。 */
      reasoning?: string | null;
      tool_calls?: WireToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

/**
 * 把一条 SSE event 映射成 0..n 个 ChatChunk。
 * tool call 在 OpenAI 流里是按 index 分片到达的，这里负责把 id/name 补齐。
 */
export function mapStreamEvent(
  event: WireStreamEvent,
  toolIdByIndex: Map<number, string>,
): { chunks: ChatChunk[]; finish?: FinishReason } {
  const chunks: ChatChunk[] = [];
  let finish: FinishReason | undefined;

  for (const choice of event.choices ?? []) {
    const delta = choice.delta;

    // 思考链路：两种命名都认，且优先于 content（有些模型两者同时发）
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (reasoning) chunks.push({ type: "reasoning", delta: reasoning });

    if (delta?.content) chunks.push({ type: "text", delta: delta.content });

    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      let id = toolIdByIndex.get(index);
      if (id === undefined) {
        id = call.id ?? `call_${index}`;
        toolIdByIndex.set(index, id);
      }
      chunks.push({
        type: "tool_call",
        id,
        name: call.function?.name ?? "",
        argsDelta: call.function?.arguments ?? "",
      });
    }

    if (choice.finish_reason) finish = mapFinishReason(choice.finish_reason);
  }

  if (event.usage) {
    const usage: ChatChunk = {
      type: "usage",
      usage: {
        input: event.usage.prompt_tokens ?? 0,
        output: event.usage.completion_tokens ?? 0,
        ...(event.usage.prompt_tokens_details?.cached_tokens !== undefined
          ? { cached: event.usage.prompt_tokens_details.cached_tokens }
          : {}),
      },
    };
    chunks.push(usage);
  }

  return finish === undefined ? { chunks } : { chunks, finish };
}

/* ------------------------------------------------------------------ */
/* ModelClient 实现                                                    */
/* ------------------------------------------------------------------ */

export function createOpenAIChatClient(model: string, options: OpenAIChatOptions = {}): ModelClient {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  return {
    id: `openai-chat/${model}`,
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: toWireMessages(req.messages),
        stream: true,
        stream_options: { include_usage: true },
        ...(options.extraBody ?? {}),
      };
      if (req.tools !== undefined && req.tools.length > 0) body.tools = toWireTools(req.tools);
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(options.headers ?? {}),
      };
      if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });

      if (!res.ok || res.body === null) {
        const detail = await res.text().catch(() => "");
        throw new Error(`openai-chat ${res.status} ${res.statusText}: ${detail.slice(0, 500)}`);
      }

      const toolIdByIndex = new Map<number, string>();
      let finish: FinishReason | undefined;

      for await (const line of readLines(res.body)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload.length === 0) continue;
        if (payload === "[DONE]") break;

        let event: WireStreamEvent;
        try {
          event = JSON.parse(payload) as WireStreamEvent;
        } catch {
          continue; // 忽略半截/心跳等非 JSON 行
        }

        const mapped = mapStreamEvent(event, toolIdByIndex);
        for (const chunk of mapped.chunks) yield chunk;
        if (mapped.finish !== undefined) finish = mapped.finish;
      }

      const resolved: FinishReason = finish ?? (toolIdByIndex.size > 0 ? "tool_calls" : "stop");
      yield { type: "done", reason: resolved };
    },
  };
}
