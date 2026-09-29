/**
 * provider adapter 公共网络底座。
 *
 * 这里只放"跟 wire format 无关"的通用能力：SSE 行解析、代理 / TLS 请求扩展、
 * 回环直连处理。各家 wire 格式的知识（消息怎么编码、流式事件怎么归一化）属于
 * 各 adapter 文件，不要往这里挪。
 */

import { readFileSync } from "node:fs";

export type ProviderProxy = string | false;

export interface ProviderTlsConfig {
  rejectUnauthorized?: boolean;
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  serverName?: string;
  /** 从文件读取 CA；用于 session profile 的可导出配置。 */
  caFile?: string;
  /** 从文件读取客户端证书。 */
  certFile?: string;
  /** 从文件读取客户端私钥。 */
  keyFile?: string;
}

/**
 * Bun.fetch 支持 `proxy` / `tls` 扩展，但当前安装的 @types/bun 1.4.2
 * 还没把 `proxy: false` 写进 RequestInit；用交叉类型保留类型检查。
 */
export type FetchInit = RequestInit & {
  proxy?: ProviderProxy;
  tls?: ProviderTlsConfig;
};

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Bun 1.4.2 实测：即使 fetch 传了 `proxy: false`，HTTP_PROXY 仍可能生效；
 * `NO_PROXY` 才是可靠的绕过方式。对本地 endpoint 自动补齐回环地址，
 * 避免开发机上的全局代理把 127.0.0.1:8787 也劫走。
 */
export function ensureLoopbackNoProxy(): void {
  const current = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const entries = current
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    if (!entries.includes(host)) entries.push(host);
  }
  process.env.NO_PROXY = entries.join(",");
}

/**
 * 把可导出的 *File 字段解析成 Bun.fetch 需要的 PEM 字符串。
 * 私钥/CA 内容不会进入 session profile，只保留文件路径。
 */
export function resolveTlsConfig(tls: ProviderTlsConfig | undefined): ProviderTlsConfig | undefined {
  if (tls === undefined) return undefined;
  const { caFile, certFile, keyFile, ...rest } = tls;
  return {
    ...rest,
    ...(caFile !== undefined ? { ca: readFileSync(caFile, "utf8") } : {}),
    ...(certFile !== undefined ? { cert: readFileSync(certFile, "utf8") } : {}),
    ...(keyFile !== undefined ? { key: readFileSync(keyFile, "utf8") } : {}),
  };
}

/** 把 SSE body 切成一行一行的字符串（跨 chunk 缓冲，处理 \r\n）。 */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
