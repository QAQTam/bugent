import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const BUN_RUNTIME_VERSION = "1.4.3-bugent.3";

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
  /** Paths whose executables the MCP process may execute. */
  exec?: readonly string[];
  /** Network policy. `all` is intentionally explicit. */
  network?: "none" | "allowlist" | "all";
  /** Domains/IPs when network is `allowlist`. */
  allow?: readonly string[];
  /** Resource limits enforced in the child before exec. */
  limits?: {
    cpuSeconds?: number;
    addressSpaceBytes?: number;
    fileSizeBytes?: number;
    openFiles?: number;
    processes?: number;
  };
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
        `Run \`bun run runtime:install\` or set BUGENT_BUN_BIN.`,
    );
  }
  return binary;
}

function sameExecutable(left: string, right: string): boolean {
  if (realpathSync(left) === realpathSync(right)) return true;
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  if (leftStat.size !== rightStat.size) return false;
  const hash = (path: string): string =>
    new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
  return hash(left) === hash(right);
}

/**
 * Fail closed when the process is not the Bugent Bun fork.
 *
 * A standard Bun silently ignoring `sandbox` would turn MCP isolation into a
 * no-op, so stdio MCP must verify the running executable before spawning.
 */
export function assertBugentBunRuntime(): string {
  const expected = assertBunRuntimeInstalled();
  let currentPath: string;
  let expectedPath: string;
  try {
    currentPath = realpathSync(process.execPath);
    expectedPath = realpathSync(expected);
  } catch (error) {
    throw new Error(
      `无法解析当前 Bun runtime（current=${process.execPath}, expected=${expected}）：` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!sameExecutable(currentPath, expectedPath)) {
    throw new Error(
      `MCP stdio 需要 Bugent Bun fork（当前 ${currentPath}，期望 ${expectedPath}）。` +
        `请运行 \`bun run runtime:install -- --global\`，或设置 BUGENT_BUN_BIN。`,
    );
  }
  return expectedPath;
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
