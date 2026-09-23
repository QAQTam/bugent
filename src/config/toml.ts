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
import { dirname } from "node:path";
import type { PermissionDecision, PermissionRule } from "../permission/policy.ts";
import { isSandboxMode } from "../permission/mode.ts";
import type { EndpointKind, ProviderConfig } from "../provider/registry.ts";
import type { BugentConfig, SandboxConfig } from "./schema.ts";

export const CONFIG_DIR_NAME = ".bugent";
export const CONFIG_FILE_NAME = "config.toml";
export const DATABASE_FILE_NAME = "sessions.db";

function homeDir(home?: string): string {
  return (home ?? process.env.HOME ?? "~").replace(/\/+$/, "");
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

const DECISIONS: readonly PermissionDecision[] = ["allow", "ask", "deny"];

function parseProvider(raw: unknown, index: number): ProviderConfig {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`config.toml: providers[${index}] 必须是表`);
  }
  const table = raw as Raw;
  const at = `providers[${index}]`;

  const id = asString(pick(table, "id", "name"), `${at}.id`);
  if (id === undefined) throw new Error(`config.toml: ${at}.id 必填`);

  const endpoint = (asString(table.endpoint, `${at}.endpoint`) ?? "openai-chat") as EndpointKind;

  return {
    id,
    endpoint,
    ...(asString(pick(table, "base_url", "baseUrl"), `${at}.base_url`) !== undefined
      ? { baseUrl: asString(pick(table, "base_url", "baseUrl"), `${at}.base_url`) }
      : {}),
    ...(asString(pick(table, "api_key", "apiKey"), `${at}.api_key`) !== undefined
      ? { apiKey: asString(pick(table, "api_key", "apiKey"), `${at}.api_key`) }
      : {}),
    ...(pick(table, "extra_body", "extraBody") !== undefined
      ? { extraBody: pick(table, "extra_body", "extraBody") as Record<string, unknown> }
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

  const systemPrompt = asString(
    pick(agentTable, "system_prompt", "systemPrompt"),
    "agent.system_prompt",
  );
  const maxSteps = pick(agentTable, "max_steps", "maxSteps");

  return {
    defaultModel,
    providers: rawProviders.map(parseProvider),
    agent: {
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(typeof maxSteps === "number" ? { maxSteps } : {}),
    },
    permissions: {
      ...(defaultDecision !== undefined ? { default: defaultDecision } : {}),
      rules: rawRules.map(parseRule),
    },
    sandbox,
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
# system_prompt = "You are bugent..."
max_steps = 16

[permissions]
# 未命中任何规则时的决策：allow / ask / deny
default = "ask"

# 规则按顺序匹配，第一条命中即生效。
# 注意 resource 里的 * 匹配任意字符（含 /），给 bash 配白名单要非常小心。
[[permissions.rules]]
tool = "read_file"
decision = "allow"

[[permissions.rules]]
tool = "bash"
resource = "rm -rf /*"
decision = "deny"

[sandbox]
# 档位：read-only | workspace-write | no-sandbox
#   read-only        根只读 + 工作区只读 + 断网（bash 可自动放行，内核保证改不动）
#   workspace-write  根只读 + 工作区可写 + 断网
#   no-sandbox       不隔离，可读写任意位置
# 联网不走档位：默认断网，命令失败时按次询问授权。
mode = "workspace-write"
writable_paths = []

# 环境变量是白名单制：只保留 PATH/HOME/TERM/LANG 等少数几个，
# 其余（含各种 API key）一律不传给子进程。需要什么在这里显式加。
pass_env = []

# ---- provider ----
# 任何 OpenAI 兼容端点都能这样接

[[providers]]
id = "openai"
endpoint = "openai-chat"
base_url = "http://127.0.0.1:8787/v1"
api_key = ""

# 开启思考链路：加了这个参数模型才会返回 reasoning_content
# （实测 deepseek-v4.1-flash 必须显式开启）
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
