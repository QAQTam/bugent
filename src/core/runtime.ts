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
import type { McpManager, McpStatus } from "../mcp/manager.ts";
import type { SkillManager, SkillStatus } from "../skills/manager.ts";
import type { GoalController } from "../goal/controller.ts";
import { PermissionGate as Gate } from "../permission/gate.ts";
import { AuditTrail as Audit } from "../store/audit.ts";
import { GoalRepository } from "../store/goal-repository.ts";
import { GoalController as Goals } from "../goal/controller.ts";
import { createReadOnlyReviewRunner } from "../goal/review.ts";
import { defaultHandoffRoot } from "../goal/handoff.ts";
import { createGoalTools } from "../tools/goal.ts";
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
  readonly mcpTools: readonly string[];
  readonly mcpStatus: McpStatus | undefined;
  readonly skillTools: readonly string[];
  readonly skillStatus: SkillStatus | undefined;
  readonly goalController: GoalController | undefined;
  #dispose: (() => void) | undefined;
  #disposed = false;

  constructor(options: {
    session: AgentSession;
    tools: ToolRegistry;
    gate: PermissionGate;
    sandboxNote: string;
    audit: AuditTrail | undefined;
    providerId: string;
    mcpTools?: readonly string[];
    mcpStatus?: McpStatus;
    skillTools?: readonly string[];
    skillStatus?: SkillStatus;
    goalController?: GoalController;
    dispose?: () => void;
  }) {
    this.id = options.session.id;
    this.session = options.session;
    this.tools = options.tools;
    this.gate = options.gate;
    this.sandboxNote = options.sandboxNote;
    this.audit = options.audit;
    this.providerId = options.providerId;
    this.mcpTools = options.mcpTools ?? [];
    this.mcpStatus = options.mcpStatus;
    this.skillTools = options.skillTools ?? [];
    this.skillStatus = options.skillStatus;
    this.goalController = options.goalController;
    this.#dispose = options.dispose;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#dispose?.();
    this.#dispose = undefined;
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
  /** Process-shared MCP manager. The runtime attaches/detaches its registry. */
  mcpManager?: McpManager;
  /** Session-level MCP server allowlist. Undefined means all configured servers. */
  mcpServerIds?: readonly string[];
  /** Session-level skill manager. The runtime attaches/detaches its registry. */
  skillManager?: SkillManager;
  /** Goal review policy / budget cap for this runtime. */
  goalDefaultReviewPolicy?: import("../goal/types.ts").ReviewPolicy;
  maxGoalTokenBudget?: number;
  goalReviewClient?: ModelClient;
  goalReviewModel?: string;
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
 * Preserve the frozen msgid1 snapshot and append a developer delta when the
 * live MCP catalog differs. Callers must invoke this only outside an open tool
 * batch; enqueueInjection itself also enforces the safe-boundary contract.
 */
export function syncMcpManifest(
  session: AgentSession,
  manager: McpManager,
  currentManifest = manager.manifest(),
  serverIds?: readonly string[],
): void {
  const storedMcpManifest = session.messages.find((message) => message.msgid === 1);
  const storedText =
    storedMcpManifest?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("") ?? "";
  if (storedText.length === 0) return;
  const delta = manager.deltaFrom(storedText, serverIds);
  if (delta !== undefined && currentManifest !== storedText) {
    session.enqueueInjection(delta, "mcp");
  }
}

/**
 * Preserve the frozen msgid2 snapshot and append a developer delta when the
 * live skill catalog differs.
 */
export function syncSkillManifest(
  session: AgentSession,
  manager: SkillManager,
  currentManifest = manager.manifest(),
): void {
  const storedSkillsManifest = session.messages.find((message) => message.msgid === 2);
  const storedText =
    storedSkillsManifest?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("") ?? "";
  if (storedText.length === 0) return;
  const delta = manager.deltaFrom(storedText);
  if (delta !== undefined && currentManifest !== storedText) {
    session.enqueueInjection(delta, "skill");
  }
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
  const mcpManifest =
    options.mcpManifest ?? options.mcpManager?.manifest(options.mcpServerIds);
  const skillsManifest = options.skillsManifest ?? options.skillManager?.manifest();

  const session = openSession({
    store: options.store,
    sessionId: options.sessionId,
    ...(options.branchId !== undefined ? { branchId: options.branchId } : {}),
    client: options.client,
    model: options.model,
    providerId: options.providerId,
    systemPrompt: options.systemPrompt,
    ...(mcpManifest !== undefined ? { mcpManifest } : {}),
    ...(skillsManifest !== undefined ? { skillsManifest } : {}),
    cwd: options.cwd,
  });

  // 第一次创建或用户主动切换后，都把 effective mode 写回 session 记录。
  options.store?.setSandboxMode(options.sessionId, mode);
  options.store?.setModelProvider(options.sessionId, options.model, options.providerId);
  if (options.providerConfig !== undefined) {
    options.store?.setProviderConfig(options.sessionId, options.providerConfig);
  }

  const goalController =
    options.store === undefined
      ? undefined
      : new Goals({
          repository: new GoalRepository(options.store.db),
          session,
          store: options.store,
          cwd: options.cwd,
          handoffRoot: defaultHandoffRoot(),
          ...(options.goalDefaultReviewPolicy !== undefined
            ? { defaultReviewPolicy: options.goalDefaultReviewPolicy }
            : {}),
          ...(options.maxGoalTokenBudget !== undefined
            ? { maxTokenBudget: options.maxGoalTokenBudget }
            : {}),
          reviewRunner: createReadOnlyReviewRunner({
            client: options.goalReviewClient ?? options.client,
            model: options.goalReviewModel ?? options.model,
            cwd: options.cwd,
          }),
        });
  goalController?.ensureContext();

  const setup = createDefaultTools({
    mode,
    ...(options.writablePaths !== undefined ? { writablePaths: options.writablePaths } : {}),
    ...(options.passEnv !== undefined ? { passEnv: options.passEnv } : {}),
    ...(goalController !== undefined ? { goalController } : {}),
  });
  if (goalController !== undefined) {
    for (const tool of createGoalTools(goalController)) setup.registry.register(tool);
  }
  let mcpTools: string[] = [];
  let skillTools: string[] = [];
  try {
    mcpTools = options.mcpManager?.attach(setup.registry, options.mcpServerIds) ?? [];
    skillTools = options.skillManager?.attach(setup.registry) ?? [];
  } catch (error) {
    options.skillManager?.detach(setup.registry);
    options.mcpManager?.detach(setup.registry);
    throw error;
  }

  if (options.mcpManager !== undefined && mcpManifest !== undefined) {
    syncMcpManifest(session, options.mcpManager, mcpManifest, options.mcpServerIds);
  }
  if (options.skillManager !== undefined && skillsManifest !== undefined) {
    syncSkillManifest(session, options.skillManager, skillsManifest);
  }

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
    mcpTools,
    ...(options.mcpManager !== undefined
      ? { mcpStatus: options.mcpManager.status(options.mcpServerIds) }
      : {}),
    skillTools,
    ...(options.skillManager !== undefined
      ? { skillStatus: options.skillManager.status() }
      : {}),
    ...(goalController !== undefined ? { goalController } : {}),
    ...(options.mcpManager !== undefined || options.skillManager !== undefined
      ? {
          dispose: () => {
            options.mcpManager?.detach(setup.registry);
            options.skillManager?.detach(setup.registry);
          },
        }
      : {}),
  });
}
