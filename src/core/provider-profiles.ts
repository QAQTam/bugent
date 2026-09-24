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

function exportProvider(config: PersistedProviderConfig): ProviderProfileExport {
  const tls = exportTls(config.tls);
  return {
    id: config.id,
    endpoint: config.endpoint,
    ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    ...(config.extraBody !== undefined ? { extraBody: config.extraBody } : {}),
    ...(config.reasoningReplay !== undefined
      ? { reasoningReplay: config.reasoningReplay }
      : {}),
    ...(config.proxy !== undefined ? { proxy: config.proxy } : {}),
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
