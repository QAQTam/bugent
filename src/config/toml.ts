/**
 * TOML 配置 —— 读写 `~/.bugent/config.toml`。
 *
 * 为什么用 TOML 而不是 JSON：
 *   - 支持注释（用户要能写"这行是干嘛的"）
 *   - 尾逗号、多行字符串都自然
 *   - Bun 原生支持 `Bun.TOML.parse`，零依赖
 *
 * 字段名同时接受 snake_case 与 camelCase —— 手写配置文件时不该因为
 * 大小写风格被卡住。
 */

import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { PermissionDecision, PermissionRule } from "../permission/policy.ts";
import { isSandboxMode } from "../permission/mode.ts";
import type { ProviderConfig } from "../provider/registry.ts";
import { parseWire } from "../provider/registry.ts";
import type { McpStdioServerConfig } from "../mcp/stdio.ts";
import type { AlertChannel, AlertConfig } from "../permission/alert.ts";
import type { BugentConfig, GoalsConfig, McpConfig, SandboxConfig, SkillsConfig } from "./schema.ts";

export const CONFIG_DIR_NAME = ".bugent";
export const CONFIG_FILE_NAME = "config.toml";
export const DATABASE_FILE_NAME = "sessions.db";

function homeDir(home?: string): string {
  if (home !== undefined) return home.replace(/\/+$/, "");
  // POSIX 认 $HOME（调用方随时可以覆盖它，测试也依赖这一点）；
  // Windows 上 HOME 可能是 Git Bash 塞进来的 POSIX 路径（`/c/Users/...`），
  // 那种路径 Windows 的文件 API 解析不了，所以那边一律用 os.homedir()。
  // 注意 Bun 的 homedir() 是启动时算好并缓存的，不能靠它读运行期改过的 HOME。
  const fromEnv = process.platform === "win32" ? undefined : process.env.HOME;
  return (fromEnv ?? homedir()).replace(/\/+$/, "");
}

export function configDir(home?: string): string {
  return `${homeDir(home)}/${CONFIG_DIR_NAME}`;
}

export function configFilePath(home?: string): string {
  return `${configDir(home)}/${CONFIG_FILE_NAME}`;
}

/** 会话库统一放在配置目录里。 */
export function databasePath(home?: string): string {
  return `${configDir(home)}/${DATABASE_FILE_NAME}`;
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

type Raw = Record<string, unknown>;

function pick(source: Raw, ...names: string[]): unknown {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`config.toml: ${field} 必须是字符串`);
  return value;
}

function asBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`config.toml: ${field} 必须是布尔值`);
  return value;
}

function asStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`config.toml: ${field} 必须是字符串数组`);
  }
  return value as string[];
}

function asPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`config.toml: ${field} 必须是正整数`);
  }
  return value;
}

/** 0..1 的浮点，用于音量这类"比例"字段。 */
function asUnitFloat(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`config.toml: ${field} 必须是 0..1 之间的数字`);
  }
  return value;
}

function asProxy(value: unknown, field: string): ProviderConfig["proxy"] {
  if (value === undefined) return undefined;
  if (typeof value === "string" || value === false) return value;
  throw new Error(`config.toml: ${field} 必须是代理 URL 字符串或 false`);
}

