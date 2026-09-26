/**
 * Provider profile 导入/导出 —— 面向未来 WebUI 的版本化文档。
 *
 * 安全边界：
 *   - 永不导出 apiKey；
 *   - 不导出内联 TLS ca/cert/key/passphrase；
 *   - TLS 只导出 *File 路径和安全的 serverName / rejectUnauthorized。
 */

import type {
  EndpointKind,
  PersistedProviderConfig,
} from "../provider/registry.ts";
import type { ReasoningReplay } from "../provider/adapters/openai-chat.ts";
import type { SessionStore } from "../store/repository.ts";

export const PROVIDER_PROFILE_SCHEMA = "bugent.provider-profiles";
export const PROVIDER_PROFILE_VERSION = 1;

export interface ProviderTlsProfile {
  rejectUnauthorized?: boolean;
  serverName?: string;
  caFile?: string;
  certFile?: string;
  keyFile?: string;
}

export interface ProviderProfileExport {
  id: string;
  endpoint: EndpointKind;
  baseUrl?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  reasoningReplay?: ReasoningReplay;
  /** 上下文窗口（token）；非敏感，可随 profile 导出。 */
  contextWindow?: number;
  proxy?: string | false;
  tls?: ProviderTlsProfile;
}

export interface ProviderProfileDocumentV1 {
  schema: typeof PROVIDER_PROFILE_SCHEMA;
  version: typeof PROVIDER_PROFILE_VERSION;
  exportedAt: string;
  providers: ProviderProfileExport[];
}

export type ImportConflictStrategy = "skip" | "overwrite" | "rename";

export interface ImportProviderProfilesOptions {
  conflict?: ImportConflictStrategy;
  dryRun?: boolean;
  now?: () => Date;
}

export interface ImportProviderProfilesResult {
  imported: string[];
  skipped: string[];
  renamed: Record<string, string>;
  errors: { providerId?: string; message: string }[];
}

function exportTls(tls: PersistedProviderConfig["tls"]): ProviderTlsProfile | undefined {
  if (tls === undefined) return undefined;
  const safe: ProviderTlsProfile = {
    ...(tls.rejectUnauthorized !== undefined
      ? { rejectUnauthorized: tls.rejectUnauthorized }
      : {}),
    ...(tls.serverName !== undefined ? { serverName: tls.serverName } : {}),
    ...(tls.caFile !== undefined ? { caFile: tls.caFile } : {}),
    ...(tls.certFile !== undefined ? { certFile: tls.certFile } : {}),
    ...(tls.keyFile !== undefined ? { keyFile: tls.keyFile } : {}),
  };
  return Object.keys(safe).length > 0 ? safe : undefined;
}

/**
 * 导出侧的密钥脱敏（BUG-013）。
 *
 * "永不导出 apiKey" 的不变量过去只挡了 `apiKey` 字段本身 —— 用户完全可能把
 * 密钥放进 `headers.Authorization`、`proxy` 的 userinfo 或 `extra_body` 里
 * （网关鉴权就是这么接的）。导出文档是设计来分享/外发的，这三个通道必须
 * 一并处理：
 *   - headers：鉴权类键（authorization / cookie / *api*key* / token / secret）
 *     的值替换为 "__REDACTED__"，其余键原样保留；
 *   - proxy：剥掉 userinfo（http://user:pass@host → http://host）；
 *   - extraBody：深度遍历，字符串值命中密钥形态（sk-… / Bearer … / 长十六进制
 *     / base64 形态的赋值）时整体替换为 "__REDACTED__"。
 */

const REDACTED = "__REDACTED__";

const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|.*api[-_]?key.*|.*token.*|.*secret.*)$/i;

const SECRET_LIKE_RE =
  /(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2})/;

/** extraBody 里"这个字段名就是密钥位"的形态：值是字符串就直接脱敏。 */
const SENSITIVE_FIELD_RE = /(api[-_]?key|token|secret|password|passwd|authorization)/i;

