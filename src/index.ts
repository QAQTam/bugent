#!/usr/bin/env bun
/**
 * bugent CLI 入口。
 *
 * 三种模式：
 *   - 一次性：`bugent -p "你好"`
 *   - TUI：`bugent`（默认，需要 TTY）
 *   - 纯文本 REPL：`bugent --plain`
 *
 * `--mock` 不需要网络和密钥，用来验证链路。
 */

import { createInterface } from "node:readline/promises";
import { combineHooks, runUserTurn, type LoopHooks, type TurnResult } from "./core/loop.ts";
import { ProviderRegistry, parseModelRef, type PersistedProviderConfig } from "./provider/registry.ts";
import { createDefaultTools } from "./tools/builtin.ts";
import { loadConfig } from "./config/load.ts";
import { loadSystemPrompt } from "./config/system-prompt.ts";
import type { BugentConfig } from "./config/schema.ts";
import { TuiApp, type RuntimeRequest, type TuiInteraction } from "./tui/app.ts";
import { openSession } from "./core/open-session.ts";
import { createSessionRuntime, syncMcpManifest, syncSkillManifest, type SessionRuntime } from "./core/runtime.ts";
import type { AgentSession } from "./core/session.ts";
import { startConfiguredMcp } from "./mcp/runtime.ts";
import type { McpManager } from "./mcp/manager.ts";
import { startConfiguredSkills } from "./skills/runtime.ts";
import type { SkillManager } from "./skills/manager.ts";
import { BranchService } from "./core/branch-service.ts";
import { PermissionGate, type GateDecision } from "./permission/gate.ts";
import { StdinPrompter } from "./permission/prompt.ts";
import { isSandboxMode, type SandboxMode } from "./permission/mode.ts";
import type { CapabilityEscalation } from "./tools/types.ts";
import type { AskUserAnswer, AskUserQuestion } from "./tui/ask-user.ts";
import {
  ALLOW_ALL_POLICY,
  composePolicy,
  PermissionPolicy,
} from "./permission/policy.ts";
import { AuditTrail } from "./store/audit.ts";
import { defaultDatabasePath, SessionStore } from "./store/repository.ts";
import { GoalRepository } from "./store/goal-repository.ts";
import { GoalController } from "./goal/controller.ts";
import { createReadOnlyReviewRunner } from "./goal/review.ts";
import { defaultHandoffRoot } from "./goal/handoff.ts";
import { createGoalTools } from "./tools/goal.ts";
import { createCredentialStore } from "./store/credentials.ts";
import { newSessionId } from "./util/id.ts";
import { BUGENT_VERSION } from "./version.ts";
import { prepareStandaloneRuntime } from "./runtime/standalone.ts";

interface CliOptions {
  prompt?: string;
  model?: string;
  mock: boolean;
  cwd: string;
  maxSteps?: number;
  help: boolean;
  version: boolean;
  plain: boolean;
  /** 跳过所有权限确认。 */
  yes: boolean;
  /** 沙箱档位。 */
  mode?: SandboxMode;
  noSandbox: boolean;
  allowNetwork: boolean;
  /** 关闭落盘。 */
  noPersist: boolean;
  /** 恢复指定会话。 */
  resume?: string;
  /** 只列出会话后退出。 */
  sessions: boolean;
}