function asTls(raw: unknown, field: string): ProviderConfig["tls"] {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.toml: ${field} 必须是表`);
  }

  const table = raw as Raw;
  const tls: NonNullable<ProviderConfig["tls"]> = {};
  const rejectUnauthorized = asBool(
    pick(table, "reject_unauthorized", "rejectUnauthorized"),
    `${field}.reject_unauthorized`,
  );
  if (rejectUnauthorized !== undefined) tls.rejectUnauthorized = rejectUnauthorized;

  const ca = asString(table.ca, `${field}.ca`);
  if (ca !== undefined) tls.ca = ca;
  const cert = asString(table.cert, `${field}.cert`);
  if (cert !== undefined) tls.cert = cert;
  const key = asString(table.key, `${field}.key`);
  if (key !== undefined) tls.key = key;
  const passphrase = asString(table.passphrase, `${field}.passphrase`);
  if (passphrase !== undefined) tls.passphrase = passphrase;
  const serverName = asString(pick(table, "server_name", "serverName"), `${field}.server_name`);
  if (serverName !== undefined) tls.serverName = serverName;

  return tls;
}

const DECISIONS: readonly PermissionDecision[] = ["allow", "ask", "deny"];
const REASONING_REPLAYS = ["none", "reasoning", "reasoning_content", "both"] as const;

/**
 * extra_body 必须是表（PERF 之外的 BUG-026）：TOML 里写成字符串/数组时，
 * 旧实现原样 cast 后被 `...extraBody` 展开进请求体，索引键会变成
 * `{"0":"h","1":"i"}` 这样的垃圾字段发给 API。
 */
function parseExtraBody(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`config.toml: ${at}.extra_body 必须是 [extra_body] 表（键值对）`);
  }
  return value as Record<string, unknown>;
}

function parseProvider(raw: unknown, index: number): ProviderConfig {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`config.toml: providers[${index}] 必须是表`);
  }
  const table = raw as Raw;
  const at = `providers[${index}]`;

  const id = asString(pick(table, "id", "name"), `${at}.id`);
  if (id === undefined) throw new Error(`config.toml: ${at}.id 必填`);

  // wire 是用户面的中性简称（chat / messages / responses / mock）；
  // endpoint 是旧写法（openai-chat / … 全名），继续接受但不再推荐。
  const wire = asString(table.wire, `${at}.wire`);
  const legacyEndpoint = asString(table.endpoint, `${at}.endpoint`);
  if (wire !== undefined && legacyEndpoint !== undefined) {
    throw new Error(`config.toml: ${at}.wire 与 ${at}.endpoint 只能二选一（endpoint 已由 wire 取代）`);
  }
  const rawWire = wire ?? legacyEndpoint;
  const wireSource = wire !== undefined ? "wire" : "endpoint";
  const endpoint = rawWire === undefined ? "openai-chat" : parseWire(rawWire);
  if (endpoint === undefined) {
    throw new Error(
      `config.toml: ${at}.${wireSource} 不合法，必须是 chat / messages / responses / mock（兼容旧写法 openai-chat / openai-responses / anthropic-messages）`,
    );
  }
  const baseUrl = asString(pick(table, "base_url", "baseUrl"), `${at}.base_url`);
  const apiKey = asString(pick(table, "api_key", "apiKey"), `${at}.api_key`);
  const proxy = asProxy(table.proxy, `${at}.proxy`);
  const tls = asTls(table.tls, `${at}.tls`);
  const reasoningReplay = asString(
    pick(table, "reasoning_replay", "reasoningReplay"),
    `${at}.reasoning_replay`,
  );
  if (
    reasoningReplay !== undefined &&
    !(REASONING_REPLAYS as readonly string[]).includes(reasoningReplay)
  ) {
    throw new Error(
      `config.toml: ${at}.reasoning_replay 必须是 ${REASONING_REPLAYS.join(" / ")}`,
    );
  }

  const contextWindow = asPositiveInteger(
    pick(table, "context_window", "contextWindow"),
    `${at}.context_window`,
  );

  return {
    id,
    endpoint,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(table.extra_body !== undefined || table.extraBody !== undefined
      ? { extraBody: parseExtraBody(pick(table, "extra_body", "extraBody"), at) }
      : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(tls !== undefined ? { tls } : {}),
    ...(reasoningReplay !== undefined
      ? { reasoningReplay: reasoningReplay as (typeof REASONING_REPLAYS)[number] }
      : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

function parseRule(raw: unknown, index: number): PermissionRule {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`config.toml: permissions.rules[${index}] 必须是表`);
  }
  const table = raw as Raw;
  const at = `permissions.rules[${index}]`;

  const tool = asString(table.tool, `${at}.tool`);
  if (tool === undefined) throw new Error(`config.toml: ${at}.tool 必填`);

  const decision = asString(table.decision, `${at}.decision`) as PermissionDecision | undefined;
  if (decision === undefined || !DECISIONS.includes(decision)) {
    throw new Error(`config.toml: ${at}.decision 必须是 allow / ask / deny`);
  }

  const resource = asString(table.resource, `${at}.resource`);
  return { tool, decision, ...(resource !== undefined ? { resource } : {}) };
}

function parseMcpLimits(raw: unknown, field: string): McpStdioServerConfig["limits"] | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.toml: ${field} 必须是表`);
  }
  const table = raw as Raw;
  const limits: NonNullable<McpStdioServerConfig["limits"]> = {};
  const fields: Array<[keyof NonNullable<McpStdioServerConfig["limits"]>, string, string[]]> = [
    ["cpuSeconds", "cpu_seconds", ["cpu_seconds", "cpuSeconds"]],
    ["addressSpaceBytes", "address_space_bytes", ["address_space_bytes", "addressSpaceBytes"]],
    ["fileSizeBytes", "file_size_bytes", ["file_size_bytes", "fileSizeBytes"]],
    ["openFiles", "open_files", ["open_files", "openFiles"]],
    ["processes", "processes", ["processes"]],
  ];
  for (const [key, fieldName, names] of fields) {
    const value = pick(table, ...names);
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`config.toml: ${field}.${fieldName} 必须是正的安全整数`);
    }
    limits[key] = value;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function parseMcpServer(raw: unknown, index: number): McpStdioServerConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.toml: mcp.servers[${index}] 必须是表`);
  }
  const table = raw as Raw;
  const at = `mcp.servers[${index}]`;

  const id = asString(pick(table, "id", "name"), `${at}.id`);
  if (id === undefined) throw new Error(`config.toml: ${at}.id 必填`);
  const cmd = asStringArray(table.cmd, `${at}.cmd`);
  if (cmd === undefined || cmd.length === 0) {
    throw new Error(`config.toml: ${at}.cmd 必须是非空字符串数组`);
  }

  const cwd = asString(table.cwd, `${at}.cwd`);
  const env = asStringArray(table.env, `${at}.env`);
  const read = asStringArray(table.read, `${at}.read`);
  const write = asStringArray(table.write, `${at}.write`);
  const exec = asStringArray(table.exec, `${at}.exec`);
  const networkAllow = asStringArray(
    pick(table, "network_allow", "networkAllow"),
    `${at}.network_allow`,
  );
  const stateDir = asString(pick(table, "state_dir", "stateDir"), `${at}.state_dir`);
  const workspaceRead = asBool(
    pick(table, "workspace_read", "workspaceRead"),
    `${at}.workspace_read`,
  );
  const rawWorkspaceWrite = pick(table, "workspace_write", "workspaceWrite");
  let workspaceWrite: boolean | string[] | undefined;
  if (rawWorkspaceWrite !== undefined) {
    if (typeof rawWorkspaceWrite === "boolean") {
      workspaceWrite = rawWorkspaceWrite;
    } else {
      workspaceWrite = asStringArray(rawWorkspaceWrite, `${at}.workspace_write`);
    }
  }

  const network = asString(table.network, `${at}.network`) as
    | McpStdioServerConfig["network"]
    | undefined;
  if (
    network !== undefined &&
    network !== "none" &&
    network !== "allowlist" &&
    network !== "all"
  ) {
    throw new Error(`config.toml: ${at}.network 必须是 none / allowlist / all`);
  }
  const limits = parseMcpLimits(table.limits, `${at}.limits`);
  const stderrLimitBytes = pick(table, "stderr_limit_bytes", "stderrLimitBytes");
  if (
    stderrLimitBytes !== undefined &&
    (typeof stderrLimitBytes !== "number" ||
      !Number.isSafeInteger(stderrLimitBytes) ||
      stderrLimitBytes <= 0)
  ) {
    throw new Error(`config.toml: ${at}.stderr_limit_bytes 必须是正整数`);
  }

  return {
    id,
    cmd,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(read !== undefined ? { read } : {}),
    ...(write !== undefined ? { write } : {}),
    ...(exec !== undefined ? { exec } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(networkAllow !== undefined ? { networkAllow } : {}),
    ...(stateDir !== undefined ? { stateDir } : {}),
    ...(workspaceRead !== undefined ? { workspaceRead } : {}),
    ...(workspaceWrite !== undefined ? { workspaceWrite } : {}),
    ...(limits !== undefined ? { limits } : {}),
    ...(stderrLimitBytes !== undefined ? { stderrLimitBytes } : {}),
  };
}

function parseMcp(raw: unknown): McpConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.toml: mcp 必须是表");
  }
  const table = raw as Raw;
  const servers = pick(table, "servers", "server");
  if (servers === undefined) return {};
  if (!Array.isArray(servers)) {
    throw new Error("config.toml: mcp.servers 必须是数组（用 [[mcp.servers]]）");
  }
  const parsed = servers.map(parseMcpServer);
  const ids = new Set<string>();
  for (const server of parsed) {
    if (ids.has(server.id)) throw new Error(`config.toml: MCP server id 重复：${server.id}`);
    ids.add(server.id);
  }
  return { servers: parsed };
}

function parseSkills(raw: unknown): SkillsConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.toml: skills 必须是表");
  }
  const table = raw as Raw;
  const paths = asStringArray(table.paths, "skills.paths");
  const disabled = asStringArray(table.disabled, "skills.disabled");
  const disableDefaults = asBool(
    pick(table, "disable_defaults", "disableDefaults"),
    "skills.disable_defaults",
  );
  return {
    ...(paths !== undefined ? { paths } : {}),
    ...(disableDefaults !== undefined ? { disableDefaults } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
  };
}

function parseGoals(raw: unknown): GoalsConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.toml: goals 必须是表");
  }
  const table = raw as Raw;
  const enabled = asBool(table.enabled, "goals.enabled");
  const autoContinue = asBool(
    pick(table, "auto_continue", "autoContinue"),
    "goals.auto_continue",
  );
  const maxConsecutiveTurns = asPositiveInteger(
    pick(table, "max_consecutive_turns", "maxConsecutiveTurns"),
    "goals.max_consecutive_turns",
  );
  const maxGoalTokenBudget = asPositiveInteger(
    pick(table, "max_goal_token_budget", "maxGoalTokenBudget"),
    "goals.max_goal_token_budget",
  );
  const contextRefresh = asString(
    pick(table, "context_refresh", "contextRefresh"),
    "goals.context_refresh",
  );
  if (
    contextRefresh !== undefined &&
    contextRefresh !== "checkpoint" &&
    contextRefresh !== "threshold" &&
    contextRefresh !== "manual"
  ) {
    throw new Error("config.toml: goals.context_refresh 必须是 checkpoint / threshold / manual");
  }
  const handoffInlineBytes = asPositiveInteger(
    pick(table, "handoff_inline_bytes", "handoffInlineBytes"),
    "goals.handoff_inline_bytes",
  );
  const reviewPolicy = asString(
    pick(table, "review_policy", "reviewPolicy"),
    "goals.review_policy",
  );
  if (
    reviewPolicy !== undefined &&
    reviewPolicy !== "off" &&
    reviewPolicy !== "medium" &&
    reviewPolicy !== "high" &&
    reviewPolicy !== "always"
  ) {
    throw new Error("config.toml: goals.review_policy 必须是 off / medium / high / always");
  }
  const reviewModel = asString(
    pick(table, "review_model", "reviewModel"),
    "goals.review_model",
  );

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(autoContinue !== undefined ? { autoContinue } : {}),
    ...(maxConsecutiveTurns !== undefined ? { maxConsecutiveTurns } : {}),
    ...(maxGoalTokenBudget !== undefined ? { maxGoalTokenBudget } : {}),
    ...(contextRefresh !== undefined
      ? { contextRefresh: contextRefresh as NonNullable<GoalsConfig["contextRefresh"]> }
      : {}),
    ...(handoffInlineBytes !== undefined ? { handoffInlineBytes } : {}),
    ...(reviewPolicy !== undefined
      ? { reviewPolicy: reviewPolicy as NonNullable<GoalsConfig["reviewPolicy"]> }
      : {}),
    ...(reviewModel !== undefined ? { reviewModel } : {}),
  };
}

const ALERT_CHANNELS: readonly AlertChannel[] = ["speaker", "sound", "bell"];

function isAlertChannel(value: string): value is AlertChannel {
  return (ALERT_CHANNELS as readonly string[]).includes(value);
}

/**
 * `[alert]` —— 授权硬件提醒。
 *
 * 注意 enabled 默认 false：这个开关会真的让机器发声，不能替用户默认打开。
 */
function parseAlert(raw: unknown): AlertConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.toml: alert 必须是表");
  }
  const table = raw as Raw;
  const enabled = asBool(table.enabled, "alert.enabled");
  const rawChannels = asStringArray(table.channels, "alert.channels");
  const channels = rawChannels?.map((channel) => {
    if (!isAlertChannel(channel)) {
      throw new Error(
        `config.toml: alert.channels 只支持 speaker / sound / bell，收到 ${JSON.stringify(channel)}`,
      );
    }
    return channel;
  });
  const urgencyWindowMs = asPositiveInteger(
    pick(table, "urgency_window_ms", "urgencyWindowMs"),
    "alert.urgency_window_ms",
  );
  const volume = asUnitFloat(table.volume, "alert.volume");
  const speakerDevice = asString(
    pick(table, "speaker_device", "speakerDevice"),
    "alert.speaker_device",
  );
  const soundPlayer = asStringArray(
    pick(table, "sound_player", "soundPlayer"),
    "alert.sound_player",
  );

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(urgencyWindowMs !== undefined ? { urgencyWindowMs } : {}),
    ...(volume !== undefined ? { volume } : {}),
    ...(speakerDevice !== undefined ? { speakerDevice } : {}),
    ...(soundPlayer !== undefined ? { soundPlayer } : {}),
  };
}

/** TOML 文本 -> BugentConfig。 */
export function parseConfigToml(text: string): BugentConfig {
  const root = Bun.TOML.parse(text) as Raw;

  // 主键 model / provider；旧键 default_model / default_provider 作为别名继续接受
  // （default_model 还兼容旧 "provider/model" 前缀写法：前缀作为隐式 provider）。
  let model = asString(pick(root, "model", "default_model", "defaultModel"), "model");
  let provider = asString(pick(root, "provider", "default_provider", "defaultProvider"), "provider");
  if (model === undefined) {
    throw new Error('config.toml: model 必填（形如 "deepseek-v4.1-flash"）');
  }
  const slash = model.indexOf("/");
  if (slash > 0) {
    const legacyProvider = model.slice(0, slash);
    if (provider !== undefined && provider !== legacyProvider) {
      throw new Error(
        `config.toml: model 里的 provider 前缀 "${legacyProvider}" 与 provider "${provider}" 冲突`,
      );
    }
    model = model.slice(slash + 1);
    provider ??= legacyProvider;
  }
  if (model.length === 0) {
    throw new Error("config.toml: model 不能以 \"/\" 结尾");
  }

  const rawProviders = pick(root, "providers", "provider");
  if (!Array.isArray(rawProviders) || rawProviders.length === 0) {
    throw new Error("config.toml: 至少需要一个 [[providers]]");
  }

  const agentTable = (pick(root, "agent") ?? {}) as Raw;
  const permissionsTable = (pick(root, "permissions") ?? {}) as Raw;
  const sandboxTable = (pick(root, "sandbox") ?? {}) as Raw;
  const mcp = parseMcp(pick(root, "mcp"));
  const skills = parseSkills(pick(root, "skills"));
  const goals = parseGoals(pick(root, "goals"));
  const alert = parseAlert(pick(root, "alert"));

  const rawRules = pick(permissionsTable, "rules") ?? [];
  if (!Array.isArray(rawRules)) {
    throw new Error("config.toml: permissions.rules 必须是数组（用 [[permissions.rules]]）");
  }

  const defaultDecision = asString(
    pick(permissionsTable, "default"),
    "permissions.default",
  ) as PermissionDecision | undefined;
  if (defaultDecision !== undefined && !DECISIONS.includes(defaultDecision)) {
    throw new Error("config.toml: permissions.default 必须是 allow / ask / deny");
  }

  const sandbox: SandboxConfig = {};
  const sandboxMode = asString(pick(sandboxTable, "mode"), "sandbox.mode");
  if (sandboxMode !== undefined) {
    if (!isSandboxMode(sandboxMode)) {
      throw new Error(
        `config.toml: sandbox.mode 必须是 read-only / workspace-write / no-sandbox，收到 ${JSON.stringify(sandboxMode)}`,
      );
    }
    sandbox.mode = sandboxMode;
  }
  const writablePaths = asStringArray(
    pick(sandboxTable, "writable_paths", "writablePaths"),
    "sandbox.writable_paths",
  );
  if (writablePaths !== undefined) sandbox.writablePaths = writablePaths;

  const passEnv = asStringArray(pick(sandboxTable, "pass_env", "passEnv"), "sandbox.pass_env");
  if (passEnv !== undefined) sandbox.passEnv = passEnv;

  const allowNetwork = asBool(
    pick(sandboxTable, "allow_network", "allowNetwork"),
    "sandbox.allow_network",
  );
  if (allowNetwork !== undefined) sandbox.allowNetwork = allowNetwork;

  const systemPromptFile = asString(
    pick(agentTable, "system_prompt_file", "systemPromptFile"),
    "agent.system_prompt_file",
  );
  const maxSteps = pick(agentTable, "max_steps", "maxSteps");
  if (maxSteps !== undefined && (typeof maxSteps !== "number" || !Number.isFinite(maxSteps) || !Number.isInteger(maxSteps) || maxSteps <= 0)) {
    throw new Error("config.toml: agent.max_steps 必须是正整数");
  }

  return {
    model,
    ...(provider !== undefined ? { provider } : {}),
    providers: rawProviders.map(parseProvider),
    agent: {
      ...(systemPromptFile !== undefined ? { systemPromptFile } : {}),
      ...(typeof maxSteps === "number" ? { maxSteps } : {}),
    },
    permissions: {
      ...(defaultDecision !== undefined ? { default: defaultDecision } : {}),
      rules: rawRules.map(parseRule),
    },
    sandbox,
    ...(mcp !== undefined ? { mcp } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(goals !== undefined ? { goals } : {}),
    ...(alert !== undefined ? { alert } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 默认配置                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_CONFIG_TOML = `# bugent 配置
