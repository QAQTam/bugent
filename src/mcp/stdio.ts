/**
 * Minimal MCP stdio transport.
 *
 * The transport is deliberately small and protocol-focused. Product policy
 * (which server may start, which capability grant it receives, how tools are
 * injected into the timeline) belongs above this layer.
 *
 * The child is always started through the Bugent Bun sandbox hook. There is no
 * unsandboxed fallback for stdio MCP: if the native provider is unavailable,
 * startup fails closed.
 */

import { assertBugentBunRuntime, spawnMcpServer } from "../../runtime/bun/src/index.ts";
import { assertNativeSandboxLibrary, compileMcpSandbox } from "../sandbox/policy.ts";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_CLIENT_NAME = "bugent";
export const MCP_CLIENT_VERSION = "0.0.0";

/** The native MCP sandbox is Linux-only until an equivalent backend exists. */
export function isMcpSandboxSupported(platform = process.platform): boolean {
  return platform === "linux";
}

export function assertMcpSandboxSupported(platform = process.platform): void {
  if (!isMcpSandboxSupported(platform)) {
    throw new Error(
      `MCP stdio 已禁用：原生沙箱当前只支持 Linux，当前平台是 ${platform}。` +
        `Windows/macOS provider 完成前不会以无沙箱方式启动 MCP server。`,
    );
  }
}

export interface McpStdioServerConfig {
  /** Stable server id used in `mcp__<server>__<tool>` names. */
  id: string;
  /** Executable and arguments. */
  cmd: readonly string[];
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
  /** Environment variable names to pass through. */
  env?: readonly string[];
  /** Workspace read access. Defaults to true. */
  workspaceRead?: boolean;
  /** Workspace write access. Defaults to false. */
  workspaceWrite?: boolean | readonly string[];
  /** Additional external read paths. */
  read?: readonly string[];
  /** Additional external write paths. */
  write?: readonly string[];
  /** Additional executable roots. */
  exec?: readonly string[];
  /** Network mode. Defaults to none. */
  network?: "none" | "allowlist" | "all";
  networkAllow?: readonly string[];
  /** Private state directory. */
  stateDir?: string;
  limits?: {
    cpuSeconds?: number;
    addressSpaceBytes?: number;
    fileSizeBytes?: number;
    openFiles?: number;
    processes?: number;
  };
  /** Stderr retained for diagnostics. */
  stderrLimitBytes?: number;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpCallToolResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcMessage = JsonRpcSuccess | JsonRpcFailure;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorFromRpc(message: JsonRpcFailure): Error {
  const detail =
    message.error.data === undefined
      ? ""
      : ` (${typeof message.error.data === "string" ? message.error.data : JSON.stringify(message.error.data)})`;
  return new Error(`MCP JSON-RPC ${message.error.code}: ${message.error.message}${detail}`);
}

export class McpStdioClient {
  readonly id: string;
  readonly #config: McpStdioServerConfig;
  #process: Bun.PipedSubprocess | undefined;
  #stdin: Bun.FileSink | undefined;
  #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #stderrReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #buffer = "";
  #stderr = "";
  #closed = false;
  #initialized = false;

  constructor(config: McpStdioServerConfig) {
    this.id = config.id;
    this.#config = config;
  }

  get running(): boolean {
    return this.#process !== undefined && !this.#closed;
  }

  get stderr(): string {
    return this.#stderr;
  }