const HELP = `bugent — 终端里的 AI agent

用法：
  bugent                     交互式对话（TUI）
  bugent -p "写个 hello"      一次性执行

选项：
  -v, --version              显示版本
  -p, --prompt <text>        一次性执行给定提示词
  -m, --model <ref>          指定模型，格式 provider/model
      --mock                 使用内置 mock provider（无需网络与密钥）
      --plain                不使用 TUI，退回纯文本 REPL
      --yes                  跳过权限确认（危险）
      --mode <mode>          沙箱档位：read-only | workspace-write | no-sandbox
                             默认 workspace-write
      --no-sandbox           等价于 --mode no-sandbox
      --allow-network        一开始就允许联网（默认断网，失败时按次询问）
      --resume <id>          恢复指定会话
      --sessions             列出已保存的会话后退出
      --no-persist           不落盘（会话不写入 SQLite）
      --cwd <dir>            工作目录
      --max-steps <n>        单轮最大工具往返次数（默认 800）
  -h, --help                 显示帮助

TUI 内：
  Enter             发送消息
  Ctrl+J / Alt+Enter 输入换行
  /                 打开命令菜单
  /context          查看当前 session 的 provider / model / sandbox
  /goal <目标>      初始化 Goal Contract
  /goal status      查看当前 Goal
  /goal checkpoints 查看 Checkpoint 进度
  /goal continue    生成 Handoff snapshot 并切换到新 Context Epoch
  /goal finalize    执行最终完成审计
  /goal pause       暂停 Goal
  /goal resume      恢复 Goal
  /goal edit        编辑未进入 planning 的 Goal Contract
  /goal clear       清除 Goal 聚合（保留对话）
  /mode <mode>      切换当前 session 的沙箱档位
  /new              新建会话
  /exit             退出
`;

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mock: false,
    cwd: process.cwd(),
    help: false,
    version: false,
    plain: false,
    yes: false,
    noSandbox: false,
    allowNetwork: false,
    noPersist: false,
    sessions: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "-p":
      case "--prompt": {
        const value = argv[++i];
        if (value === undefined) throw new Error(`${arg} 需要一个值`);
        options.prompt = value;
        break;
      }
      case "-m":
      case "--model": {
        const value = argv[++i];
        if (value === undefined) throw new Error(`${arg} 需要一个值`);
        options.model = value;
        break;
      }
      case "--cwd": {
        const value = argv[++i];
        if (value === undefined) throw new Error(`${arg} 需要一个值`);
        options.cwd = value;
        break;
      }
      case "--max-steps": {
        const value = argv[++i];
        if (value === undefined) throw new Error(`${arg} 需要一个值`);
        options.maxSteps = Number.parseInt(value, 10);
        break;
      }
      case "--mock":
        options.mock = true;
        break;
      case "--plain":
        options.plain = true;
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      case "--no-sandbox":
        options.noSandbox = true;
        break;
      case "--mode": {
        const value = argv[++i];
        if (value === undefined) throw new Error(`${arg} 需要一个值`);
        if (!isSandboxMode(value)) {
          throw new Error(`未知档位 "${value}"，可选：read-only / workspace-write / no-sandbox`);
        }
        options.mode = value;
        break;
      }
      case "--allow-network":
        options.allowNetwork = true;
        break;
      case "--no-persist":
        options.noPersist = true;
        break;
      case "--sessions":
        options.sessions = true;
        break;
      case "--resume": {
        const value = argv[++i];
        if (value === undefined) throw new Error(`${arg} 需要一个值`);
        options.resume = value;
        break;
      }
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}（用 --help 查看用法）`);
    }
  }

  return options;
}

async function buildRegistry(
  options: CliOptions,
  config: BugentConfig,
): Promise<{ registry: ProviderRegistry; model: string }> {
  const registry = new ProviderRegistry();
  for (const provider of config.providers) registry.register(provider);
  if (options.mock) registry.register({ id: "mock", endpoint: "mock" });

  const model = options.model ?? (options.mock ? "mock/echo" : config.defaultModel);
  parseModelRef(model); // 提前校验格式，报错更友好
  return { registry, model };
}

function createHooks(
  requestCapability?: (escalation: CapabilityEscalation) => Promise<boolean>,
): LoopHooks {
  let wroteAnything = false;
  return {
    onText(delta) {
      wroteAnything = true;
      process.stdout.write(delta);
    },
    onToolCall(call) {
      process.stdout.write(`\n\x1b[36m[tool] ${call.name} ${JSON.stringify(call.args)}\x1b[0m\n`);
    },
    onToolResult(_call, result) {
      const color = result.ok ? "32" : "31";
      const preview = result.output.length > 500 ? `${result.output.slice(0, 500)}…` : result.output;
      process.stdout.write(`\x1b[${color}m${preview}\x1b[0m\n`);
    },
    ...(requestCapability !== undefined ? { onRequestCapability: (_call, esc) => requestCapability(esc) } : {}),
    onUsage(usage) {
      if (!wroteAnything) return;
      process.stdout.write(
        `\n\x1b[90m[tokens] in=${usage.input} out=${usage.output}${usage.cached !== undefined ? ` cached=${usage.cached}` : ""}\x1b[0m\n`,
      );
    },
  };
}

/* ------------------------------ 会话持久化 ------------------------------ */

function listSessions(store: SessionStore | undefined): void {
  if (store === undefined) {
    process.stdout.write("未启用持久化（--no-persist），没有已保存的会话。\n");
    return;
  }

  const sessions = store.listSessions(50);
  if (sessions.length === 0) {
    process.stdout.write("还没有任何会话。\n");
    return;
  }

  process.stdout.write("已保存的会话（最近更新在前）：\n");
  for (const session of sessions) {
    const when = new Date(session.updatedAt).toLocaleString();
    const count = store.countMessages(session.id);
    process.stdout.write(`  ${session.id}  ${when}  ${count} 条消息  ${session.model}\n`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.version) {
    process.stdout.write(`bugent ${BUGENT_VERSION}\n`);
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  await prepareStandaloneRuntime();

  // 配置只加载一次：loadConfig 在缺失时会生成 ~/.bugent/config.toml，
  // 重复调用会产生"到底建了几次"的困惑
  const loaded = await loadConfig({ cwd: options.cwd });
  const config = loaded.config;

  const { registry, model } = await buildRegistry(options, config);
  const ref = parseModelRef(model);
  const loadedSystemPrompt = await loadSystemPrompt({
    cwd: options.cwd,
    ...(config.agent?.systemPromptFile !== undefined
      ? { file: config.agent.systemPromptFile }
      : {}),
  });
  const systemPrompt = loadedSystemPrompt.text;

  /* ----------------------- 持久化（Phase 10） ----------------------- */

  const store = options.noPersist
    ? undefined
    : new SessionStore({ path: defaultDatabasePath() });

  if (options.sessions) {
    listSessions(store);
    store?.close();
    return;
  }

  const sessionId = options.resume ?? newSessionId();
  if (options.resume !== undefined && store !== undefined && !store.hasSession(sessionId)) {
    const known = store.listSessions(10);
    store.close();
    throw new Error(
      `找不到会话 "${sessionId}"。最近会话：\n${
        known.map((s) => `  ${s.id}  ${new Date(s.updatedAt).toLocaleString()}`).join("\n") || "  (无)"
      }`,
    );
  }

  // 恢复已有 session 时，provider/model/providerConfig 以 session 记录为准。
  const storedSession = store?.getSession(sessionId);
  const effectiveProviderId = storedSession?.providerId ?? ref.provider;
  const effectiveModel = storedSession?.model ?? ref.model;
  const effectiveProviderConfig = storedSession?.providerConfig;
  const configuredMcpServerIds = config.mcp?.servers?.map((server) => server.id) ?? [];
  const initialMcpServerIds =
    storedSession !== undefined && store !== undefined
      ? store.enabledMcpServerIds(sessionId, configuredMcpServerIds)
      : configuredMcpServerIds;
  const credentials = createCredentialStore();
  const storedApiKey = await credentials.get(sessionId, effectiveProviderId);
  const client = registry.resolve(
    { provider: effectiveProviderId, model: effectiveModel },
    {
      ...(effectiveProviderConfig ?? {}),
      ...(storedApiKey !== undefined ? { apiKey: storedApiKey } : {}),
    },
  );
  const reviewRef = config.goals?.reviewModel
    ? parseModelRef(config.goals.reviewModel)
    : undefined;
  const reviewClient =
    reviewRef === undefined
      ? client
      : registry.resolve(
          reviewRef,
          reviewRef.provider === effectiveProviderId
            ? {
                ...(effectiveProviderConfig ?? {}),
                ...(storedApiKey !== undefined ? { apiKey: storedApiKey } : {}),
              }
            : {},
        );
  const reviewModel = reviewRef?.model ?? effectiveModel;

  let activeSession: AgentSession | undefined;
  let mcpManagerRef: McpManager | undefined;
  let lastMcpManifest: string | undefined;
  let lastSkillsManifest: string | undefined;
  let activeMcpServerIds: readonly string[] = initialMcpServerIds;
  let mcpChangePending = false;
  const flushMcpChanges = (): void => {
    const manager = mcpManagerRef;
    const session = activeSession;
    if (!mcpChangePending || manager === undefined || session === undefined) return;
    const current = manager.manifest(activeMcpServerIds);
    const previous = lastMcpManifest ?? current;
    const delta = manager.deltaFrom(previous, activeMcpServerIds);
    if (delta !== undefined && current !== previous) {
      session.enqueueInjection(delta, "mcp");
    }
    lastMcpManifest = current;
    mcpChangePending = false;
  };

  const startedMcp = await startConfiguredMcp({
    config: config.mcp,
    cwd: options.cwd,
    onToolsChanged: () => {
      mcpChangePending = true;
      flushMcpChanges();
    },
  });
  mcpManagerRef = startedMcp.manager;
  const initialMcpManifest =
    startedMcp.manager?.manifest(initialMcpServerIds) ?? startedMcp.manifest;
  lastMcpManifest = startedMcp.manager?.manifest(initialMcpServerIds);
  if (startedMcp.disabledReason !== undefined) {
    process.stderr.write(`${startedMcp.disabledReason}\n`);
  }

  const startedSkills = await startConfiguredSkills({
    config: config.skills,
    cwd: options.cwd,
  });
  lastSkillsManifest = startedSkills.manifest;

  const session = openSession({
    store,
    sessionId,
    client,
    model: effectiveModel,
    providerId: effectiveProviderId,
    systemPrompt,
    ...(initialMcpManifest !== undefined ? { mcpManifest: initialMcpManifest } : {}),
    skillsManifest: startedSkills.manifest,
    cwd: options.cwd,
  });
  activeSession = session;
  if (startedMcp.manager !== undefined) {
    syncMcpManifest(session, startedMcp.manager, initialMcpManifest, initialMcpServerIds);
    lastMcpManifest = startedMcp.manager.manifest(initialMcpServerIds);
    flushMcpChanges();
  }
  syncSkillManifest(session, startedSkills.manager, startedSkills.manifest);

  // 档位：CLI > 配置 > 默认 workspace-write
  const mode: SandboxMode =
    options.mode ?? (options.noSandbox ? "no-sandbox" : undefined) ?? config.sandbox?.mode ?? "workspace-write";

  const goalController =
    store === undefined
      ? undefined
      : new GoalController({
          repository: new GoalRepository(store.db),
          session,
          store,
          cwd: options.cwd,
          handoffRoot: defaultHandoffRoot(),
          ...(config.goals?.reviewPolicy !== undefined
            ? { defaultReviewPolicy: config.goals.reviewPolicy }
            : {}),
          ...(config.goals?.maxGoalTokenBudget !== undefined
            ? { maxTokenBudget: config.goals.maxGoalTokenBudget }
            : {}),
          ...(config.goals?.contextRefresh !== undefined
            ? { contextRefresh: config.goals.contextRefresh }
            : {}),
          reviewRunner: createReadOnlyReviewRunner({
            client: reviewClient,
            model: reviewModel,
            cwd: options.cwd,
          }),
        });
  goalController?.ensureContext();

  const tools = createDefaultTools({
    mode,
    ...(config.sandbox?.writablePaths !== undefined
      ? { writablePaths: config.sandbox.writablePaths }
      : {}),
    ...(config.sandbox?.passEnv !== undefined ? { passEnv: config.sandbox.passEnv } : {}),
    ...(goalController !== undefined ? { goalController } : {}),
  });
  if (goalController !== undefined) {
    for (const tool of createGoalTools(goalController)) tools.registry.register(tool);
  }
  const initialMcpTools =
    startedMcp.manager?.attach(tools.registry, initialMcpServerIds) ?? [];
  const initialSkillTools = startedSkills.manager.attach(tools.registry);

  // 权限：--yes 全放行；否则用户规则优先，工具自报的默认规则兜底
  const policy = new PermissionPolicy(
    options.yes
      ? ALLOW_ALL_POLICY
      : composePolicy(config.permissions, tools.registry.defaultPermissionRules()),
  );

  // 审计流水：工具调用、权限决策、每轮起止，全部落盘可回放
  // 用 activeSession 而非固定 session —— 用户 /new 换会话后审计要跟着切
  const audit =
    store === undefined
      ? undefined
      : new AuditTrail({
          store,
          sessionId: () => activeSession!.id,
          turn: () => activeSession!.turn,
        });

  // 能力授权（联网）的交互入口在两条路径下不同：TUI 用弹窗，CLI 用 stdin。
  // 用一个可变引用让 hooks 在分支确定后再拿到真正的实现。
  let capabilityHandler: ((escalation: CapabilityEscalation) => Promise<boolean>) | undefined;
  // ask_user 是纯交互式功能：TUI 里用多页表单实现，
  // 非 TUI 路径不提供 —— 工具会据此明确告知模型"没有界面，请自行判断"
  let askUserHandler:
    | ((questions: readonly AskUserQuestion[]) => Promise<AskUserAnswer[] | undefined>)
    | undefined;
  const hooks = combineHooks(
    {
      ...createHooks((escalation) =>
        capabilityHandler === undefined ? Promise.resolve(false) : capabilityHandler(escalation),
      ),
      onAskUser: async (_call, questions) =>
        askUserHandler === undefined ? undefined : askUserHandler(questions),
    },
    audit?.hooks(),
  );
  const signal = new AbortController().signal;
  const baseOptions = {
    tools: tools.registry,
    hooks,
    cwd: options.cwd,
    signal,
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
  };

  const run = async (input: string): Promise<TurnResult> => {
    audit?.turnStart();
    try {
      const result = await runUserTurn(session, input, baseOptions);
      audit?.turnEnd({ steps: result.steps, reason: result.reason });
      return result;
    } catch (error) {
      audit?.error(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  const onDecision =
    audit === undefined ? undefined : (decision: GateDecision) => audit.permission(decision);

  try {
    // 交互式：优先 TUI（需要 TTY），否则退回纯文本 REPL
    if (options.prompt === undefined && !options.plain && process.stdout.isTTY) {
      const app = new TuiApp({
        session,
        tools: tools.registry,
        cwd: options.cwd,
        providerId: effectiveProviderId,
        providers: registry.list().map((provider) => provider.id),
        providerConfigs: store?.listProviderConfigs(sessionId) ?? [],
        ...(effectiveProviderConfig !== undefined ? { providerConfig: effectiveProviderConfig } : {}),
        ...(storedApiKey !== undefined ? { apiKey: storedApiKey } : {}),
        loadApiKey: (sessionId: string, providerId: string) => credentials.get(sessionId, providerId),
        saveApiKey: (sessionId: string, providerId: string, secret: string) =>
          credentials.set(sessionId, providerId, secret),
        deleteApiKey: (sessionId: string, providerId: string) =>
          credentials.delete(sessionId, providerId),
        mode: tools.mode,
        ...(goalController !== undefined ? { goalController } : {}),
        goalAutoContinue:
          (config.goals?.enabled ?? true) && (config.goals?.autoContinue ?? false),
        ...(config.goals?.maxConsecutiveTurns !== undefined
          ? { maxGoalContinuationTurns: config.goals.maxConsecutiveTurns }
          : {}),
        ...(startedMcp.manager !== undefined
          ? { mcp: startedMcp.manager.status(initialMcpServerIds) }
          : startedMcp.disabledReason !== undefined
            ? { mcp: { servers: [], disabledReason: startedMcp.disabledReason } }
            : {}),
        skillStatus: startedSkills.manager.status(),
        reloadSkills: async () => {
          await startedSkills.manager.reload();
          const current = startedSkills.manager.manifest();
          const previous = lastSkillsManifest ?? current;
          const delta = startedSkills.manager.deltaFrom(previous);
          if (delta !== undefined && activeSession !== undefined) {
            activeSession.enqueueInjection(delta, "skill");
          }
          lastSkillsManifest = current;
          return startedSkills.manager.status();
        },
        ...(configuredMcpServerIds.length > 0
          ? {
              mcpServers: configuredMcpServerIds.map((id) => ({
                id,
                enabled: initialMcpServerIds.includes(id),
              })),
            }
          : {}),
        ...(startedMcp.manager !== undefined
          ? { reloadMcp: (id: string) => startedMcp.manager!.reload(id).then(() => undefined) }
          : {}),
        banner: [
          `**bugent** 已就绪 · \`${client.id}\``,
          "",
          `会话：\`${sessionId}\`${store === undefined ? "（未持久化）" : ""}`,
          `档位：**${tools.mode}** · ${tools.sandbox.note}`,
          ...(startedMcp.manager !== undefined
            ? [`MCP：**${initialMcpTools.length}** 个工具 · Linux 原生沙箱`]
            : startedMcp.disabledReason !== undefined
              ? [`MCP：${startedMcp.disabledReason}`]
              : []),
          `Skills：**${initialSkillTools.length}** 个可按需加载`,
          `权限：${
            options.yes
              ? "**已跳过所有确认（--yes）**"
              : `${policy.ruleCount} 条规则${policy.ruleCount === 0 ? "（放行交给档位判断）" : ""}`
          }`,
          "",
          "输入消息开始对话；输入 / 查看命令；`/context` 查看当前 session 配置；Enter 发送，Ctrl+J / Alt+Enter 换行；运行中按 `ESC` 中断。",
          "右键消息可撤回 / 分叉 / 重试（原分支会保留）。",
        ].join("\n"),
        ...(audit !== undefined ? { audit } : {}),
        ...(store === undefined
          ? {}
          : {
              branchService: new BranchService(store),
              saveProviderConfig: (sessionId: string, config: PersistedProviderConfig) =>
                store.setProviderConfig(sessionId, config),
              deleteProviderConfig: (sessionId: string, providerId: string) =>
                store.deleteProviderConfig(sessionId, providerId),
              createRuntime: (
                interaction: TuiInteraction,
                request?: RuntimeRequest,
              ): SessionRuntime => {
                const targetSessionId = request?.sessionId ?? newSessionId();
                const existing = store.getSession(targetSessionId);
                const runtimeMode = request?.mode ?? existing?.sandboxMode ?? mode;
                const fallbackProviderId = request?.sessionId === undefined ? ref.provider : effectiveProviderId;
                const fallbackModel = request?.sessionId === undefined ? ref.model : effectiveModel;
                const fallbackProviderConfig =
                  request?.sessionId === undefined ? undefined : effectiveProviderConfig;
                const providerId = request?.providerId ?? existing?.providerId ?? fallbackProviderId;
                const model = request?.model ?? existing?.model ?? fallbackModel;
                const providerConfig =
                  request?.providerConfig ?? existing?.providerConfig ?? fallbackProviderConfig;
                const configuredMcpIds = new Set(configuredMcpServerIds);
                const requestedMcpIds =
                  request?.mcpServerIds === undefined
                    ? undefined
                    : request.mcpServerIds.filter((id) => configuredMcpIds.has(id));
                const targetMcpServerIds =
                  requestedMcpIds ??
                  (existing !== undefined
                    ? store.enabledMcpServerIds(targetSessionId, configuredMcpServerIds)
                    : configuredMcpServerIds);
                if (requestedMcpIds !== undefined) {
                  const selected = new Set(requestedMcpIds);
                  for (const id of configuredMcpServerIds) {
                    store.setMcpServerEnabled(targetSessionId, id, selected.has(id));
                  }
                }
                const client = registry.resolve(
                  { provider: providerId, model },
                  {
                    ...(providerConfig ?? {}),
                    ...(request?.apiKey !== undefined ? { apiKey: request.apiKey } : {}),
                  },
                );
                const runtimeReviewRef =
                  config.goals?.reviewModel === undefined
                    ? undefined
                    : parseModelRef(config.goals.reviewModel);
                const runtimeReviewClient =
                  runtimeReviewRef === undefined
                    ? client
                    : registry.resolve(
                        runtimeReviewRef,
                        runtimeReviewRef.provider === providerId
                          ? {
                              ...(providerConfig ?? {}),
                              ...(request?.apiKey !== undefined
                                ? { apiKey: request.apiKey }
                                : {}),
                            }
                          : {},
                      );
                const runtime = createSessionRuntime({
                  sessionId: targetSessionId,
                  ...(request?.branchId !== undefined ? { branchId: request.branchId } : {}),
                  client,
                  model,
                  providerId,
                  ...(providerConfig !== undefined ? { providerConfig } : {}),
                  systemPrompt,
                  ...(startedMcp.manager !== undefined
                    ? { mcpManager: startedMcp.manager }
                    : {}),
                  mcpServerIds: targetMcpServerIds,
                  skillManager: startedSkills.manager,
                  cwd: options.cwd,
                  store,
                  ...(config.goals?.reviewPolicy !== undefined
                    ? { goalDefaultReviewPolicy: config.goals.reviewPolicy }
                    : {}),
                  ...(config.goals?.maxGoalTokenBudget !== undefined
                    ? { maxGoalTokenBudget: config.goals.maxGoalTokenBudget }
                    : {}),
                  ...(config.goals?.contextRefresh !== undefined
                    ? { goalContextRefresh: config.goals.contextRefresh }
                    : {}),
                  goalReviewClient: runtimeReviewClient,
                  goalReviewModel: runtimeReviewRef?.model ?? model,
                  mode: runtimeMode,
                  ...(config.sandbox?.writablePaths !== undefined
                    ? { writablePaths: config.sandbox.writablePaths }
                    : {}),
                  ...(config.sandbox?.passEnv !== undefined
                    ? { passEnv: config.sandbox.passEnv }
                    : {}),
                  policy,
                  interaction,
                });
                activeSession = runtime.session;
                activeMcpServerIds = targetMcpServerIds;
                lastMcpManifest = startedMcp.manager?.manifest(targetMcpServerIds);
                flushMcpChanges();
                return runtime;
              },
            }),
      });

      // TUI 自己就是交互入口：权限确认、能力授权、升档询问都走它的对话框
      tools.registry.setGate(
        new PermissionGate({
          policy,
          mode: tools.mode,
          prompter: { ask: (request) => app.askPermission(request) },
          ...(onDecision !== undefined ? { onDecision } : {}),
          onEscalate: async (request, needed) =>
            (await app.confirmModeChange(request, needed)) ? needed : undefined,
        }),
      );
      capabilityHandler = (escalation) => app.requestCapability(escalation);
      askUserHandler = (questions) => app.askUser(questions);
      await app.run();
      return;
    }

    // 非 TUI 路径：权限确认与能力授权都走 stdin
    const prompter = new StdinPrompter();
    capabilityHandler = (escalation) => prompter.confirmCapability(escalation);
    tools.registry.setGate(
      new PermissionGate({
        policy,
        mode: tools.mode,
        prompter,
        ...(onDecision !== undefined ? { onDecision } : {}),
      }),
    );

    try {
      if (options.prompt !== undefined) {
        const result = await run(options.prompt);
        if (result.text.length > 0) process.stdout.write("\n");
        return;
      }

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      process.stdout.write(
        `bugent · ${client.id} · 会话 ${sessionId} · ${tools.sandbox.note} · /exit 退出\n`,
      );
      try {
        for (;;) {
          const line = (await rl.question("\x1b[1m> \x1b[0m")).trim();
          if (line.length === 0) continue;
          if (line === "/exit" || line === "/quit") break;
          await run(line);
          process.stdout.write("\n");
        }
      } finally {
        rl.close();
      }
    } finally {
      prompter.close();
    }
  } finally {
    await startedMcp.manager?.close();
    store?.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m\n`);
    process.exit(1);
  });
}
