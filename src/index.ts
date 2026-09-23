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
import { AgentSession } from "./core/session.ts";
import { combineHooks, runUserTurn, type LoopHooks, type TurnResult } from "./core/loop.ts";
import type { ModelClient } from "./provider/types.ts";
import { ProviderRegistry, parseModelRef } from "./provider/registry.ts";
import { createDefaultTools } from "./tools/builtin.ts";
import { DEFAULT_SYSTEM_PROMPT, loadConfig } from "./config/load.ts";
import { TuiApp } from "./tui/app.ts";
import { PermissionGate, type GateDecision } from "./permission/gate.ts";
import { StdinPrompter } from "./permission/prompt.ts";
import { ALLOW_ALL_POLICY, PermissionPolicy } from "./permission/policy.ts";
import { AuditTrail } from "./store/audit.ts";
import { defaultDatabasePath, SessionStore } from "./store/repository.ts";
import { newSessionId } from "./util/id.ts";

interface CliOptions {
  prompt?: string;
  model?: string;
  mock: boolean;
  cwd: string;
  maxSteps?: number;
  help: boolean;
  plain: boolean;
  /** 跳过所有权限确认。 */
  yes: boolean;
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
  -p, --prompt <text>        一次性执行给定提示词
  -m, --model <ref>          指定模型，格式 provider/model
      --mock                 使用内置 mock provider（无需网络与密钥）
      --plain                不使用 TUI，退回纯文本 REPL
      --yes                  跳过权限确认（危险）
      --no-sandbox           禁用 bwrap 沙箱
      --allow-network        沙箱内允许联网（默认断网）
      --resume <id>          恢复指定会话
      --sessions             列出已保存的会话后退出
      --no-persist           不落盘（会话不写入 SQLite）
      --cwd <dir>            工作目录
      --max-steps <n>        单轮最大工具往返次数（默认 16）
  -h, --help                 显示帮助
`;

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mock: false,
    cwd: process.cwd(),
    help: false,
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

async function buildRegistry(options: CliOptions): Promise<{ registry: ProviderRegistry; model: string }> {
  const config = await loadConfig({ cwd: options.cwd, ignoreFile: options.mock });
  const registry = new ProviderRegistry();
  for (const provider of config.providers) registry.register(provider);
  if (options.mock) registry.register({ id: "mock", endpoint: "mock" });

  const model = options.model ?? (options.mock ? "mock/echo" : config.defaultModel);
  parseModelRef(model); // 提前校验格式，报错更友好
  return { registry, model };
}

function createHooks(): LoopHooks {
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

interface OpenSessionOptions {
  store: SessionStore | undefined;
  sessionId: string;
  client: ModelClient;
  model: string;
  providerId: string;
  systemPrompt: string;
  cwd: string;
}

/**
 * 打开会话：有历史就恢复，没有就新建并落盘。
 *
 * 恢复后 msgid 会从历史最大值继续递增，所以"只追加"这条铁律在重启后依然成立。
 */
function openSession(options: OpenSessionOptions): AgentSession {
  const { store, sessionId } = options;

  if (store === undefined) {
    return new AgentSession({
      id: sessionId,
      system: options.systemPrompt,
      client: options.client,
      model: options.model,
    });
  }

  const persist = (message: { createdAt: number }): void => {
    store.touchSession(sessionId, message.createdAt);
  };

  const existing = store.getSession(sessionId);
  if (existing !== undefined) {
    return new AgentSession({
      id: sessionId,
      system: existing.systemPrompt,
      client: options.client,
      model: options.model,
      restore: store.loadMessages(sessionId),
      onMessage: (message) => {
        store.appendMessage(sessionId, message);
        persist(message);
      },
    });
  }

  const now = Date.now();
  store.createSession({
    id: sessionId,
    createdAt: now,
    updatedAt: now,
    model: options.model,
    providerId: options.providerId,
    systemPrompt: options.systemPrompt,
    cwd: options.cwd,
  });

  return new AgentSession({
    id: sessionId,
    system: options.systemPrompt,
    client: options.client,
    model: options.model,
    onMessage: (message) => {
      store.appendMessage(sessionId, message);
      persist(message);
    },
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const { registry, model } = await buildRegistry(options);
  const ref = parseModelRef(model);
  const client = registry.resolve(ref);
  const config = await loadConfig({ cwd: options.cwd, ignoreFile: options.mock });
  const systemPrompt = config.agent?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  /* ----------------------- 持久化（Phase 10） ----------------------- */

  const store = options.noPersist
    ? undefined
    : new SessionStore({ path: defaultDatabasePath(options.cwd) });

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

  const session = openSession({
    store,
    sessionId,
    client,
    model: ref.model,
    providerId: ref.provider,
    systemPrompt,
    cwd: options.cwd,
  });

  // 沙箱：默认能用就用，--no-sandbox 显式关闭
  const sandboxOption = options.noSandbox
    ? null
    : {
        ...(config.sandbox ?? {}),
        allowNetwork: options.allowNetwork || config.sandbox?.allowNetwork === true,
      };
  const tools = createDefaultTools({ sandbox: sandboxOption });

  // 权限：--yes 全放行，否则用配置里的策略（默认 ask）
  const policy = new PermissionPolicy(
    options.yes ? ALLOW_ALL_POLICY : (config.permissions ?? { default: "ask" }),
  );

  // 审计流水：工具调用、权限决策、每轮起止，全部落盘可回放
  const audit =
    store === undefined ? undefined : new AuditTrail({ store, sessionId, turn: () => session.turn });

  const hooks = combineHooks(createHooks(), audit?.hooks());
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
        sandboxEnabled: tools.sandbox.enabled,
        banner: [
          `**bugent** 已就绪 · \`${client.id}\``,
          "",
          `会话：\`${sessionId}\`${store === undefined ? "（未持久化）" : ""}`,
          `沙箱：${tools.sandbox.note}`,
          `权限：${
            options.yes
              ? "**已跳过所有确认（--yes）**"
              : `默认 ${policy.defaultDecision}${policy.ruleCount > 0 ? `，${policy.ruleCount} 条规则` : ""}`
          }`,
          "",
          "输入消息开始对话；`/exit` 退出；运行中按 `ESC` 中断。",
        ].join("\n"),
      });

      // TUI 自己就是权限确认入口：闸门回调到 app 的弹窗
      tools.registry.setGate(
        new PermissionGate(policy, { ask: (request) => app.askPermission(request) }, onDecision),
      );
      await app.run();
      return;
    }

    // 非 TUI 路径：权限确认走 stdin
    const prompter = new StdinPrompter();
    tools.registry.setGate(new PermissionGate(policy, prompter, onDecision));

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
    store?.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m\n`);
    process.exit(1);
  });
}