function redactHeaderValue(key: string, value: string): string {
  return SENSITIVE_HEADER_RE.test(key.trim()) ? REDACTED : value;
}

function redactProxy(proxy: string): string {
  // 只剥 userinfo，保留 scheme/host/port
  return proxy.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1");
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return SECRET_LIKE_RE.test(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === "string" && SENSITIVE_FIELD_RE.test(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactDeep(item);
    }
    return out;
  }
  return value;
}

function exportProvider(config: PersistedProviderConfig): ProviderProfileExport {
  const tls = exportTls(config.tls);
  const headers = config.headers
    ? Object.fromEntries(
        Object.entries(config.headers).map(([key, value]) => [key, redactHeaderValue(key, value)]),
      )
    : undefined;
  const proxy =
    typeof config.proxy === "string" ? redactProxy(config.proxy) : config.proxy;
  return {
    id: config.id,
    endpoint: config.endpoint,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(config.extraBody !== undefined
      ? { extraBody: redactDeep(config.extraBody) as Record<string, unknown> }
      : {}),
    ...(config.reasoningReplay !== undefined
      ? { reasoningReplay: config.reasoningReplay }
      : {}),
    ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(tls !== undefined ? { tls } : {}),
  };
}

export function exportProviderProfiles(
  store: SessionStore,
  sessionId: string,
  options: { now?: () => Date } = {},
): ProviderProfileDocumentV1 {
  return {
    schema: PROVIDER_PROFILE_SCHEMA,
    version: PROVIDER_PROFILE_VERSION,
    exportedAt: (options.now?.() ?? new Date()).toISOString(),
    providers: store.listProviderConfigs(sessionId).map(exportProvider),
  };
}

