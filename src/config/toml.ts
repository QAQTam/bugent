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

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { PermissionDecision, PermissionRule } from "../permission/policy.ts";
import { isSandboxMode } from "../permission/mode.ts";
import type { EndpointKind, ProviderConfig } from "../provider/registry.ts";
import type { McpStdioServerConfig } from "../mcp/stdio.ts";
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

function parseProvider(raw: unknown, index: number): ProviderConfig {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`config.toml: providers[${index}] 必须是表`);
  }
  const table = raw as Raw;
  const at = `providers[${index}]`;

  const id = asString(pick(table, "id", "name"), `${at}.id`);
  if (id === undefined) throw new Error(`config.toml: ${at}.id 必填`);

  const endpoint = (asString(table.endpoint, `${at}.endpoint`) ?? "openai-chat") as EndpointKind;
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

  return {
    id,
    endpoint,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(table.extra_body !== undefined || table.extraBody !== undefined
      ? { extraBody: pick(table, "extra_body", "extraBody") as Record<string, unknown> }
      : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(tls !== undefined ? { tls } : {}),
    ...(reasoningReplay !== undefined
      ? { reasoningReplay: reasoningReplay as (typeof REASONING_REPLAYS)[number] }
      : {}),
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

/** TOML 文本 -> BugentConfig。 */
export function parseConfigToml(text: string): BugentConfig {
  const root = Bun.TOML.parse(text) as Raw;

  const defaultModel = asString(pick(root, "default_model", "defaultModel"), "default_model");
  if (defaultModel === undefined) {
    throw new Error("config.toml: default_model 必填（形如 \"openai/deepseek-v4.1-flash\"）");
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

  const systemPromptFile = asString(
    pick(agentTable, "system_prompt_file", "systemPromptFile"),
    "agent.system_prompt_file",
  );
  const maxSteps = pick(agentTable, "max_steps", "maxSteps");

  return {
    defaultModel,
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
  };
}

/* ------------------------------------------------------------------ */
/* 默认配置                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_CONFIG_TOML = `# bugent 配置
# 位置：~/.bugent/config.toml

# 默认模型，格式 "provider/model"
default_model = "openai/deepseek-v4.1-flash"

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
tool = "bash"
resource = "rm -rf /*"
decision = "deny"

[sandbox]
# 档位：read-only | workspace-write | no-sandbox
#   read-only        根只读 + 工作区只读 + 断网（bash 自动放行，内核保证改不动）
#   workspace-write  根只读 + 工作区可写 + 断网
#   no-sandbox       不隔离，可读写任意位置
mode = "workspace-write"

# 额外可写路径（工作目录总是可写）
writable_paths = []

# 环境变量是**白名单制**：只保留 PATH/HOME/TERM/LANG 等少数几个，
# 其余（含各种 API key）一律不传给子进程。需要什么在这里显式加。
pass_env = []

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
# review_model = "openai/deepseek-v4.1-flash"

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
# 任何 OpenAI 兼容端点都能这样接

[[providers]]
id = "openai"
endpoint = "openai-chat"
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
`;

/**
 * 确保配置目录与配置文件存在。
 * 返回 true 表示这次新建了配置文件（调用方可以提示用户去看）。
 */
export async function ensureConfigFile(path = configFilePath()): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  if (await Bun.file(path).exists()) return false;
  await Bun.write(path, DEFAULT_CONFIG_TOML);
  return true;
}
