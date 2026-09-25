/**
 * Agent sandbox compiler — P7-A.
 *
 * This module turns an AgentKind profile plus explicit parent grants into an
 * immutable AgentSandboxSpec. It performs no filesystem probing and starts no
 * process: path canonicalization and provider availability belong to the
 * execution layer. Lexical containment checks here make the intent explicit
 * and fail closed before a process can be launched.
 */

import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import {
  assertAuthorityAttenuation,
  assertCapabilityAttenuation,
  defaultAuthorityForKind,
  defaultCapabilitiesForKind,
  hasCapability,
  isAgentAuthority,
  isAgentCapability,
  isAgentKind,
  uniqueCapabilities,
  validateAgentProfile,
  type AgentAuthority,
  type AgentCapability,
  type AgentKind,
} from "./model.ts";

export type WorkspaceAccess = "none" | "read" | "write";
export type WorkspaceIsolation = "shared" | "worktree" | "overlay" | "snapshot";
export type ProcessIsolation = "none" | "landlock+seccomp" | "bwrap" | "container";
export type AgentNetworkMode = "none" | "one-shot" | "allowlist" | "all";

export interface AgentWorkspaceSpec {
  readonly access: WorkspaceAccess;
  readonly isolation: WorkspaceIsolation;
  readonly root: string;
  readonly writablePaths: readonly string[];
  readonly readonlyPaths: readonly string[];
  readonly allowSymlinkEscape: false;
}

export interface AgentProcessSpec {
  readonly isolation: ProcessIsolation;
  readonly executablePaths: readonly string[];
  readonly maxProcesses: number;
  readonly maxCpuSeconds: number;
  readonly maxMemoryBytes: number;
  readonly maxOpenFiles: number;
}

export interface AgentNetworkSpec {
  readonly mode: AgentNetworkMode;
  readonly allow: readonly string[];
  readonly oneShotGrantId?: string;
}

export interface AgentEnvSpec {
  readonly allow: readonly string[];
  readonly extra: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
}

export interface AgentSandboxSpec {
  readonly agentId: string;
  readonly kind: AgentKind;
  readonly authority: AgentAuthority;
  readonly workspace: AgentWorkspaceSpec;
  readonly process: AgentProcessSpec;
  readonly network: AgentNetworkSpec;
  readonly env: AgentEnvSpec;
  readonly capabilities: readonly AgentCapability[];
  readonly mcpServerIds: readonly string[];
  readonly maxDepth: number;
  readonly controlChannel: "supervisor-ipc";
}

export interface ParentAgentPolicy {
  readonly authority: AgentAuthority;
  readonly capabilities: readonly AgentCapability[];
}

export interface AgentSandboxRequest {
  readonly agentId: string;
  readonly kind: AgentKind;
  readonly authority?: AgentAuthority;
  readonly capabilities?: readonly AgentCapability[];
  readonly workspace: {
    readonly root: string;
    readonly access?: WorkspaceAccess;
    readonly isolation?: WorkspaceIsolation;
    readonly writablePaths?: readonly string[];
    readonly readonlyPaths?: readonly string[];
  };
  readonly process?: {
    readonly isolation?: ProcessIsolation;
    readonly executablePaths?: readonly string[];
    readonly maxProcesses?: number;
    readonly maxCpuSeconds?: number;
    readonly maxMemoryBytes?: number;
    readonly maxOpenFiles?: number;
  };
  readonly network?: {
    readonly mode?: AgentNetworkMode;
    readonly allow?: readonly string[];
    readonly oneShotGrantId?: string;
  };
  readonly env?: {
    readonly allow?: readonly string[];
    readonly extra?: Readonly<Record<string, string>>;
    readonly unset?: readonly string[];
  };
  readonly mcpServerIds?: readonly string[];
  readonly maxDepth?: number;
  readonly parent?: ParentAgentPolicy;
}

const PROCESS_DEFAULTS = {
  maxProcesses: 64,
  maxCpuSeconds: 600,
  maxMemoryBytes: 2 * 1024 * 1024 * 1024,
  maxOpenFiles: 256,
} as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_EXTRA_ENV = new Set([
  "HOME",
  "TMPDIR",
  "PATH",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "BUGENT_SANDBOX_LIBRARY",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "BUN_OPTIONS",
  "NODE_OPTIONS",
]);

function fail(message: string): never {
  throw new Error(`agent sandbox: ${message}`);
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  if (value.includes("\0")) fail(`${field} must not contain NUL`);
  return value.trim();
}

