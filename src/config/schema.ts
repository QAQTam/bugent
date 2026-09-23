/**
 * 配置模型 —— Phase 5 的类型层。
 *
 * 配置写成 `bugent.config.ts`（Bun 原生 import TS），而不是 JSON：
 * 有类型、能写逻辑、能读环境变量，还不用额外解析器。
 */

import type { ProviderConfig } from "../provider/registry.ts";
import type { PermissionDecision, PermissionRule } from "../permission/policy.ts";
import type { SandboxOptions } from "../sandbox/bwrap.ts";

export interface AgentConfig {
  systemPrompt?: string;
  maxSteps?: number;
  cwd?: string;
}

export interface PermissionsConfig {
  /** 没命中任何规则时的默认决策，默认 "ask"。 */
  default?: PermissionDecision;
  rules?: PermissionRule[];
}

export interface SandboxConfig extends SandboxOptions {
  /** 设为 false 等价于不启用沙箱。 */
  enabled?: boolean;
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
