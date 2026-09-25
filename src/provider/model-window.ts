/**
 * 模型上下文窗口的**兜底表**。
 *
 * 上下文占用要显示成 `24.1k/128k 19%` 就得知道分母，而 OpenAI 兼容协议里
 * 没有任何字段回传上下文窗口 —— 只能配置或内置。
 *
 * 优先级：
 *   1. `config.toml` 的 `[[providers]] context_window`（用户说了算）
 *   2. `GET {baseUrl}/models` 里服务端自报的窗口（最准，见 `probeContextWindow`）
 *   3. 这张内置表（按模型名前缀匹配，来源见下表注释）
 *   4. 都没有 → undefined，UI 只显示绝对占用，**不编百分比**
 *
 * 表里的数字来自 workbuddy-proxy 内置的 intl 模型表（官方 CLI product.json 的
 * maxInputTokens）与各厂公开文档；它只是"没配时的合理默认值"，不是权威值。
 */

const WINDOWS: readonly (readonly [RegExp, number])[] = [
  [/^gpt-5\.5/, 1_000_000],
  [/^gpt-5/, 272_000],
  [/^gemini-3\.5-flash/, 1_000_000],
  [/^gemini-/, 400_000],
  // DeepSeek V3.1 之后公开口径是 128k；具体部署（如 volc 的 v3.2）可能是 96k，
  // 那种情况请在 config.toml 里显式写 context_window。
  [/^deepseek/, 128_000],
  [/^glm/, 200_000],
  [/^kimi/, 164_000],
];

export function defaultContextWindow(model: string): number | undefined {
  const id = model.trim().toLowerCase();
  for (const [pattern, window] of WINDOWS) {
    if (pattern.test(id)) return window;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 从 /v1/models 探测                                                  */
/* ------------------------------------------------------------------ */

/**
 * 不同实现给上下文窗口起的字段名（按出现频率排序）。
 * OpenAI 官方没有这个字段，但兼容实现普遍加了。
 */
const WINDOW_FIELDS = [
  "context_length",
  "context_window",
  "max_input_tokens",
  "max_model_len",
  "max_context_length",
] as const;

function readWindow(entry: Record<string, unknown>): number | undefined {
  for (const field of WINDOW_FIELDS) {
    const value = entry[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

export interface ContextWindowProbeOptions {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  /** 探测是"锦上添花"，超时默认压得很短（2s），失败一律当没探到。 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 问一次 `GET {baseUrl}/models`，看服务端有没有报这个模型的上下文窗口。
 *
 * 为什么值得多这一跳：窗口大小直接决定状态栏那个百分比对不对 —— 本地
 * workbuddy 网关就报 `deepseek-v4.1-flash = 1_000_000`，而任何内置兜底表
 * 都只能按模型名猜。探测失败/字段缺失就返回 undefined，交给配置与兜底表。
 */
export async function probeContextWindow(
  options: ContextWindowProbeOptions,
): Promise<number | undefined> {
  const base = options.baseUrl.replace(/\/+$/, "");
  if (base.length === 0) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2000);
  try {
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(`${base}/models`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(options.apiKey !== undefined && options.apiKey.length > 0
          ? { authorization: `Bearer ${options.apiKey}` }
          : {}),
        ...(options.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as unknown;
    if (body === null || typeof body !== "object") return undefined;
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) return undefined;
    for (const entry of data) {
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (record.id !== options.model) continue;
      return readWindow(record);
    }
    return undefined;
  } catch {
    // 网络失败 / 超时 / JSON 不是 JSON：都只是"没探到"
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
