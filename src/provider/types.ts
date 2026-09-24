/**
 * ★ 归一化协议层 —— Phase 1 的核心契约
 *
 * 规则（不可违反）：
 *   1. 本文件只依赖标准 TS 类型，不 import 任何 adapter / SDK / 网络库。
 *   2. agent loop、session、context 只允许 import 本文件来跟"模型"打交道。
 *   3. 新增一个 provider = 新增一个 adapter 文件，本文件保持不变。
 *
 * 这样 loop 对 endpoint 类型（openai-chat / openai-responses / anthropic-messages …）
 * 完全无感，这是 Phase 1 的验收标准。
 */

export type Role = "system" | "developer" | "user" | "assistant" | "tool";

/** 消息内容的原子单元。多模态以后加 `audio` / `file` 只需扩展这个 union。 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string };

/** 模型请求调用某个工具。`args` 是解析后的对象，不是 JSON 字符串。 */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** 归一化消息：adapter 负责把它翻译成各家 wire format。 */
export interface ChatMessage {
  role: Role;
  parts: ContentPart[];
  /** assistant 的思考链路，供需要 reasoning replay 的 provider 回放。 */
  reasoning?: string;
  /** role === "tool" 时必填，指向被回应的 tool call id。 */
  toolCallId?: string;
  /** role === "assistant" 且本轮要求调用工具时存在。 */
  toolCalls?: ToolCall[];
}

export type JSONSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

/** 够用的 JSON Schema 子集。`type` 可省略（如 `{}` 表示任意值）。 */
export interface JSONSchema {
  type?: JSONSchemaType;
  properties?: Record<string, JSONSchema>;
  required?: readonly string[];
  items?: JSONSchema;
  enum?: readonly unknown[];
  description?: string;
  default?: unknown;
  [key: string]: unknown;
}

export type ToolInputFormat = "json" | "freeform";

export interface ToolSchema {
  name: string;
  description: string;
  /**
   * OpenAI Chat Completions 只支持 JSON function arguments，因此 freeform
   * 工具仍必须携带一个兼容 schema；支持 custom tools 的 adapter 可以读取
   * `format` 并发送真正的自由文本格式。
   */
  parameters: JSONSchema;
  format?: ToolInputFormat;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "error";

export interface Usage {
  input: number;
  output: number;
  /** 命中 provider 前缀缓存的 token 数（能拿到时才有）。 */
  cached?: number;
}

/** 流式增量。adapter 必须把各家流式格式归一到这几种。 */
export type ChatChunk =
  | { type: "text"; delta: string }
  /**
   * 思考链路增量（DeepSeek 的 reasoning_content、部分模型的 reasoning）。
   *
   * 它不直接作为普通正文展示；是否回放给 provider 由 adapter / 配置决定。
   * 需要 replay 的模型会把最终 reasoning 挂回 assistant 消息。
   */
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; id: string; name: string; argsDelta: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; reason: FinishReason };

/**
 * loop 眼里的"模型"就长这样。任何 provider 只要实现它就能插进来。
 * `id` 形如 `openai/openai-chat/gpt-4o`，仅用于日志与 UI 展示。
 */
export interface ModelClient {
  readonly id: string;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
}

/* ------------------------------------------------------------------ */
/* 小工具：构造与提取                                                   */
/* ------------------------------------------------------------------ */

export function textPart(text: string): ContentPart {
  return { type: "text", text };
}

export function textMessage(role: Role, text: string): ChatMessage {
  return { role, parts: [textPart(text)] };
}

/** 取出消息里所有文本片段拼接。 */
export function messageText(msg: ChatMessage): string {
  let out = "";
  for (const part of msg.parts) {
    if (part.type === "text") out += part.text;
  }
  return out;
}

/** 判断一条消息是否"有内容"（空 assistant 消息在多数 provider 上会被拒）。 */
export function hasContent(msg: ChatMessage): boolean {
  return msg.parts.length > 0 || (msg.toolCalls?.length ?? 0) > 0;
}
