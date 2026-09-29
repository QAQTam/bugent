/** WebUI 服务入口：`bun run bugent:webui`
 *
 *  一个 Bun 进程同时做两件事（docs/ui-protocol-spec.md §2 + §12）：
 *  1. 启动 headless bridge（WS 协议端点），会话工厂接真实 runtime 装配
 *     （config → provider → default tools → policy → openSession 持久化）；
 *  2. 伺服 webui/dist 的静态页面（token 通过 URL query 交给页面，页面 hello 时携带）。
 *
 *  与 TUI/CLI 的差异：不做 MCP / skills / goal / subagent 工具集（后续按需接入），
 *  权限 prompter / 升档 / ask_user 全部走协议往返（由 bridge 统一构造 gate）。
 */

import { join } from "node:path";
import { loadConfig } from "./config/load.ts";
import { loadSystemPrompt } from "./config/system-prompt.ts";
import type { BugentConfig } from "./config/schema.ts";
import { ProviderRegistry, parseModelRef } from "./provider/registry.ts";
import { createDefaultTools } from "./tools/builtin.ts";
import {
  ALLOW_ALL_POLICY,
  composePolicy,
  PermissionPolicy,
} from "./permission/policy.ts";
import type { SandboxMode } from "./permission/mode.ts";
import { openSession } from "./core/open-session.ts";
import { defaultDatabasePath, SessionStore } from "./store/repository.ts";
import { Bridge, type BridgeInfo, type ManagedSession, type SessionFactoryOptions } from "./runtime/bridge.ts";
import { prepareStandaloneRuntime } from "./runtime/standalone.ts";

export interface WebuiOptions {
  port?: number;
  cwd?: string;
  /** 注册 mock provider（model=echo），不需要真实 API key。 */
  mock?: boolean;
  /** 模型覆盖：纯 model 名，或旧写法 provider/model。 */
  model?: string;
  /** 允许全部工具（跳过权限询问）。 */
  yes?: boolean;
  noPersist?: boolean;
  allowNetwork?: boolean;
  mode?: SandboxMode;
  noSandbox?: boolean;
  /** 静态目录；缺省 webui/dist。 */
  staticDir?: string;
  /** 不打印欢迎信息（测试用）。 */
  quiet?: boolean;
}

export interface WebuiServer {
  info: BridgeInfo;
  store: SessionStore | undefined;
  stop(): void;
}

/** 组装"真实 runtime"会话工厂（每个 session.new 调用一次）。 */
export function createWebuiSessionFactory(
  options: WebuiOptions,
  config: BugentConfig,
  registry: ProviderRegistry,
  modelRef: { provider: string; model: string },
  systemPrompt: string,
  store: SessionStore | undefined,
): (factoryOptions: SessionFactoryOptions) => ManagedSession {
  const mode: SandboxMode =
    options.mode ?? (options.noSandbox ? "no-sandbox" : undefined) ?? config.sandbox?.mode ?? "workspace-write";
  const allowNetwork = options.allowNetwork || config.sandbox?.allowNetwork === true;

  return (factoryOptions: SessionFactoryOptions): ManagedSession => {
    const cwd = factoryOptions.cwd;
    // provider / key：CLI 侧同款解析；v0 不做 per-session provider 切换，
    // API key 走 config.providers 内嵌配置（env key 由 provider adapter 自取）
    const client = registry.resolve(modelRef, {});
    const tools = createDefaultTools({
      mode,
      ...(allowNetwork ? { allowNetwork: true } : {}),
    });
    const policy = options.yes
      ? new PermissionPolicy(ALLOW_ALL_POLICY)
      : new PermissionPolicy(composePolicy(config.permissions, tools.defaultPermissionRules));
    const session = openSession({
      store,
      sessionId: factoryOptions.sessionId,
      client,
      model: modelRef.model,
      providerId: modelRef.provider,
      systemPrompt,
      cwd,
    });
    return {
      session,
      registry: tools.registry,
      policy,
      mode,
      model: modelRef.model,
      providerId: modelRef.provider,
    };
  };
}

export async function startWebui(options: WebuiOptions = {}): Promise<WebuiServer> {
  await prepareStandaloneRuntime();

  const loaded = await loadConfig({
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
  const config = loaded.config;
  const { registry, modelRef } = buildRegistry(options, config);
  const prompt = await loadSystemPrompt({
    cwd: options.cwd ?? process.cwd(),
  });
  const systemPrompt = prompt.text;
  const store = options.noPersist ? undefined : new SessionStore({ path: defaultDatabasePath() });

  const bridge = new Bridge({
    ...(options.port !== undefined ? { port: options.port } : {}),
    createSession: createWebuiSessionFactory(options, config, registry, modelRef, systemPrompt, store),
    staticDir: options.staticDir ?? join(import.meta.dir, "..", "webui", "dist"),
  });
  const info = await bridge.start();

  if (!options.quiet) {
    process.stdout.write(
      [
        "",
        "bugent webui 已启动",
        `  页面:  http://127.0.0.1:${info.port}/?token=${info.token}`,
        `  协议:  ${info.url}`,
        `  模型:  ${modelRef.provider}/${modelRef.model}`,
        "  退出:  Ctrl+C",
        "",
      ].join("\n"),
    );
  }

  return {
    info,
    store,
    stop() {
      bridge.stop();
      store?.close();
    },
  };
}

/**
 * 解析启动用的模型引用。
 *
 * `model` 写纯模型名，provider 用 `provider`（缺省 providers[0]）。
 * `--model` 仍兼容旧写法 `provider/model`（一次指定两者）。
 */
function buildRegistry(
  options: WebuiOptions,
  config: BugentConfig,
): { registry: ProviderRegistry; modelRef: { provider: string; model: string } } {
  const registry = new ProviderRegistry();
  for (const provider of config.providers) registry.register(provider);
  if (options.mock) registry.register({ id: "mock", endpoint: "mock" });
  const provider = options.mock
    ? "mock"
    : config.provider ?? config.providers[0]?.id ?? "openai";
  const rawModel = (options.model ?? (options.mock ? "echo" : config.model)).trim();
  // --model 兼容旧写法 provider/model；提前校验格式，报错更友好
  const modelRef = rawModel.includes("/") ? parseModelRef(rawModel) : { provider, model: rawModel };
  return { registry, modelRef };
}

// ---------- CLI ----------

const isMain = import.meta.main;
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const cwd = get("--cwd");
  const portRaw = get("--port");
  startWebui({
    ...(cwd !== undefined ? { cwd } : {}),
    ...(portRaw !== undefined ? { port: Number(portRaw) } : {}),
    mock: args.includes("--mock"),
    yes: args.includes("--yes"),
    noPersist: args.includes("--no-persist"),
    allowNetwork: args.includes("--allow-network"),
    noSandbox: args.includes("--no-sandbox"),
  }).catch((err: unknown) => {
    process.stderr.write(`启动失败: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
