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
import { createTodoWriteTool } from "./todo.ts";
import { ToolRegistry } from "./types.ts";
import type { PermissionRule } from "../permission/policy.ts";
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
  /**
   * 工具自报的默认权限规则。
   *
   * **组装权限策略时务必带上**，否则"无副作用工具自动放行"就失效了：
   *
   * ```ts
   * new PermissionPolicy(composePolicy(config.permissions, setup.defaultPermissionRules))
   * ```
   *
   * 单独列出来是为了让它在使用处可见 —— 之前只挂在 registry 上，
   * 调用方很容易忘，忘了之后 todo_write 会开始弹窗（安全但很烦）。
   */
  defaultPermissionRules: PermissionRule[];
}

export function createDefaultTools(options: DefaultToolsOptions = {}): ToolsSetup {
  // 进程内工具：文件工具靠路径约束，todo_write 无副作用，都不需要 bwrap
  const registry = new ToolRegistry()
    .register(createReadFileTool())
    .register(createWriteFileTool())
    .register(createEditFileTool())
    .register(createTodoWriteTool());

  let runner: ShellRunner;
  let enabled: boolean;
  let note: string;

  if (options.runner !== undefined) {
    runner = options.runner;
    enabled = false;
    note = "使用自定义执行层";
  } else if (options.sandbox === null) {
    runner = createShellRunner();
    enabled = false;
    note = "沙箱已被显式禁用（--no-sandbox）";
  } else if (!isSandboxAvailable()) {
    runner = createShellRunner();
    enabled = false;
    note = "未找到 bwrap，已降级为无沙箱执行（权限确认仍然生效）";
  } else {
    const sandboxOptions = options.sandbox ?? {};
    runner = createSandboxedShellRunner(sandboxOptions);
    enabled = true;
    const network = sandboxOptions.allowNetwork === true ? "允许联网" : "已断网";
    note = `bwrap 沙箱已启用（只读根 / 可写工作目录 / ${network}）`;
  }

  registry.register(createBashTool(runner));

  // 让 needsSandbox 真正生效：明确说出是哪些工具拿不到沙箱，
  // 而不是笼统地降级了事。
  if (!enabled) {
    const exposed = registry.requiresSandbox();
    if (exposed.length > 0) {
      note += `；以下工具将在无沙箱下运行：${exposed.join("、")}`;
    }
  }

  return {
    registry,
    sandbox: { enabled, note },
    defaultPermissionRules: registry.defaultPermissionRules(),
  };
}