  async start(): Promise<void> {
    if (this.#process !== undefined) throw new Error(`MCP server ${this.id} 已经启动`);
    assertMcpSandboxSupported();
    const cwd = this.#config.cwd ?? process.cwd();
    const compiled = compileMcpSandbox({
      server: this.id,
      cmd: this.#config.cmd,
      cwd,
      ...(this.#config.env !== undefined ? { env: this.#config.env } : {}),
      ...(this.#config.workspaceRead !== undefined
        ? { workspaceRead: this.#config.workspaceRead }
        : {}),
      ...(this.#config.workspaceWrite !== undefined
        ? { workspaceWrite: this.#config.workspaceWrite }
        : {}),
      ...(this.#config.read !== undefined ? { read: this.#config.read } : {}),
      ...(this.#config.write !== undefined ? { write: this.#config.write } : {}),
      ...(this.#config.exec !== undefined ? { exec: this.#config.exec } : {}),
      ...(this.#config.network !== undefined ? { network: this.#config.network } : {}),
      ...(this.#config.networkAllow !== undefined
        ? { networkAllow: this.#config.networkAllow }
        : {}),
      ...(this.#config.stateDir !== undefined ? { stateDir: this.#config.stateDir } : {}),
      ...(this.#config.limits !== undefined ? { limits: this.#config.limits } : {}),
    });

    assertBugentBunRuntime();
    const proc = spawnMcpServer({
      cmd: this.#config.cmd,
      cwd,
      env: compiled.env,
      sandboxLibrary: assertNativeSandboxLibrary(),
      policy: {
        read: compiled.config.read,
        write: compiled.config.write,
        exec: compiled.config.exec,
        network: compiled.config.network,
        ...(compiled.config.allow.length > 0 ? { allow: compiled.config.allow } : {}),
        ...(compiled.config.limits !== undefined
          ? { limits: compiled.config.limits }
          : {}),
      },
    }) as Bun.PipedSubprocess;

    this.#process = proc;
    this.#stdin = proc.stdin ?? undefined;
    if (this.#stdin === undefined) {
      proc.kill("SIGKILL");
      throw new Error(`MCP server ${this.id} 没有 stdin pipe`);
    }
    if (proc.stdout === undefined || proc.stderr === undefined) {
      proc.kill("SIGKILL");
      throw new Error(`MCP server ${this.id} 没有 stdio pipe`);
    }

    this.#reader = proc.stdout.getReader();
    this.#stderrReader = proc.stderr.getReader();
    void this.#readStdout();
    void this.#readStderr();
    void proc.exited.then(
      async (code) => {
        // Give the stderr reader one turn to drain the diagnostic that usually
        // explains a startup failure.
        await Bun.sleep(0);
        const detail = this.#stderr.trim();
        this.#failPending(
          new Error(
            `MCP server ${this.id} 退出，exit=${code}${detail.length > 0 ? `\n${detail}` : ""}`,
          ),
        );
      },
      (error) => this.#failPending(error instanceof Error ? error : new Error(String(error))),
    );
  }

  async initialize(): Promise<unknown> {
    if (this.#initialized) return undefined;
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    });
    this.notify("notifications/initialized", {});
    this.#initialized = true;
    return result;
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.initialize();
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.request("tools/list", cursor === undefined ? {} : { cursor });
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new Error(`MCP server ${this.id} 的 tools/list 返回格式无效`);
      }
      for (const item of result.tools) {
        if (!isRecord(item) || typeof item.name !== "string") {
          throw new Error(`MCP server ${this.id} 返回了无效工具`);
        }
        tools.push({
          name: item.name,
          ...(typeof item.title === "string" ? { title: item.title } : {}),
          ...(typeof item.description === "string" ? { description: item.description } : {}),
          ...(isRecord(item.inputSchema) ? { inputSchema: item.inputSchema } : {}),
          ...(isRecord(item.annotations)
            ? {
                annotations: {
                  ...(typeof item.annotations.title === "string"
                    ? { title: item.annotations.title }
                    : {}),
                  ...(typeof item.annotations.readOnlyHint === "boolean"
                    ? { readOnlyHint: item.annotations.readOnlyHint }
                    : {}),
                  ...(typeof item.annotations.destructiveHint === "boolean"
                    ? { destructiveHint: item.annotations.destructiveHint }
                    : {}),
                  ...(typeof item.annotations.idempotentHint === "boolean"
                    ? { idempotentHint: item.annotations.idempotentHint }
                    : {}),
                  ...(typeof item.annotations.openWorldHint === "boolean"
                    ? { openWorldHint: item.annotations.openWorldHint }
                    : {}),
                },
              }
            : {}),
        });
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(name: string, args: unknown): Promise<McpCallToolResult> {
    await this.initialize();
    const result = await this.request("tools/call", {
      name,
      arguments: args ?? {},
    });
    if (!isRecord(result)) throw new Error(`MCP server ${this.id} 的 tools/call 返回格式无效`);
    return result as McpCallToolResult;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.running || this.#stdin === undefined) {
      throw new Error(`MCP server ${this.id} 未运行`);
    }
    const id = this.#nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#stdin.write(`${payload}\n`);
    await this.#stdin.flush();
    return promise;
  }

  notify(method: string, params: unknown): void {
    if (!this.running || this.#stdin === undefined) return;
    this.#stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    void this.#stdin.flush();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const proc = this.#process;
    if (proc === undefined) return;
    this.#failPending(new Error(`MCP server ${this.id} 已关闭`));
    try {
      this.#stdin?.end();
    } catch {
      // Ignore shutdown races.
    }
    const timer = setTimeout(() => proc.kill("SIGKILL"), 1_000);
    try {
      await proc.exited;
    } finally {
      clearTimeout(timer);
      this.#reader?.releaseLock();
      this.#stderrReader?.releaseLock();
      this.#reader = undefined;
      this.#stderrReader = undefined;
      this.#process = undefined;
    }
  }

  async #readStdout(): Promise<void> {
    const reader = this.#reader;
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        this.#buffer += decoder.decode(value, { stream: true });
        this.#consumeLines();
      }
      this.#buffer += decoder.decode();
      this.#consumeLines();
    } catch (error) {
      if (!this.#closed) {
        this.#failPending(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #consumeLines(): void {
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      this.#handleMessage(line);
    }
  }

  #handleMessage(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    if ("id" in message && (typeof message.id === "number" || typeof message.id === "string")) {
      if (typeof message.id !== "number") return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (isRecord(message.error)) {
        pending.reject(errorFromRpc(message as unknown as JsonRpcFailure));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Notifications are currently ignored by the transport. The manager can
    // attach handlers later without changing the wire format.
  }

  async #readStderr(): Promise<void> {
    const reader = this.#stderrReader;
    if (reader === undefined) return;
    const decoder = new TextDecoder();
    const limit = this.#config.stderrLimitBytes ?? 16 * 1024;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        this.#stderr += decoder.decode(value, { stream: true });
        if (this.#stderr.length > limit) this.#stderr = this.#stderr.slice(-limit);
      }
      this.#stderr += decoder.decode();
    } catch {
      // stderr is diagnostic only.
    }
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export function isMcpJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return isRecord(value) && value.jsonrpc === "2.0";
}
