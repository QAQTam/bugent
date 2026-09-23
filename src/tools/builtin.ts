/**
 * 默认工具集装配处。
 *
 * 集中在一处的好处：Phase 6 换沙箱 runner、Phase 7 加文件工具时，
 * 都只改这个文件，CLI / TUI 不需要知道细节。
 */

import { createBashTool, createShellRunner, type ShellRunner } from "./bash.ts";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
} from "./files.ts";
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
  // 文件工具是进程内操作，靠路径约束而不是 bwrap 隔离
  const registry = new ToolRegistry()
    .register(createReadFileTool())
    .register(createWriteFileTool())
    .register(createEditFileTool());

  let runner: ShellRunner;
  let sandbox: ToolsSetup["sandbox"];

  if (options.runner !== undefined) {
    runner = options.runner;
    sandbox = { enabled: false, note: "使用自定义执行层" };
  } else if (options.sandbox === null) {
    runner = createShellRunner();
    sandbox = { enabled: false, note: "沙箱已被显式禁用（--no-sandbox）" };
  } else if (!isSandboxAvailable()) {
    runner = createShellRunner();
    sandbox = {
      enabled: false,
      note: "未找到 bwrap，已降级为无沙箱执行（权限确认仍然生效）",
    };
  } else {
    const sandboxOptions = options.sandbox ?? {};
    runner = createSandboxedShellRunner(sandboxOptions);
    const network = sandboxOptions.allowNetwork === true ? "允许联网" : "已断网";
    sandbox = {
      enabled: true,
      note: `bwrap 沙箱已启用（只读根 / 可写工作目录 / ${network}）`,
    };
  }

  registry.register(createBashTool(runner));
  return { registry, sandbox };
}
