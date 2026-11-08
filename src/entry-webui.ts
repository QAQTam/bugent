/**
 * WebUI v2 bridge 入口 —— `bun run src/entry-webui.ts [--port 8787] [--mock]`。
 *
 * 组装（对齐 index.ts 的 TUI 路径）：config -> ProviderRegistry -> 共享
 * MCP/Skill manager -> Bun.serve（同源静态 `webui/dist` + `/ws`）。
 * 每个 `session.new` 走 `createSessionRuntime`（权限档位 / 沙箱 / 审计 /
 * Goal 全部 session 独立），交互（权限确认、升档）经 SessionInteraction
 * 转发到该 session 的 SessionHost → UiEvent。
 *
 * 协议见 docs/webui-v2-protocol-spec.md。认证：token 首帧 hello 携带；
 * token 写 `~/.bugent/webui/<port>.token`（0600）并打印到 stdout。
 *
 * MVP 已知裁剪（后续按 spec 补）：
 *   - MCP/skills 工具目录变化不热刷进已开 session（TUI 的 flushMcpChanges 等价物）；
 *   - 不支持 `--resume`（session.new 只建新会话，恢复走 store 读取待后续命令位）。
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
import type { ProjectConfigConfirm } from "./config/load.ts";
import { loadConfig } from "./config/load.ts";
import { loadSystemPrompt } from "./config/system-prompt.ts";
import { ProviderRegistry, parseModelRef, type PersistedProviderConfig } from "./provider/registry.ts";
import type { BugentConfig } from "./config/schema.ts";
import { createSessionRuntime } from "./core/runtime.ts";
import type { SessionInteraction } from "./core/runtime.ts";
import { startConfiguredMcp } from "./mcp/runtime.ts";
import { startConfiguredSkills } from "./skills/runtime.ts";
import { createDefaultTools } from "./tools/builtin.ts";
import {
  ALLOW_ALL_POLICY,
  composePolicy,
  PermissionPolicy,
  type PermissionRule,
} from "./permission/policy.ts";
import { defaultDatabasePath, SessionStore } from "./store/repository.ts";
import { createCredentialStore } from "./store/credentials.ts";
import { newSessionId } from "./util/id.ts";
import { BUGENT_VERSION } from "./version.ts";
import { prepareStandaloneRuntime } from "./runtime/standalone.ts";
import { WebuiHub } from "./webui/hub.ts";
import type { SessionDelegate } from "./webui/hub.ts";
import { SessionHost } from "./webui/session-host.ts";

const DEFAULT_PORT = 8787;
const HISTORY_TAIL = 200; // spec §7：首屏只给尾部窗口

interface BridgeOptions {
  port: number;
  mock: boolean;
  model?: string;
  yes: boolean;
  noPersist: boolean;
  cwd: string;
}

function parseBridgeArgs(argv: string[]): BridgeOptions {
  const options: BridgeOptions = { port: DEFAULT_PORT, mock: false, yes: false, noPersist: false, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = Number(argv[++i]);
      if (Number.isInteger(value) && value > 0 && value < 65536) options.port = value;
      continue;
    }
    if (arg === "--mock") {
      options.mock = true;
      continue;
    }
    if (arg === "--model") {
      const value = argv[++i];
      if (value !== undefined) options.model = value;
      continue;
    }
    if (arg === "--yes") {
      options.yes = true;
      continue;
    }
    if (arg === "--no-persist") {
      options.noPersist = true;
      continue;
    }
    if (arg === "--cwd") {
      const value = argv[++i];
      if (value !== undefined) options.cwd = resolvePath(value);
      continue;
    }
  }
  return options;
}

function buildRegistry(options: BridgeOptions, config: BugentConfig): {
  registry: ProviderRegistry;
  providerId: string;
  model: string;
  providerConfig?: PersistedProviderConfig;
} {
  const registry = new ProviderRegistry();
  for (const provider of config.providers) registry.register(provider);
  if (options.mock) registry.register({ id: "mock", endpoint: "mock" });

  const providerId = options.mock ? "mock" : config.provider ?? config.providers[0]?.id ?? "openai";
  const model = (options.model ?? (options.mock ? "echo" : config.model)).trim();
  const parsed = model.includes("/") ? parseModelRef(model) : undefined;
  return {
    registry,
    providerId: parsed?.provider ?? providerId,
    model: parsed?.model ?? model,
  };
}

/** 项目级 bugent.config.ts 的执行确认门：bridge 无终端交互，非 --yes 一律拒绝。 */
function bridgeProjectConfigGate(yes: boolean): ProjectConfigConfirm {
  return async ({ path }) => {
    if (yes) return true;
    process.stderr.write(
      `发现项目级配置 ${path} —— bridge 非交互，默认拒绝执行；确认信任请加 --yes。\n`,
    );
    return false;
  };
}