# 位置：~/.bugent/config.toml

# 默认模型（纯模型名，不带 provider 前缀；用哪个 provider 由 provider 决定）
model = "deepseek-v4.1-flash"
# 省略时用第一个 [[providers]]
# provider = "openai"

[agent]
# system_prompt_file = "~/.bugent/SYSTEM.md"
max_steps = 800

# ---- 权限 ----
# 放行交给**沙箱档位**判断，这里只写硬性禁令。
# 刻意不设 default = "ask" —— 那会让每次工具调用都弹窗，
# 而档位本身已经声明了边界（read-only 档下 bash 改不动任何东西）。
[permissions]

# 规则按顺序匹配，第一条命中即生效。
# 注意 resource 里的 * 匹配任意字符（含 /）。
[[permissions.rules]]
# exec 是现名；旧配置写 tool = "bash" 也会通过别名匹配到 exec。
tool = "exec"
resource = "rm -rf /*"
decision = "deny"

[sandbox]
# 档位 = 默认批准范围，不是隔离开关；沙箱恒开，档位只决定"要不要问"。
#   read-only        读免问；写工作区 / 写工作区外 / 联网 → 逐次批准
#   workspace-write  读 + 写工作区免问；写工作区外 / 联网 → 逐次批准
#   no-sandbox       全部免问（沙箱仍在，只是不拦截）
# 读工作区之外在三档都是自由的；批准一次只生效一次，不会改档位。
mode = "workspace-write"

