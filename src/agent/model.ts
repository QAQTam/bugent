/**
 * Agent domain model — P7-A.
 *
 * AgentKind is a product profile; it is deliberately not an API message role.
 * Authority is a coarse upper bound, while capabilities are the concrete
 * grants inherited by a subagent. The compiler in `sandbox.ts` is the only
 * place that turns both into an executable sandbox specification.
 */

export const AGENT_KINDS = ["main", "reviewer", "explorer", "worker", "integrator"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const AGENT_AUTHORITIES = [
  "none",
  "read-only",
  "workspace-write",
  "full",
] as const;
export type AgentAuthority = (typeof AGENT_AUTHORITIES)[number];

export const AGENT_CAPABILITIES = [
  "fs.read",
  "fs.write",
  "process.exec",
  "network",
  "mcp.use",
  "agent.spawn",
  "goal.read",
  "goal.write",
  "review.write",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export const AGENT_STATUSES = [
  "starting",
  "running",
  "waiting_input",
  "idle",
  "completed",
  "blocked",
  "error",
  "aborted",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export type AgentId = string;
export type AgentTaskId = string;
export type AgentEventId = string;
export type AgentMessageId = string;

export interface AgentIdentity {
  readonly agentId: AgentId;
  readonly parentId?: AgentId;
  readonly rootId: AgentId;
  readonly kind: AgentKind;
  readonly displayName?: string;
  readonly sessionId: string;
  readonly branchId?: string;
  readonly goalId?: string;
  readonly checkpointId?: string;
  readonly taskId?: AgentTaskId;
  readonly createdAt: number;
}

export interface AgentBudget {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxWallClockMs: number;
}

export interface AgentArtifactRef {
  readonly artifactId: string;
  readonly kind: string;
  readonly path: string;
  readonly digest: string;
  readonly mediaType?: string;
}

export interface AgentResult {
  readonly agentId: AgentId;
  readonly taskId?: AgentTaskId;
  readonly status: "completed" | "blocked" | "error" | "aborted";
  readonly summary: string;
  readonly artifacts: readonly AgentArtifactRef[];
  readonly data?: unknown;
}

const AUTHORITY_RANK: Readonly<Record<AgentAuthority, number>> = {
  none: 0,
  "read-only": 1,
  "workspace-write": 2,
  full: 3,
};

const MINIMUM_AUTHORITY: Readonly<Record<AgentCapability, AgentAuthority>> = {
  "fs.read": "read-only",
  "fs.write": "workspace-write",
  "process.exec": "read-only",
  network: "workspace-write",
  "mcp.use": "read-only",
  "agent.spawn": "full",
  "goal.read": "read-only",
  "goal.write": "workspace-write",
  "review.write": "read-only",
};

/**
 * Explicit allowlists are intentionally broader than defaults. For example a
 * worker may receive `network` or `agent.spawn` only when its parent grants it;
 * reviewer and explorer can never receive them.
 */
const KIND_ALLOWED_CAPABILITIES: Readonly<Record<AgentKind, readonly AgentCapability[]>> = {
  main: AGENT_CAPABILITIES,
  reviewer: ["fs.read", "process.exec", "mcp.use", "review.write"],
  explorer: ["fs.read", "process.exec", "mcp.use"],
  worker: [
    "fs.read",
    "fs.write",
    "process.exec",
    "network",
    "mcp.use",
    "agent.spawn",
    "goal.read",
  ],
  integrator: [
    "fs.read",
    "fs.write",
    "process.exec",
    "network",
    "mcp.use",
    "agent.spawn",
    "goal.read",
    "goal.write",
  ],
};

const DEFAULT_CAPABILITIES: Readonly<Record<AgentKind, readonly AgentCapability[]>> = {
  main: [
    "fs.read",
    "fs.write",
    "process.exec",
    "mcp.use",
    "agent.spawn",
    "goal.read",
    "goal.write",
  ],
  reviewer: ["fs.read", "process.exec"],
  explorer: ["fs.read", "process.exec"],
  worker: ["fs.read", "fs.write", "process.exec"],
  integrator: ["fs.read", "fs.write", "process.exec"],
};

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}

export function isAgentAuthority(value: unknown): value is AgentAuthority {
  return typeof value === "string" && (AGENT_AUTHORITIES as readonly string[]).includes(value);
}

export function isAgentCapability(value: unknown): value is AgentCapability {
  return typeof value === "string" && (AGENT_CAPABILITIES as readonly string[]).includes(value);
}

export function authorityAtLeast(left: AgentAuthority, right: AgentAuthority): boolean {
  return AUTHORITY_RANK[left] >= AUTHORITY_RANK[right];
}

export function authorityAtMost(left: AgentAuthority, right: AgentAuthority): boolean {
  return AUTHORITY_RANK[left] <= AUTHORITY_RANK[right];
}

export function defaultAuthorityForKind(kind: AgentKind): AgentAuthority {
  return kind === "main" ? "full" : kind === "reviewer" || kind === "explorer"
    ? "read-only"
    : "workspace-write";
}

export function allowedCapabilitiesForKind(kind: AgentKind): readonly AgentCapability[] {
  return KIND_ALLOWED_CAPABILITIES[kind];
}

export function minimumAuthorityForCapability(capability: AgentCapability): AgentAuthority {
  return MINIMUM_AUTHORITY[capability];
}

/**
 * Return the safe defaults for a profile. Defaults are still attenuated by
 * authority and by the platform: non-Linux builds do not silently inherit
 * process execution before a native provider exists.
 */
export function defaultCapabilitiesForKind(
  kind: AgentKind,
  authority: AgentAuthority = defaultAuthorityForKind(kind),
  platform: string = process.platform,
): AgentCapability[] {
  const allowed = new Set(KIND_ALLOWED_CAPABILITIES[kind]);
  return DEFAULT_CAPABILITIES[kind].filter((capability) => {
    if (!allowed.has(capability)) return false;
    if (!authorityAtLeast(authority, MINIMUM_AUTHORITY[capability])) return false;
    if (capability === "process.exec" && platform !== "linux") return false;
    return true;
  });
}

export function hasCapability(
  capabilities: readonly AgentCapability[],
  capability: AgentCapability,
): boolean {
  return capabilities.includes(capability);
}

export function capabilitiesAreSubset(
  child: readonly AgentCapability[],
  parent: readonly AgentCapability[],
): boolean {
  const parentSet = new Set(parent);
  return child.every((capability) => parentSet.has(capability));
}

export function attenuateCapabilities(
  requested: readonly AgentCapability[],
  parent: readonly AgentCapability[],
): AgentCapability[] {
  const parentSet = new Set(parent);
  return uniqueCapabilities(requested).filter((capability) => parentSet.has(capability));
}

export function uniqueCapabilities(
  capabilities: readonly AgentCapability[],
): AgentCapability[] {
  const seen = new Set<AgentCapability>();
  const out: AgentCapability[] = [];
  for (const capability of capabilities) {
    if (!seen.has(capability)) {
      seen.add(capability);
      out.push(capability);
    }
  }
  return out;
}

export function validateAgentProfile(
  kind: AgentKind,
  authority: AgentAuthority,
  capabilities: readonly AgentCapability[],
): void {
  if (authority === "none" && capabilities.length > 0) {
    throw new Error("agent profile: authority none 不能授予任何工具 capability");
  }

  const allowed = new Set(KIND_ALLOWED_CAPABILITIES[kind]);
  for (const capability of capabilities) {
    if (!allowed.has(capability)) {
      throw new Error(`agent profile: ${kind} 不允许 capability ${capability}`);
    }
    if (!authorityAtLeast(authority, MINIMUM_AUTHORITY[capability])) {
      throw new Error(
        `agent profile: authority ${authority} 不足以授予 capability ${capability}`,
      );
    }
  }

  if (hasCapability(capabilities, "review.write") && kind !== "reviewer") {
    throw new Error("agent profile: review.write 只能授予 reviewer");
  }
  if (
    hasCapability(capabilities, "fs.write") &&
    (kind === "reviewer" || kind === "explorer")
  ) {
    throw new Error(`agent profile: ${kind} 永久只读，不能授予 fs.write`);
  }
}

export function assertAuthorityAttenuation(
  child: AgentAuthority,
  parent: AgentAuthority,
): void {
  if (!authorityAtMost(child, parent)) {
    throw new Error(`agent profile: 子代理 authority ${child} 超过父代理 ${parent}`);
  }
}

export function assertCapabilityAttenuation(
  child: readonly AgentCapability[],
  parent: readonly AgentCapability[],
): void {
  const parentSet = new Set(parent);
  const escaped = child.filter((capability) => !parentSet.has(capability));
  if (escaped.length > 0) {
    throw new Error(`agent profile: 子代理 capability 超过父代理：${escaped.join(", ")}`);
  }
}