async function writeTokenFile(port: number, token: string): Promise<string> {
  const dir = join(homedir(), ".bugent", "webui");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${port}.token`);
  await Bun.write(path, token, { mode: 0o600 });
  return path;
}

async function main(): Promise<void> {
  const options = parseBridgeArgs(process.argv.slice(2));
  await prepareStandaloneRuntime();

  const loaded = await loadConfig({
    cwd: options.cwd,
    confirmProjectConfig: bridgeProjectConfigGate(options.yes),
  });
  const config = loaded.config;
  const { registry, providerId, model } = buildRegistry(options, config);

  const loadedSystemPrompt = await loadSystemPrompt({
    cwd: options.cwd,
    ...(config.agent?.systemPromptFile !== undefined ? { file: config.agent.systemPromptFile } : {}),
  });

  const store = options.noPersist ? undefined : new SessionStore({ path: defaultDatabasePath() });

  const startedMcp = await startConfiguredMcp({ config: config.mcp, cwd: options.cwd });
  if (startedMcp.disabledReason !== undefined) {
    process.stderr.write(`${startedMcp.disabledReason}\n`);
  }
  const startedSkills = await startConfiguredSkills({ config: config.skills, cwd: options.cwd });

  // 工具自报的默认权限规则是静态的：构造一次性默认工具集取模板，之后每个
  // session 用自己的 PermissionPolicy 实例（"总是允许"绝不跨 session 泄漏）。
  const defaultMode = config.sandbox?.mode ?? "workspace-write";
  const templateRules = createDefaultTools({ mode: defaultMode }).registry.defaultPermissionRules();

  const reviewRef = config.goals?.reviewModel
    ? {
        provider: providerId,
        model: config.goals.reviewModel.includes("/")
          ? parseModelRef(config.goals.reviewModel).model
          : config.goals.reviewModel,
      }
    : undefined;
  const credentials = createCredentialStore();
  const storedApiKey = await credentials.get(`bridge:${providerId}`, providerId);
  const token = Bun.env.BUGENT_WEBUI_TOKEN ?? crypto.randomUUID().replace(/-/g, "");

  const hub = new WebuiHub({
    token,
    historyTail: HISTORY_TAIL,
    sessionFactory: async ({ cwd: sessionCwd }) =>
      createSession(options, config, {
        registry,
        providerId,
        model,
        systemPrompt: loadedSystemPrompt.text,
        store,
        startedMcpManager: startedMcp.manager,
        skillManager: startedSkills.manager,
        templateRules,
        reviewRef,
        reviewClientRef: { provider: providerId, model: reviewRef?.model ?? model },
        storedApiKey,
        hub,
        cwd: sessionCwd ?? options.cwd,
      }),
  });

  /* ------------------------------ 静态托管 ------------------------------ */

  const distDir = resolvePath(import.meta.dir, "..", "webui", "dist");
  const distExists = await Bun.file(join(distDir, "index.html")).exists();

  const serveStatic = async (pathname: string): Promise<Response> => {
    if (!distExists) {
      return new Response(
        "webui/dist 不存在 —— 先 `cd webui && bun run build`，或开发模式用 Vite dev server。\n",
        { status: 404 },
      );
    }
    const relative = pathname === "/" ? "/index.html" : pathname;
    const target = resolvePath(distDir, `.${relative}`);
    if (target !== distDir && !target.startsWith(distDir + sep)) {
      return new Response("forbidden", { status: 403 });
    }
    const file = Bun.file(target);
    if (!(await file.exists())) {
      // SPA fallback：非资产路径都回 index.html
      if (relative.startsWith("/assets/")) return new Response("not found", { status: 404 });
      return new Response(Bun.file(join(distDir, "index.html")));
    }
    return new Response(file);
  };

  const server = Bun.serve({
    port: options.port,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (
          server.upgrade(req, {
            data: { hub, authenticated: false, attached: new Set<string>() },
          })
        ) {
          return; // 升级成功
        }
        return new Response("websocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/healthz") return new Response("ok");
      return serveStatic(url.pathname);
    },
    websocket: hub.websocket,
  });

  const boundPort = server.port ?? options.port;
  const tokenPath = await writeTokenFile(boundPort, token);
  process.stdout.write(
    [
      `bugent bridge v${BUGENT_VERSION} · ws://127.0.0.1:${boundPort}/ws`,
      `token: ${tokenPath}${Bun.env.BUGENT_WEBUI_TOKEN !== undefined ? "（来自 BUGENT_WEBUI_TOKEN）" : ""}`,
      `静态: ${distExists ? distDir : "(未构建 —— 开发模式请用 webui/ 的 Vite dev server)"}`,
      `provider: ${providerId}/${model}${options.mock ? "（mock）" : ""}`,
      "",
    ].join("\n"),
  );

  const shutdown = (): void => {
    hub.stop();
    server.stop(true);
    store?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** 组装一个 session（hub.sessionFactory 的实现）。 */
async function createSession(
  options: BridgeOptions,
  config: BugentConfig,
  context: {
    registry: ProviderRegistry;
    providerId: string;
    model: string;
    systemPrompt: string;
    store: SessionStore | undefined;
    startedMcpManager: Awaited<ReturnType<typeof startConfiguredMcp>>["manager"];
    skillManager: Awaited<ReturnType<typeof startConfiguredSkills>>["manager"];
    templateRules: readonly PermissionRule[];
    reviewRef: { provider: string; model: string } | undefined;
    reviewClientRef: { provider: string; model: string };
    storedApiKey: string | undefined;
    hub: WebuiHub;
    cwd: string;
  },
): Promise<SessionDelegate> {
  const {
    registry,
    providerId,
    model,
    systemPrompt,
    store,
    startedMcpManager,
    skillManager,
    templateRules,
    reviewClientRef,
    storedApiKey,
    hub,
    cwd,
  } = context;

  const client = registry.resolve(
    { provider: providerId, model },
    storedApiKey !== undefined ? { apiKey: storedApiKey } : {},
  );
  const reviewClient = registry.resolve(
    reviewClientRef,
    storedApiKey !== undefined ? { apiKey: storedApiKey } : {},
  );

  // 每个 session 独立 policy：config 规则 + 工具默认，"总是允许"只进本 session
  const policy = new PermissionPolicy(
    options.yes
      ? ALLOW_ALL_POLICY
      : composePolicy(config.permissions, templateRules),
  );

  // 交互转发器：interaction 在 runtime 创建前就得给，host 在其后创建 ——
  // 用可变转发把两段接起来（第一个 turn 发生时 host 一定已就位）。
  let host: SessionHost | undefined;
  const interaction: SessionInteraction = {
    askPermission: (request) => host!.askPermission(request),
    confirmModeChange: (request, needed) => host!.confirmModeChange(request, needed),
  };

  const runtime = createSessionRuntime({
    sessionId: newSessionId(),
    client,
    model,
    providerId,
    systemPrompt,
    ...(startedMcpManager !== undefined ? { mcpManager: startedMcpManager } : {}),
    skillManager,
    cwd,
    store,
    policy,
    interaction,
    ...(config.sandbox?.writablePaths !== undefined ? { writablePaths: config.sandbox.writablePaths } : {}),
    ...(config.sandbox?.allowNetwork === true ? { allowNetwork: true } : {}),
    ...(config.sandbox?.passEnv !== undefined ? { passEnv: config.sandbox.passEnv } : {}),
    ...(config.goals?.reviewPolicy !== undefined
      ? { goalDefaultReviewPolicy: config.goals.reviewPolicy }
      : {}),
    ...(config.goals?.maxGoalTokenBudget !== undefined
      ? { maxGoalTokenBudget: config.goals.maxGoalTokenBudget }
      : {}),
    ...(config.goals?.contextRefresh !== undefined
      ? { goalContextRefresh: config.goals.contextRefresh }
      : {}),
    goalReviewClient: reviewClient,
    goalReviewModel: reviewClientRef.model,
  });

  const sessionHost = new SessionHost({
    runtime,
    cwd,
    historyTail: HISTORY_TAIL,
    policy,
    publish: (event) => hub.publish(runtime.session.id, event),
  });
  host = sessionHost;
  // 登记由 hub.sessionFactory 契约负责（hub 收口 registerSession，避免双重注册）
  return sessionHost;
}

await main();
