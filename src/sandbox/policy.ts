/**
 * Sandbox policy compiler.
 *
 * The native provider is deliberately dumb: it receives a small, explicit
 * filesystem/network/limit policy and enforces it in the child before exec.
 * This module is the place where product-level concepts (workspace, MCP
 * server state, runtime paths, environment) are compiled into that policy.
 *
 * Keep this module free of process spawning. It is safe to unit test and it
 * can later be reused by the bash strict profile.
 */

import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { sanitizeEnv, type SanitizedEnv } from "./env.ts";

export type SandboxNetworkMode = "none" | "allowlist" | "all";

export interface SandboxLimits {
  cpuSeconds?: number;
  addressSpaceBytes?: number;
  fileSizeBytes?: number;
  openFiles?: number;
  processes?: number;
}

export interface NativeSandboxConfig {
  version: 1;
  kind: "mcp" | "bash";
  read: string[];
  write: string[];
  exec: string[];
  network: SandboxNetworkMode;
  allow: string[];
  limits?: SandboxLimits;
}

export interface SandboxPolicyInput {
  kind: "mcp" | "bash";
  cwd: string;
  read?: readonly string[];
  write?: readonly string[];
  exec?: readonly string[];
  network?: SandboxNetworkMode;
  allow?: readonly string[];
  limits?: SandboxLimits;
}

export interface McpSandboxPolicyInput {
  server: string;
  cwd: string;
  /** Private state directory. Defaults to ~/.bugent/mcp/<server>/state. */
  stateDir?: string;
  /** Whether the server may read the workspace. Defaults to true. */
  workspaceRead?: boolean;
  /** Whether the server may write the workspace, or explicit workspace paths. */
  workspaceWrite?: boolean | readonly string[];
  /** Additional external read paths. */
  read?: readonly string[];
  /** Additional external write paths. */
  write?: readonly string[];
  /** Additional executable roots. */
  exec?: readonly string[];
  /** Network mode. Defaults to "none". */
  network?: SandboxNetworkMode;
  /** Domains/IPs for allowlist mode. Currently rejected by the Linux provider. */
  networkAllow?: readonly string[];
  /** Environment variable names to pass through, in addition to the safe base set. */
  env?: readonly string[];
  limits?: SandboxLimits;
  /** Command that will be spawned. Used to derive execute/read grants. */
  cmd: readonly string[];
  /** Override HOME/XDG/TMPDIR. Defaults to private state subdirectories. */
  stateEnv?: boolean;
}

export interface CompiledMcpSandbox {
  config: NativeSandboxConfig;
  env: Record<string, string>;
  strippedEnv: string[];
  stateDir: string;
}

/** Public name for the capability grant attached to one MCP server. */
export type McpCapabilityGrant = McpSandboxPolicyInput;

const RUNTIME_READ_ROOTS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  /*
   * Bun/JSC probes procfs during startup (maps/cpu/filesystems). Landlock
   * cannot hide selected procfs entries, so this is a deliberate read-only
   * grant. It is still much narrower than bwrap's historical `--ro-bind / /`.
   */
  "/proc",
] as const;

const RUNTIME_EXEC_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"] as const;

const RUNTIME_CONFIG_READS = [
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/localtime",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/pki",
] as const;

const DEVICE_READS = ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"] as const;
const DEVICE_WRITES = ["/dev/null", "/dev/zero"] as const;

function fail(message: string): never {
  throw new Error(`sandbox policy: ${message}`);
}

