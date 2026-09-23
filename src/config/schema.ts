/**
 * 配置模型 —— Phase 5 的类型层。
 *
 * 配置写成 `bugent.config.ts`（Bun 原生 import TS），而不是 JSON：
 * 有类型、能写逻辑、能读环境变量，还不用额外解析器。
 */

import type { ProviderConfig } from "../provider/registry.ts";
import type { PermissionDecision, PermissionRule } from "../permission/policy.ts";
import type { SandboxMode } from "../permission/mode.ts";

export interface AgentConfig {
  systemPrompt?: string;
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
   * 额外放行给子进程的环境变量名。
   *
   * 默认是**白名单制** —— 只保留 PATH/HOME/TERM/LANG 等少数几个，
   * 其余（含各种 API key）一律剔除。需要什么显式加进来。
   */
  passEnv?: string[];
}

export interface BugentConfig {
  /** 形如 "openai/gpt-4o-mini"。 */
  defaultModel: string;
  providers: ProviderConfig[];
  agent?: AgentConfig;
  permissions?: PermissionsConfig;
  sandbox?: SandboxConfig;
}

export function defineConfig(config: BugentConfig): BugentConfig {
  return config;
}

export const DEFAULT_SYSTEM_PROMPT = [
  "You are bugent, a terminal-native coding agent.",
  "Be concise and direct. Prefer acting over explaining.",
  "When you need to inspect or change the workspace, use the provided tools.",
].join("\n");
