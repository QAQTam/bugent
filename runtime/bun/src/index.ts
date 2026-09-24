import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const BUN_RUNTIME_VERSION = "1.4.3-bugent.1";

export interface SandboxProviderOptions {
  /** Path to the native provider shared library. */
  library: string;
  /** Structured policy; encoded as UTF-8 JSON before crossing the ABI. */
  config?: string | Record<string, unknown>;
}

export interface SandboxSpawnOptions {
  cmd: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  sandbox: SandboxProviderOptions;
  stdin?: Bun.Spawn.Writable;
  stdout?: Bun.Spawn.Readable;
  stderr?: Bun.Spawn.Readable;
}

export interface McpSandboxPolicy {
  /** Paths the MCP process may read. */
  read?: readonly string[];
  /** Paths the MCP process may write. */
  write?: readonly string[];
  /** Network policy. `all` is intentionally explicit. */
  network?: "none" | "allowlist" | "all";
  /** Domains/IPs when network is `allowlist`. */
  allow?: readonly string[];
  /** Environment variable names the provider may pass through. */
  env?: readonly string[];
}

export interface McpSpawnOptions {
  cmd: readonly string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  sandboxLibrary: string;
  policy: McpSandboxPolicy;
}

export function bunRuntimeBinary(): string {
  const override = process.env.BUGENT_BUN_BIN;
  if (override !== undefined && override.length > 0) return override;
  return resolve(import.meta.dir, "..", "bin", "bugent-bun");
}

export function sandboxAbiHeader(): string {
  return resolve(import.meta.dir, "..", "include", "bun_spawn_sandbox.h");
}

export function assertBunRuntimeInstalled(): string {
  const binary = bunRuntimeBinary();
  if (!existsSync(binary)) {
    throw new Error(
      `Bugent Bun runtime not found at ${binary}. ` +
        `Build the fork or set BUGENT_BUN_BIN to the bun binary.`,
    );
  }
  return binary;
}

function encodeSandboxConfig(config: SandboxProviderOptions["config"]): string | undefined {
  if (config === undefined) return undefined;
  return typeof config === "string" ? config : JSON.stringify(config);
}

export function spawnSandboxed(options: SandboxSpawnOptions): ReturnType<typeof Bun.spawn> {
  const spawn = Bun.spawn as unknown as (options: {
    cmd: readonly string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: Bun.Spawn.Writable;
    stdout?: Bun.Spawn.Readable;
    stderr?: Bun.Spawn.Readable;
    sandbox: { library: string; config?: string };
  }) => ReturnType<typeof Bun.spawn>;

  const config = encodeSandboxConfig(options.sandbox.config);
  const sandbox =
    config === undefined
      ? { library: options.sandbox.library }
      : { library: options.sandbox.library, config };

  return spawn({
    cmd: options.cmd,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdin: options.stdin ?? "pipe",
    stdout: options.stdout ?? "pipe",
    stderr: options.stderr ?? "pipe",
    sandbox,
  });
}

export function spawnMcpServer(options: McpSpawnOptions): ReturnType<typeof Bun.spawn> {
  return spawnSandboxed({
    cmd: options.cmd,
    cwd: options.cwd,
    ...(options.env !== undefined ? { env: options.env } : {}),
    sandbox: {
      library: options.sandboxLibrary,
      config: {
        kind: "mcp",
        ...options.policy,
      },
    },
  });
}

export function runtimeDirectory(): string {
  return dirname(resolve(import.meta.dir, "..", "bin", "bugent-bun"));
}