function cleanPath(value: string, cwd: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${field} 不能包含空路径`);
  if (value.includes("\0")) fail(`${field} 不能包含 NUL`);
  const expanded =
    value === "~"
      ? homedir()
      : value.startsWith("~/")
        ? join(homedir(), value.slice(2))
        : value;
  return normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

function uniquePaths(paths: readonly string[], cwd: string, field: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const cleaned = cleanPath(path, cwd, field);
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

function existingPaths(paths: readonly string[], field: string, requireDirectory = false): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      // Runtime roots differ between distributions (for example /lib64 on
      // systems without a split /usr). Optional missing runtime paths are
      // ignored; explicit user paths are still rejected by the caller.
      continue;
    }
    const stat = statSync(path);
    if (requireDirectory && !stat.isDirectory()) fail(`${field} 必须是目录：${path}`);
    out.push(path);
  }
  return out;
}

function canonicalizeExisting(paths: readonly string[], field: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!existsSync(path)) fail(`${field} 不存在：${path}`);
    let canonical: string;
    try {
      canonical = realpathSync(path);
    } catch (error) {
      fail(`${field} 无法解析：${path}（${error instanceof Error ? error.message : String(error)}）`);
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

function resolveCommand(command: string): string | undefined {
  if (command.includes("/")) {
    return isAbsolute(command) ? command : resolve(process.cwd(), command);
  }
  return Bun.which(command) ?? undefined;
}

/**
 * Compile an explicit low-level policy. This function does not create paths;
 * it only normalizes and verifies them.
 */
export function compileSandboxPolicy(input: SandboxPolicyInput): NativeSandboxConfig {
  const network = input.network ?? "none";
  const allow = [...(input.allow ?? [])];
  if (network === "allowlist") {
    fail("Linux provider 目前只支持 network=none 或 network=all；allowlist 需要后续的代理/网络命名空间实现");
  }
  if (network === "none" && allow.length > 0) {
    fail("network=none 时不能同时提供 networkAllow");
  }

  const read = canonicalizeExisting(
    uniquePaths([...(input.read ?? []), ...DEVICE_READS], input.cwd, "read"),
    "read",
  );
  const write = canonicalizeExisting(
    uniquePaths([...(input.write ?? []), ...DEVICE_WRITES], input.cwd, "write"),
    "write",
  );
  const exec = canonicalizeExisting(
    uniquePaths(input.exec ?? [], input.cwd, "exec"),
    "exec",
  );

  const limits = input.limits === undefined ? undefined : validateLimits(input.limits);
  return {
    version: 1,
    kind: input.kind,
    read,
    write,
    exec,
    network,
    allow,
    ...(limits !== undefined ? { limits } : {}),
  };
}

function validateLimits(limits: SandboxLimits): SandboxLimits {
  const out: SandboxLimits = {};
  for (const [key, value] of Object.entries(limits) as [
    keyof SandboxLimits,
    number | undefined,
  ][]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(`limits.${key} 必须是正的安全整数`);
    }
    out[key] = value;
  }
  return out;
}

export function defaultMcpStateDir(server: string): string {
  const home = homedir();
  const safeServer = server.replace(/[^A-Za-z0-9_.-]/g, "_");
  return resolve(home, ".bugent", "mcp", safeServer, "state");
}

function ensureMcpStateDir(stateDir: string): {
  stateDir: string;
  tmpDir: string;
  cacheDir: string;
  configDir: string;
} {
  const tmpDir = join(stateDir, "tmp");
  const cacheDir = join(stateDir, "cache");
  const configDir = join(stateDir, "config");
  for (const path of [stateDir, tmpDir, cacheDir, configDir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return { stateDir, tmpDir, cacheDir, configDir };
}

function mcpWorkspaceWritePaths(
  workspaceWrite: boolean | readonly string[] | undefined,
  cwd: string,
): string[] {
  if (workspaceWrite === true) return [cwd];
  if (workspaceWrite === false || workspaceWrite === undefined) return [];
  return uniquePaths(workspaceWrite, cwd, "workspaceWrite");
}

function commandGrants(cmd: readonly string[]): {
  read: string[];
  exec: string[];
} {
  const command = cmd[0];
  if (command === undefined || command.length === 0) fail("cmd 不能为空");
  const resolved = resolveCommand(command);
  if (resolved === undefined) fail(`找不到可执行文件：${command}`);
  if (!existsSync(resolved)) fail(`可执行文件不存在：${resolved}`);

  const canonical = realpathSync(resolved);
  const read = [canonical];
  const exec = [dirname(canonical)];
  // A shebang or dynamic loader may need the interpreter's directory. Runtime
  // roots below are the safe default; callers that need workspace-local
  // executables must grant them explicitly through `exec`.
  return { read, exec };
}

function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/**
 * Compile the default MCP capability grant.
 *
 * Defaults:
 *   - workspace read: yes
 *   - workspace write: no
 *   - private state write: yes
 *   - network: none
 *   - runtime roots: read + execute
 *   - host environment: safe allowlist only
 */
export function compileMcpSandbox(input: McpSandboxPolicyInput): CompiledMcpSandbox {
  const state = ensureMcpStateDir(input.stateDir ?? defaultMcpStateDir(input.server));
  const command = commandGrants(input.cmd);

  const read = [
    ...(input.workspaceRead === false ? [] : [input.cwd]),
    ...RUNTIME_READ_ROOTS,
    ...RUNTIME_CONFIG_READS,
    ...command.read,
    ...(input.read ?? []),
  ];
  const write = [
    state.stateDir,
    ...mcpWorkspaceWritePaths(input.workspaceWrite, input.cwd),
    ...(input.write ?? []),
  ];
  const exec = [...RUNTIME_EXEC_ROOTS, ...command.exec, ...(input.exec ?? [])];

  // Missing optional runtime roots are ignored; explicit paths remain strict
  // because they were supplied by the caller.
  const existingRead = dedupe([
    ...existingPaths(read, "read"),
    ...canonicalizeExisting(
      uniquePaths(input.read ?? [], input.cwd, "read"),
      "read",
    ),
  ]);
  const existingWrite = canonicalizeExisting(
    uniquePaths(write, input.cwd, "write"),
    "write",
  );
  const existingExec = dedupe([
    ...existingPaths(exec, "exec", true),
    ...canonicalizeExisting(
      uniquePaths(input.exec ?? [], input.cwd, "exec"),
      "exec",
    ),
  ]);

  const network = input.network ?? "none";
  if (network === "allowlist") {
    fail("Linux provider 目前只支持 network=none 或 network=all；allowlist 需要后续的代理/网络命名空间实现");
  }
  if (network === "none" && (input.networkAllow?.length ?? 0) > 0) {
    fail("network=none 时不能同时提供 networkAllow");
  }

  const config = compileSandboxPolicy({
    kind: "mcp",
    cwd: input.cwd,
    read: existingRead,
    write: existingWrite,
    exec: existingExec,
    network,
    ...(input.limits !== undefined ? { limits: input.limits } : {}),
  });

  const stateEnv = input.stateEnv !== false;
  const extra = stateEnv
    ? {
        HOME: state.stateDir,
        TMPDIR: state.tmpDir,
        XDG_CACHE_HOME: state.cacheDir,
        XDG_CONFIG_HOME: state.configDir,
        XDG_STATE_HOME: state.stateDir,
      }
    : undefined;
  const sanitized = sanitizeEnv(process.env, {
    ...(input.env !== undefined ? { allow: input.env } : {}),
    ...(extra !== undefined ? { extra } : {}),
  });

  return {
    config,
    env: sanitized.env,
    strippedEnv: sanitized.stripped,
    stateDir: state.stateDir,
  };
}

/** Resolve the native provider shared library for the current checkout/package. */
export function nativeSandboxLibraryPath(): string | undefined {
  const override = process.env.BUGENT_SANDBOX_LIBRARY;
  if (override !== undefined && override.length > 0) return override;
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const candidates = [
    join(repoRoot, "native", "sandbox", "build", "libbugent-sandbox.so"),
    join(repoRoot, "native", "sandbox", "libbugent-sandbox.so"),
    join(repoRoot, "runtime", "bun", "lib", "libbugent-sandbox.so"),
  ];
  return candidates.find((path) => existsSync(path));
}

export function assertNativeSandboxLibrary(): string {
  if (process.platform !== "linux") {
    fail(`原生 provider 当前只支持 Linux，当前平台是 ${process.platform}`);
  }
  const path = nativeSandboxLibraryPath();
  if (path === undefined) {
    fail(
      "找不到 libbugent-sandbox.so；运行 `bun run build:sandbox` 或设置 BUGENT_SANDBOX_LIBRARY",
    );
  }
  return path;
}
