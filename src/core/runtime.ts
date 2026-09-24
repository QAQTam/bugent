/**
 * SessionRuntime —— 一个 session 的隔离边界。
 *
 * 同一进程里可以存在多个 runtime；它们共享 provider client 和 SQLite 连接，
 * 但绝不共享可变的权限档位、sandbox runner、audit 或 abort 状态。
 */

import type { AgentSession } from "./session.ts";
import type { PermissionGate } from "../permission/gate.ts";
import type { PermissionRequest } from "../permission/policy.ts";
import type { SandboxMode } from "../permission/mode.ts";
import type { ToolRegistry } from "../tools/types.ts";
import type { AuditTrail } from "../store/audit.ts";
import type { ModelClient } from "../provider/types.ts";
import type { PersistedProviderConfig } from "../provider/registry.ts";
import type { SessionStore } from "../store/repository.ts";
import { PermissionGate as Gate } from "../permission/gate.ts";
import { AuditTrail as Audit } from "../store/audit.ts";
import { createDefaultTools } from "../tools/builtin.ts";
import { openSession } from "./open-session.ts";

export class SessionRuntime {
  readonly id: string;
  readonly session: AgentSession;
  readonly tools: ToolRegistry;
  readonly gate: PermissionGate;
  readonly sandboxNote: string;
  readonly audit: AuditTrail | undefined;
  readonly providerId: string;

  constructor(options: {
    session: AgentSession;
    tools: ToolRegistry;
    gate: PermissionGate;
    sandboxNote: string;
    audit: AuditTrail | undefined;
    providerId: string;
  }) {
    this.id = options.session.id;
    this.session = options.session;
    this.tools = options.tools;
    this.gate = options.gate;
    this.sandboxNote = options.sandboxNote;
    this.audit = options.audit;
    this.providerId = options.providerId;
  }

  /** 当前权限档位；直接跟随 gate，避免 runtime.mode 与 gate.mode 分叉。 */
  get mode(): SandboxMode {
    return this.gate.mode;
  }
}

/** runtime 只需要这两个权限交互入口；TUI 会提供更完整的 interaction。 */
export interface SessionInteraction {
  askPermission(request: PermissionRequest): Promise<boolean>;
  confirmModeChange(request: PermissionRequest, needed: SandboxMode): Promise<boolean>;
}

export interface CreateSessionRuntimeOptions {
  sessionId: string;
  /** 指定恢复/切换到的分支；省略时沿用 session.activeBranchId。 */
  branchId?: string;
  client: ModelClient;
  model: string;
  providerId: string;
  /** 非敏感 provider 配置覆盖；API key 不在这里。 */
  providerConfig?: PersistedProviderConfig;
  systemPrompt: string;
  mcpManifest?: string;
  skillsManifest?: string;
  cwd: string;
  store: SessionStore | undefined;
  /** 省略时沿用该 session 已保存的档位，再退回 workspace-write。 */
  mode?: SandboxMode;
  writablePaths?: readonly string[];
  passEnv?: readonly string[];
  policy: import("../permission/policy.ts").PermissionPolicy;
  interaction: SessionInteraction;
}

/**
 * 创建一个 session 独占的 runtime。
 *
 * 每次调用都新建 ToolRegistry、PermissionGate、sandbox runner 和 AuditTrail；
 * 这是避免 `/new` 或多 session daemon 互相污染的关键。
 */
export function createSessionRuntime(options: CreateSessionRuntimeOptions): SessionRuntime {
  const mode =
    options.mode ??
    options.store?.getSession(options.sessionId)?.sandboxMode ??
    "workspace-write";

  const session = openSession({
    store: options.store,
    sessionId: options.sessionId,
    ...(options.branchId !== undefined ? { branchId: options.branchId } : {}),
    client: options.client,
    model: options.model,
    providerId: options.providerId,
    systemPrompt: options.systemPrompt,
    ...(options.mcpManifest !== undefined ? { mcpManifest: options.mcpManifest } : {}),
    ...(options.skillsManifest !== undefined ? { skillsManifest: options.skillsManifest } : {}),
    cwd: options.cwd,
  });

  // 第一次创建或用户主动切换后，都把 effective mode 写回 session 记录。
  options.store?.setSandboxMode(options.sessionId, mode);
  options.store?.setModelProvider(options.sessionId, options.model, options.providerId);
  if (options.providerConfig !== undefined) {
    options.store?.setProviderConfig(options.sessionId, options.providerConfig);
  }

  const setup = createDefaultTools({
    mode,
    ...(options.writablePaths !== undefined ? { writablePaths: options.writablePaths } : {}),
    ...(options.passEnv !== undefined ? { passEnv: options.passEnv } : {}),
  });

  const audit =
    options.store === undefined
      ? undefined
      : new Audit({
          store: options.store,
          sessionId: () => session.id,
          turn: () => session.turn,
        });

  const gate = new Gate({
    policy: options.policy,
    mode: setup.mode,
    prompter: { ask: (request) => options.interaction.askPermission(request) },
    ...(audit !== undefined ? { onDecision: (decision) => audit.permission(decision) } : {}),
    onEscalate: async (request, needed) =>
      (await options.interaction.confirmModeChange(request, needed)) ? needed : undefined,
  });
  setup.registry.setGate(gate);

  return new SessionRuntime({
    session,
    tools: setup.registry,
    gate,
    sandboxNote: setup.sandbox.note,
    audit,
    providerId: options.providerId,
  });
}
