/**
 * 默认工具集装配处。
 *
 * 集中在一处的好处：Phase 6 换沙箱 runner、Phase 7 加文件工具时，
 * 都只改这个文件，CLI / TUI 不需要知道细节。
 */

import { createBashTool, createShellRunner, type ShellRunner } from "./bash.ts";
import { ToolRegistry } from "./types.ts";
import {
  createSandboxedShellRunner,
  isSandboxAvailable,
  type SandboxOptions,
} from "../sandbox/bwrap.ts";

export interface DefaultToolsOptions {
  /**
   * 沙箱配置。
   *   省略  -> 可用就启用（默认行为）
   *   null  -> 显式禁用沙箱
   */
  sandbox?: SandboxOptions | null;
  /** 直接覆盖执行层（测试用，优先级最高）。 */
  runner?: ShellRunner;
}

export interface ToolsSetup {
  registry: ToolRegistry;
  sandbox: {
    enabled: boolean;
    /** 状态说明，用于在 TUI/CLI 上如实告知用户。 */
    note: string;
  };
}

export function createDefaultTools(options: DefaultToolsOptions = {}): ToolsSetup {
  if (options.runner !== undefined) {
    return {
      registry: new ToolRegistry().register(createBashTool(options.runner)),
      sandbox: { enabled: false, note: "使用自定义执行层" },
    };
  }

  if (options.sandbox === null) {
    return {
      registry: new ToolRegistry().register(createBashTool(createShellRunner())),
      sandbox: { enabled: false, note: "沙箱已被显式禁用（--no-sandbox）" },
    };
  }

  if (!isSandboxAvailable()) {
    return {
      registry: new ToolRegistry().register(createBashTool(createShellRunner())),
      sandbox: {
        enabled: false,
        note: "未找到 bwrap，已降级为无沙箱执行（权限确认仍然生效）",
      },
    };
  }

  const sandbox = options.sandbox ?? {};
  const network = sandbox.allowNetwork === true ? "允许联网" : "已断网";
  return {
    registry: new ToolRegistry().register(createBashTool(createSandboxedShellRunner(sandbox))),
    sandbox: {
      enabled: true,
      note: `bwrap 沙箱已启用（只读根 / 可写工作目录 / ${network}）`,
    },
  };
}
