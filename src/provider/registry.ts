/**
 * ProviderRegistry —— 把 config 里的 `{ provider, model }` 解析成 ModelClient。
 *
 * loop 永远只拿到 ModelClient；它既不知道 provider 是谁，也不知道 endpoint 是什么类型。
 * 这就是 Phase 1 要的隔离。
 */

import type { ChatChunk, ModelClient } from "./types.ts";
import {
  createOpenAIChatClient,
  type OpenAIChatOptions,
  type ProviderProxy,
  type ProviderTlsConfig,
  type ReasoningReplay,
} from "./adapters/openai-chat.ts";
import { createMockClient, type MockTurn } from "./adapters/mock.ts";

/** 读一个"正整数"环境变量；缺失 / 非数字 / ≤0 一律当没配。 */
function positiveIntEnv(name: string): number {
  const raw = Number(Bun.env[name] ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * mock 的脚本。
 *
 * 默认：把最后一条 user 消息原样回显，够用来验证链路。
 *
 * `BUGENT_MOCK_TOOL_CALL`（JSON：`{"name":"todo_write","args":{…}}`）会让它先在
 * 第一轮发一次工具调用，之后照旧回显 —— 否则"内容由工具产出"的界面（待办面板、
 * 工具卡片）在端到端测试里造不出来，只能靠真实模型碰运气。工具名由调用方给，
 * provider 层因此仍然不认识任何具体工具。
 */
function mockScript(): MockTurn[] {
  // 流式模拟：把回复切成小块并逐块延迟吐字，让 TUI 的增量渲染可被观测。
  // 只在测试里用 env 打开，默认保持"一次性吐完"的原行为。
  const chunkChars = positiveIntEnv("BUGENT_MOCK_CHUNK_CHARS");

  const echo: MockTurn = (req) => {
    const last = [...req.messages].reverse().find((message) => message.role === "user");
    const text = last?.parts.map((part) => (part.type === "text" ? part.text : "")).join("") ?? "";
    const full = `[mock] ${text}`;
    const deltas =
      chunkChars === 0
        ? [full]
        : Array.from({ length: Math.ceil(full.length / chunkChars) }, (_, index) =>
            full.slice(index * chunkChars, (index + 1) * chunkChars),
          );
    return [
      ...deltas.map((delta): ChatChunk => ({ type: "text", delta })),
      { type: "done", reason: "stop" },
    ];
  };

  const raw = Bun.env.BUGENT_MOCK_TOOL_CALL;
  if (raw === undefined || raw.trim().length === 0) return [echo];

  const parsed = JSON.parse(raw) as { name?: unknown; args?: unknown };
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new Error('BUGENT_MOCK_TOOL_CALL 需要形如 {"name":"todo_write","args":{…}} 的 JSON');
  }
  return [
    { toolCalls: [{ id: "mock-tool-call-1", name: parsed.name, args: parsed.args ?? {} }] },
    echo,
  ];
}

export type EndpointKind =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "mock";

export interface ProviderConfig {
  id: string;
  endpoint: EndpointKind;
  /** 允许显式 undefined：配置通常直接来自 process.env。 */
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  extraBody?: Record<string, unknown> | undefined;
  /** 显式代理；false 表示不走代理。 */
  proxy?: ProviderProxy | undefined;
  /** TLS 配置；字段与 Bun.fetch 的 tls 扩展兼容。 */
  tls?: ProviderTlsConfig | undefined;
  /** assistant reasoning 回放的 wire 字段策略。 */
  reasoningReplay?: ReasoningReplay | undefined;
}

/** 可以安全写入 session 记录的 provider 配置；API key 永远不在其中。 */
export type PersistedProviderConfig = Omit<ProviderConfig, "apiKey">;

export interface ModelRef {
  provider: string;
  model: string;
}

type AdapterFactory = (config: ProviderConfig, model: string) => ModelClient;

const FACTORIES: Record<EndpointKind, AdapterFactory> = {
  "openai-chat": (config, model) => {
    const options: OpenAIChatOptions = {};
    if (config.baseUrl !== undefined) options.baseUrl = config.baseUrl;
    if (config.apiKey !== undefined) options.apiKey = config.apiKey;
    if (config.headers !== undefined) options.headers = config.headers;
    if (config.extraBody !== undefined) options.extraBody = config.extraBody;
    if (config.proxy !== undefined) options.proxy = config.proxy;
    if (config.tls !== undefined) options.tls = config.tls;
    if (config.reasoningReplay !== undefined) options.reasoningReplay = config.reasoningReplay;
    return createOpenAIChatClient(model, options);
  },

  mock: (config, model) => {
    // 只有测试会设这个：让分块之间真的隔开时间，才能观察到逐帧增长。
    const chunkDelayMs = positiveIntEnv("BUGENT_MOCK_CHUNK_DELAY_MS");
    return createMockClient({
      id: `${config.id}/mock/${model}`,
      script: mockScript(),
      ...(chunkDelayMs > 0 ? { chunkDelayMs } : {}),
    });
  },

  "openai-responses": (_config, model) => {
    throw new Error(`endpoint "openai-responses" 尚未实现（model=${model}）`);
  },

  "anthropic-messages": (_config, model) => {
    throw new Error(`endpoint "anthropic-messages" 尚未实现（model=${model}）`);
  },
};

/** 解析 `"provider/model"`。model 里含 `/` 时按第一个 `/` 切分。 */
export function parseModelRef(spec: string): ModelRef {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`model 标识格式应为 "provider/model"，收到：${JSON.stringify(spec)}`);
  }
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

export class ProviderRegistry {
  #providers = new Map<string, ProviderConfig>();

  register(config: ProviderConfig): this {
    this.#providers.set(config.id, config);
    return this;
  }

  get(id: string): ProviderConfig | undefined {
    return this.#providers.get(id);
  }

  list(): ProviderConfig[] {
    return [...this.#providers.values()];
  }

  /**
   * 核心方法：`{provider, model}` -> ModelClient。
   *
   * `overrides` 用于 session 级覆盖（例如当前会话临时换 API key），
   * 不修改 registry 里的共享 provider 配置。
   */
  resolve(ref: ModelRef, overrides: Partial<ProviderConfig> = {}): ModelClient {
    const base = this.#providers.get(ref.provider);
    if (base === undefined && overrides.endpoint === undefined) {
      const known = this.list().map((p) => p.id).join(", ") || "(空)";
      throw new Error(`未知 provider "${ref.provider}"，已注册：${known}`);
    }
    const config: ProviderConfig =
      base === undefined
        ? { ...overrides, id: ref.provider, endpoint: overrides.endpoint! }
        : { ...base, ...overrides, id: base.id };
    return FACTORIES[config.endpoint](config, ref.model);
  }

  resolveSpec(spec: string): ModelClient {
    return this.resolve(parseModelRef(spec));
  }
}