# 额外可写路径（工作目录总是可写）
writable_paths = []

# 环境变量是**白名单制**：只保留 PATH/HOME/TERM/LANG 等少数几个，
# 其余（含各种 API key）一律不传给子进程。需要什么在这里显式加。
pass_env = []

# 启动时就允许联网（等价于 --allow-network）。默认 false ——
# 联网是按次授权的：命令先在断网沙箱里真跑一次，失败了再拿真实报错问你。
allow_network = false

# ---- 授权硬件提醒 ----
# 授权弹窗 60 秒没人应答就按超时**拒绝**。终端 BEL 只在终端里响，TUI 重绘时
# 还常被吞掉；这个开关让提醒走硬件：
#   speaker  主板蜂鸣器（绕过音量/耳机/静音，需要 /dev/input/eventN 写权限）
#   sound    声卡合成音（无特权要求，但会被静音影响）
#   bell     终端 BEL（兜底）
# 时序：弹窗出现响一次 → 最后 urgency_window_ms 内按 10/5/3/1 四档升级 →
# 批准/拒绝各一个收尾音。
[alert]
enabled = false
channels = ["speaker", "sound"]
urgency_window_ms = 10000
volume = 0.55
# speaker_device = "/dev/input/event17"
# sound_player = ["paplay", "--raw", "--format=s16le", "--rate=48000", "--channels=1"]