export function serializeProviderProfiles(document: ProviderProfileDocumentV1): string {
  return JSON.stringify(document, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateStringRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${label} 必须是 object`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`${label}.${key} 必须是字符串`);
    out[key] = entry;
  }
  return out;
}

const ENDPOINTS: readonly EndpointKind[] = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "mock",
];

const REASONING_REPLAY: readonly ReasoningReplay[] = [
  "none",
  "reasoning",
  "reasoning_content",
  "both",
];

function validateProvider(raw: unknown, index: number): ProviderProfileExport {
  const label = `providers[${index}]`;
  if (!isRecord(raw)) throw new Error(`${label} 必须是 object`);
  if ("apiKey" in raw) throw new Error(`${label}.apiKey 不允许导入；请重新设置 key`);

  const id = raw.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`${label}.id 必须是非空字符串`);
  }
  const endpoint = raw.endpoint;
  if (typeof endpoint !== "string" || !ENDPOINTS.includes(endpoint as EndpointKind)) {
    throw new Error(`${label}.endpoint 不合法`);
  }

  const out: ProviderProfileExport = {
    id: id.trim(),
    endpoint: endpoint as EndpointKind,
  };

  if (raw.baseUrl !== undefined) {
    if (typeof raw.baseUrl !== "string") throw new Error(`${label}.baseUrl 必须是字符串`);
    out.baseUrl = raw.baseUrl;
  }
  if (raw.headers !== undefined) out.headers = validateStringRecord(raw.headers, `${label}.headers`);
  if (raw.extraBody !== undefined) {
    if (!isRecord(raw.extraBody)) throw new Error(`${label}.extraBody 必须是 object`);
    out.extraBody = raw.extraBody;
  }
  if (raw.reasoningReplay !== undefined) {
    if (
      typeof raw.reasoningReplay !== "string" ||
      !REASONING_REPLAY.includes(raw.reasoningReplay as ReasoningReplay)
    ) {
      throw new Error(`${label}.reasoningReplay 不合法`);
    }
    out.reasoningReplay = raw.reasoningReplay as ReasoningReplay;
  }
  if (raw.proxy !== undefined) {
    if (typeof raw.proxy !== "string" && raw.proxy !== false) {
      throw new Error(`${label}.proxy 必须是字符串或 false`);
    }
    out.proxy = raw.proxy;
  }
  if (raw.contextWindow !== undefined) {
    if (
      typeof raw.contextWindow !== "number" ||
      !Number.isSafeInteger(raw.contextWindow) ||
      raw.contextWindow <= 0
    ) {
      throw new Error(`${label}.contextWindow 必须是正整数`);
    }
    out.contextWindow = raw.contextWindow;
  }
  if (raw.tls !== undefined) {
    if (!isRecord(raw.tls)) throw new Error(`${label}.tls 必须是 object`);
    for (const forbidden of ["ca", "cert", "key", "passphrase"]) {
      if (forbidden in raw.tls) {
        throw new Error(`${label}.tls.${forbidden} 不允许导入；请使用 *File 路径`);
      }
    }
    const tls: ProviderTlsProfile = {};
    if (raw.tls.rejectUnauthorized !== undefined) {
      if (typeof raw.tls.rejectUnauthorized !== "boolean") {
        throw new Error(`${label}.tls.rejectUnauthorized 必须是布尔值`);
      }
      tls.rejectUnauthorized = raw.tls.rejectUnauthorized;
    }
    for (const key of ["serverName", "caFile", "certFile", "keyFile"] as const) {
      const value = raw.tls[key];
      if (value !== undefined) {
        if (typeof value !== "string") throw new Error(`${label}.tls.${key} 必须是字符串`);
        tls[key] = value;
      }
    }
    if (Object.keys(tls).length > 0) out.tls = tls;
  }

  return out;
}

export function parseProviderProfiles(text: string): ProviderProfileDocumentV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("provider profile 文档不是合法 JSON");
  }
  if (!isRecord(raw)) throw new Error("provider profile 文档必须是 object");
  if (raw.schema !== PROVIDER_PROFILE_SCHEMA) {
    throw new Error(`provider profile schema 不匹配：${String(raw.schema)}`);
  }
  if (raw.version !== PROVIDER_PROFILE_VERSION) {
    throw new Error(`不支持的 provider profile version：${String(raw.version)}`);
  }
  if (!Array.isArray(raw.providers)) throw new Error("providers 必须是数组");
  return {
    schema: PROVIDER_PROFILE_SCHEMA,
    version: PROVIDER_PROFILE_VERSION,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : new Date().toISOString(),
    providers: raw.providers.map((provider, index) => validateProvider(provider, index)),
  };
}

function uniqueImportedId(base: string, taken: Set<string>): string {
  let candidate = `${base}-imported`;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-imported-${index}`;
    index += 1;
  }
  return candidate;
}

export function importProviderProfiles(
  store: SessionStore,
  sessionId: string,
  document: ProviderProfileDocumentV1,
  options: ImportProviderProfilesOptions = {},
): ImportProviderProfilesResult {
  const conflict = options.conflict ?? "skip";
  const dryRun = options.dryRun === true;
  const result: ImportProviderProfilesResult = {
    imported: [],
    skipped: [],
    renamed: {},
    errors: [],
  };

  const existing = new Set(store.listProviderConfigs(sessionId).map((config) => config.id));

  for (const raw of document.providers) {
    let provider: ProviderProfileExport;
    try {
      provider = validateProvider(raw, 0);
    } catch (error) {
      result.errors.push({
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    let targetId = provider.id;
    if (existing.has(targetId)) {
      if (conflict === "skip") {
        result.skipped.push(targetId);
        continue;
      }
      if (conflict === "rename") {
        targetId = uniqueImportedId(targetId, existing);
        result.renamed[provider.id] = targetId;
      }
    }

    const config: PersistedProviderConfig = { ...provider, id: targetId };
    if (!dryRun) store.setProviderConfig(sessionId, config);
    existing.add(targetId);
    result.imported.push(targetId);
  }

  return result;
}
