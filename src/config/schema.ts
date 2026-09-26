/**
 * 配置模型 —— Phase 5 的类型层。
 *
 * 配置写成 `bugent.config.ts`（Bun 原生 import TS），而不是 JSON：
 * 有类型、能写逻辑、能读环境变量，还不用额外解析器。
 */

import type { ProviderConfig } from "../provider/registry.ts";
import type { PermissionDecision, PermissionRule } from "../permission/policy.ts";
import type { SandboxMode } from "../permission/mode.ts";
import type { AlertConfig } from "../permission/alert.ts";
import type { McpStdioServerConfig } from "../mcp/stdio.ts";
import type { ReviewPolicy } from "../goal/types.ts";

export interface AgentConfig {
  /** system prompt Markdown 文件；相对路径按 cwd 解析，支持 ~。 */
  systemPromptFile?: string;
  /** 单轮最大模型-工具往返次数；默认 800。 */
  maxSteps?: number;
  cwd?: string;
}

export interface PermissionsConfig {
  /** 没命中任何规则时的默认决策，默认 "ask"。 */
  default?: PermissionDecision;
  rules?: PermissionRule[];
}

export interface SandboxConfig {
  /** 沙箱档位：read-only / workspace-write / no-sandbox。 */
  mode?: SandboxMode;
  /** 额外可写路径（仅沙箱档位有效）。 */
  writablePaths?: string[];
  /**
   * 启动时就允许联网（等价于 `--allow-network`）。
   *
   * 默认 false —— 联网是**按次授权**的：命令先在断网沙箱里真跑一次，失败了
   * 再拿着真实报错问用户。这个开关只用于"我就是要全程联网"的场景。
   */
  allowNetwork?: boolean;
  /**
   * 额外放行给子进程的环境变量名。
   *
   * 默认是**白名单制** —— 只保留 PATH/HOME/TERM/LANG 等少数几个，
   * 其余（含各种 API key）一律剔除。需要什么显式加进来。
   */
  passEnv?: string[];
}

export interface McpConfig {
  /** Stdio MCP servers. Each server receives a separate capability grant. */
  servers?: McpStdioServerConfig[];
}

export interface SkillsConfig {
  /** Additional skill roots. Defaults still apply unless disableDefaults is true. */
  paths?: string[];
  /** Use only `paths` instead of ~/.bugent/skills, ~/.agents/skills, and project roots. */
  disableDefaults?: boolean;
  /** Skill names omitted after root precedence is resolved. */
  disabled?: string[];
}

export interface GoalsConfig {
  enabled?: boolean;
  autoContinue?: boolean;
  maxConsecutiveTurns?: number;
  maxGoalTokenBudget?: number;
  contextRefresh?: "checkpoint" | "threshold" | "manual";
  handoffInlineBytes?: number;
  reviewPolicy?: ReviewPolicy;
  reviewModel?: string;
}

export interface BugentConfig {
  /** 形如 "openai/gpt-4o-mini"。 */
  defaultModel: string;
  providers: ProviderConfig[];
  agent?: AgentConfig;
  permissions?: PermissionsConfig;
  sandbox?: SandboxConfig;
  /**
   * 授权硬件提醒：弹窗出现 / 最后 N 秒 / 结论各响一次。
   *
   * 默认**关闭** —— 它会真的让机器发声，不能替用户默认打开。
   * 通道与节奏见 src/permission/alert.ts。
   */
  alert?: AlertConfig;
  mcp?: McpConfig;
  skills?: SkillsConfig;
  goals?: GoalsConfig;
}

export function defineConfig(config: BugentConfig): BugentConfig {
  return config;
}