# ---- Goal Mode ----
# P5 阶段仍默认关闭自动 continuation；显式 /goal 始终可用。
[goals]
enabled = false
auto_continue = false
max_consecutive_turns = 50
max_goal_token_budget = 200000
context_refresh = "checkpoint"
handoff_inline_bytes = 32768
review_policy = "medium"
# review_model = "deepseek-v4.1-flash"

# ---- MCP ----
# MCP stdio server 默认：工作区只读、私有 state 可写、断网、独立进程沙箱。
# 当前原生沙箱只支持 Linux；其他平台会明确关闭 MCP，不会无沙箱启动。
#
# [[mcp.servers]]
# id = "filesystem"
# cmd = ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."]
# workspace_read = true
# workspace_write = false
# network = "none"
# read = []
# write = []
# exec = []
# env = []
# limits = { cpu_seconds = 30, address_space_bytes = 536870912, open_files = 256, processes = 64 }

# ---- Skills ----
# 默认发现 ~/.bugent/skills、~/.agents/skills 以及项目内同名目录。
# 每个 skill 是一个包含 SKILL.md 的目录；YAML frontmatter 必须提供 name/description。
[skills]
# paths = ["~/.config/my-skills"]
# disable_defaults = false
# disabled = ["legacy-skill"]

# ---- provider ----
# wire 选 wire 协议：chat（OpenAI 兼容）/ messages（Anthropic 兼容）/ responses / mock
# 旧写法 endpoint = "openai-chat" 仍然接受，但推荐用 wire。

