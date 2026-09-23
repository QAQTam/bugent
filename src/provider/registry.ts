/**
 * ProviderRegistry —— 把 config 里的 `{ provider, model }` 解析成 ModelClient。
 *
 * loop 永远只拿到 ModelClient；它既不知道 provider 是谁，也不知道 endpoint 是什么类型。
 * 这就是 Phase 1 要的隔离。
 */

import type { ModelClient } from "./types.ts";
import {
  createOpenAIChatClient,
  type OpenAIChatOptions,
  type ProviderProxy,
  type ProviderTlsConfig,
} from "./adapters/openai-chat.ts";
import { createMockClient } from "./adapters/mock.ts";

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
}

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
    return createOpenAIChatClient(model, options);
  },

  mock: (config, model) =>
    createMockClient({
      id: `${config.id}/mock/${model}`,
      // 默认 mock：把最后一条 user 消息原样回显，够用来验证链路。
      script: [
        (req) => {
          const last = [...req.messages].reverse().find((m) => m.role === "user");
          const text = last?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
          return [
            { type: "text", delta: `[mock] ${text}` },
            { type: "done", reason: "stop" },
          ];
        },
      ],
    }),

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

  /** 核心方法：`{provider, model}` -> ModelClient。 */
  resolve(ref: ModelRef): ModelClient {
    const config = this.#providers.get(ref.provider);
    if (config === undefined) {
      const known = this.list().map((p) => p.id).join(", ") || "(空)";
      throw new Error(`未知 provider "${ref.provider}"，已注册：${known}`);
    }
    return FACTORIES[config.endpoint](config, ref.model);
  }

  resolveSpec(spec: string): ModelClient {
    return this.resolve(parseModelRef(spec));
  }
}