function uniqueStrings(values: readonly string[], field: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = nonEmpty(raw, field);
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function normalizeAbsolutePath(value: string, field: string): string {
  const cleaned = nonEmpty(value, field);
  if (!isAbsolute(cleaned)) fail(`${field} must be an absolute path: ${cleaned}`);
  return normalize(cleaned);
}

function normalizeWorkspacePath(value: string, root: string, field: string): string {
  const cleaned = nonEmpty(value, field);
  const absolute = normalize(isAbsolute(cleaned) ? cleaned : resolve(root, cleaned));
  if (!isWithin(root, absolute)) fail(`${field} must stay inside the workspace root: ${absolute}`);
  return absolute;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function validateNoOverlap(
  writablePaths: readonly string[],
  readonlyPaths: readonly string[],
): void {
  for (const writable of writablePaths) {
    for (const readonly of readonlyPaths) {
      if (pathsOverlap(writable, readonly)) {
        fail(`writablePaths overlaps readonlyPaths: ${writable} <-> ${readonly}`);
      }
    }
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${field} must be a positive safe integer`);
  return value;
}

function defaultWorkspaceAccess(kind: AgentKind): WorkspaceAccess {
  return kind === "reviewer" || kind === "explorer" ? "read" : "write";
}

function defaultWorkspaceIsolation(kind: AgentKind): WorkspaceIsolation {
  if (kind === "worker") return "worktree";
  return "shared";
}

function defaultProcessIsolation(platform: string): ProcessIsolation {
  return platform === "linux" ? "bwrap" : "none";
}

function validateCapabilityWorkspace(
  capabilities: readonly AgentCapability[],
  workspace: AgentWorkspaceSpec,
): void {
  const canRead = hasCapability(capabilities, "fs.read");
  const canWrite = hasCapability(capabilities, "fs.write");

  if (workspace.access === "none" && canRead) {
    fail("fs.read conflicts with workspace.access=none");
  }
  if (workspace.access !== "none" && !canRead) {
    fail(`workspace.access=${workspace.access} requires the fs.read capability`);
  }
  if (canWrite && workspace.access !== "write") {
    fail("fs.write requires workspace.access=write");
  }
  if (workspace.access === "write" && !canWrite) {
    fail("workspace.access=write requires the fs.write capability");
  }
}

function validateProcessCapability(
  capabilities: readonly AgentCapability[],
  processSpec: AgentProcessSpec,
): void {
  if (hasCapability(capabilities, "process.exec") && processSpec.isolation === "none") {
    fail("process.exec must be off when there is no process isolation");
  }
}

function validateNetworkCapability(
  capabilities: readonly AgentCapability[],
  network: AgentNetworkSpec,
): void {
  const hasNetwork = hasCapability(capabilities, "network");
  if (network.mode !== "none" && !hasNetwork) {
    fail(`network.mode=${network.mode} requires the network capability`);
  }
  if (hasNetwork && network.mode === "none") {
    fail("the network capability needs an explicit network.mode; it cannot stay none");
  }
  if (network.mode === "none" && network.allow.length > 0) {
    fail("network.allow must not be set when network.mode=none");
  }
  if (network.mode === "one-shot" && network.oneShotGrantId === undefined) {
    fail("network.mode=one-shot requires oneShotGrantId");
  }
  if (network.mode !== "one-shot" && network.oneShotGrantId !== undefined) {
    fail("oneShotGrantId is only valid with network.mode=one-shot");
  }
  if (network.mode === "allowlist" && network.allow.length === 0) {
    fail("network.mode=allowlist requires network.allow");
  }
  if (network.mode === "all" && network.allow.length > 0) {
    fail("network.mode=all must not also set network.allow");
  }
}

function validateEnv(env: AgentEnvSpec): void {
  const allowed = new Set(env.allow);
  for (const name of env.allow) {
    if (!ENV_NAME.test(name)) fail(`env.allow has an invalid variable name: ${name}`);
    if (env.unset.includes(name)) fail(`a variable cannot be both allowed and unset: ${name}`);
  }
  for (const name of env.unset) {
    if (!ENV_NAME.test(name)) fail(`env.unset has an invalid variable name: ${name}`);
  }
  for (const [name, value] of Object.entries(env.extra)) {
    if (!ENV_NAME.test(name)) fail(`env.extra has an invalid variable name: ${name}`);
    if (value.includes("\0")) fail(`env.extra.${name} must not contain NUL`);
    if (RESERVED_EXTRA_ENV.has(name)) fail(`env.extra must not override reserved variables: ${name}`);
    if (allowed.has(name)) fail(`a variable cannot be both allowed and extra: ${name}`);
    if (env.unset.includes(name)) fail(`a variable cannot be both extra and unset: ${name}`);
  }
}

function buildWorkspace(
  request: AgentSandboxRequest["workspace"],
  kind: AgentKind,
): AgentWorkspaceSpec {
  const root = normalizeAbsolutePath(request.root, "workspace.root");
  const access = request.access ?? defaultWorkspaceAccess(kind);
  const isolation = request.isolation ?? defaultWorkspaceIsolation(kind);
  const writablePaths = uniqueStrings(request.writablePaths ?? [], "workspace.writablePaths").map(
    (path) => normalizeWorkspacePath(path, root, "workspace.writablePaths"),
  );
  const readonlyPaths = uniqueStrings(request.readonlyPaths ?? [], "workspace.readonlyPaths").map(
    (path) => normalizeWorkspacePath(path, root, "workspace.readonlyPaths"),
  );

  if (access !== "write" && writablePaths.length > 0) {
    fail("workspace.writablePaths is only valid with workspace.access=write");
  }
  validateNoOverlap(writablePaths, readonlyPaths);

  return Object.freeze({
    access,
    isolation,
    root,
    writablePaths: Object.freeze(writablePaths),
    readonlyPaths: Object.freeze(readonlyPaths),
    allowSymlinkEscape: false,
  });
}

function buildProcess(
  request: AgentSandboxRequest["process"],
  platform: string,
): AgentProcessSpec {
  const executablePaths = uniqueStrings(
    request?.executablePaths ?? [],
    "process.executablePaths",
  ).map((path) => normalizeAbsolutePath(path, "process.executablePaths"));

  return Object.freeze({
    isolation: request?.isolation ?? defaultProcessIsolation(platform),
    executablePaths: Object.freeze(executablePaths),
    maxProcesses: positiveInteger(
      request?.maxProcesses ?? PROCESS_DEFAULTS.maxProcesses,
      "process.maxProcesses",
    ),
    maxCpuSeconds: positiveInteger(
      request?.maxCpuSeconds ?? PROCESS_DEFAULTS.maxCpuSeconds,
      "process.maxCpuSeconds",
    ),
    maxMemoryBytes: positiveInteger(
      request?.maxMemoryBytes ?? PROCESS_DEFAULTS.maxMemoryBytes,
      "process.maxMemoryBytes",
    ),
    maxOpenFiles: positiveInteger(
      request?.maxOpenFiles ?? PROCESS_DEFAULTS.maxOpenFiles,
      "process.maxOpenFiles",
    ),
  });
}

function buildNetwork(request: AgentSandboxRequest["network"]): AgentNetworkSpec {
  const mode = request?.mode ?? "none";
  const allow = uniqueStrings(request?.allow ?? [], "network.allow");
  const oneShotGrantId =
    request?.oneShotGrantId === undefined
      ? undefined
      : nonEmpty(request.oneShotGrantId, "network.oneShotGrantId");
  return Object.freeze({
    mode,
    allow: Object.freeze(allow),
    ...(oneShotGrantId !== undefined ? { oneShotGrantId } : {}),
  });
}

function buildEnv(request: AgentSandboxRequest["env"]): AgentEnvSpec {
  const allow = uniqueStrings(request?.allow ?? [], "env.allow");
  const unset = uniqueStrings(request?.unset ?? [], "env.unset");
  const extra = Object.freeze({ ...(request?.extra ?? {}) });
  return Object.freeze({
    allow: Object.freeze(allow),
    extra,
    unset: Object.freeze(unset),
  });
}

/**
 * Compile and freeze one child policy. Runtime callers must not mutate the
 * returned object; later grants are represented as a new one-shot overlay.
 */
export function compileAgentSandboxSpec(
  request: AgentSandboxRequest,
  platform: string = process.platform,
): AgentSandboxSpec {
  if (!isAgentKind(request.kind)) fail(`unknown AgentKind: ${String(request.kind)}`);

  const agentId = nonEmpty(request.agentId, "agentId");
  const authority = request.authority ?? defaultAuthorityForKind(request.kind);
  if (!isAgentAuthority(authority)) fail(`unknown authority: ${String(authority)}`);

  const requestedCapabilities =
    request.capabilities ?? defaultCapabilitiesForKind(request.kind, authority, platform);
  for (const capability of requestedCapabilities) {
    if (!isAgentCapability(capability)) fail(`unknown capability: ${String(capability)}`);
  }
  const capabilities = uniqueCapabilities([...requestedCapabilities]);
  validateAgentProfile(request.kind, authority, capabilities);

  if (request.parent !== undefined) {
    assertAuthorityAttenuation(authority, request.parent.authority);
    assertCapabilityAttenuation(capabilities, request.parent.capabilities);
  }

  const workspace = buildWorkspace(request.workspace, request.kind);
  const processSpec = buildProcess(request.process, platform);
  const network = buildNetwork(request.network);
  const env = buildEnv(request.env);
  const mcpServerIds = uniqueStrings(request.mcpServerIds ?? [], "mcpServerIds");
  const maxDepth = request.maxDepth ?? (request.kind === "main" ? 1 : 0);

  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    fail("maxDepth must be a non-negative safe integer");
  }
  if (hasCapability(capabilities, "agent.spawn") && maxDepth === 0) {
    fail("the agent.spawn capability requires maxDepth > 0");
  }
  if (mcpServerIds.length > 0 && !hasCapability(capabilities, "mcp.use")) {
    fail("non-empty mcpServerIds requires the mcp.use capability");
  }

  validateCapabilityWorkspace(capabilities, workspace);
  validateProcessCapability(capabilities, processSpec);
  validateNetworkCapability(capabilities, network);
  validateEnv(env);

  return Object.freeze({
    agentId,
    kind: request.kind,
    authority,
    workspace,
    process: processSpec,
    network,
    env,
    capabilities: Object.freeze(capabilities),
    mcpServerIds: Object.freeze(mcpServerIds),
    maxDepth,
    controlChannel: "supervisor-ipc",
  });
}