[[providers]]
id = "openai"
wire = "chat"
base_url = "http://127.0.0.1:8787/v1"
api_key = ""
# 代理：不写时遵循 HTTP_PROXY/HTTPS_PROXY；本地 127.0.0.1 会自动绕过。
# proxy = "http://127.0.0.1:7890"
# proxy = false

# TLS（可选；字符串字段直接放 PEM 内容）
# [providers.tls]
# reject_unauthorized = false
# ca = "-----BEGIN CERTIFICATE-----..."

# 开启思考链路：加了这个参数模型才会返回 reasoning_content
# （实测 deepseek-v4.1-flash 必须显式开启）
#
# reasoning_replay：assistant 历史回放思考字段，可选
#   "reasoning" | "reasoning_content" | "both" | "none"
# WorkBuddy 上游认 reasoning；默认就是 reasoning。
# reasoning_replay = "reasoning"
extra_body = { reasoning_effort = "high" }

# 上下文窗口（token）。协议里没有这个字段，不写就按模型名前缀查内置兜底表；
# 兜底表没命中时状态栏只显示绝对占用，不显示百分比。
# context_window = 128000
`;

/**
 * 确保配置目录与配置文件存在。
 * 返回 true 表示这次新建了配置文件（调用方可以提示用户去看）。
 */
export async function ensureConfigFile(path = configFilePath()): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  if (await Bun.file(path).exists()) return false;
  await Bun.write(path, DEFAULT_CONFIG_TOML);
  // 模板里有 api_key 字段位，用户几乎必然把密钥写进来 —— 0644 会被同机
  // 其它用户读到。只在新建时收紧：已存在的文件是用户自己的权限决定。
  await chmod(path, 0o600);
  return true;
}
