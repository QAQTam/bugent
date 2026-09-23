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
import { MODES, type SandboxMode } from "../permission/mode.ts";
import { createSandboxedShellRunner, isSandboxAvailable } from "../sandbox/bwrap.ts";

export interface DefaultToolsOptions {
  /** 沙箱档位。默认 workspace-write。 */
  mode?: SandboxMode;
  /** 额外可写路径（仅沙箱档位有效）。 */
  writablePaths?: readonly string[];
  /** 额外放行给子进程的环境变量名。 */
  passEnv?: readonly string[];
  /** 直接覆盖执行层（测试用，优先级最高）。 */
  runner?: ShellRunner;
}

export interface ToolsSetup {
  registry: ToolRegistry;
  /** 实际生效的档位。 */
  mode: SandboxMode;
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
   */
  defaultPermissionRules: PermissionRule[];
}

export function createDefaultTools(options: DefaultToolsOptions = {}): ToolsSetup {
  const mode = options.mode ?? "workspace-write";
  const caps = MODES[mode];

  // 进程内工具：文件工具靠路径约束 + 档位门控，todo_write 无副作用
  const registry = new ToolRegistry()
    .register(createReadFileTool())
    .register(createWriteFileTool())
    .register(createEditFileTool())
    .register(createTodoWriteTool());

  let runner: ShellRunner;
  let enabled: boolean;
  let note: string;
  /** 是否处于"断网沙箱"—— 决定 bash 失败后要不要走联网授权。 */
  let networkBlocked = false;

  if (options.runner !== undefined) {
    runner = options.runner;
    enabled = false;
    note = "使用自定义执行层";
  } else if (!caps.sandboxed) {
    runner = createShellRunner();
    enabled = false;
    note = `无沙箱（${mode}）· 可读写任意位置 · 网络不受限`;
  } else if (!isSandboxAvailable()) {
    runner = createShellRunner();
    enabled = false;
    note = "未找到 bwrap，已降级为无沙箱执行（档位门控仍然生效）";
  } else {
    runner = createSandboxedShellRunner(
      {
        workspaceWrite: caps.workspaceWrite,
        ...(options.writablePaths !== undefined ? { writablePaths: options.writablePaths } : {}),
        allowNetwork: false,
      },
      undefined,
      { ...(options.passEnv !== undefined ? { passEnv: options.passEnv } : {}) },
    );
    enabled = true;
    networkBlocked = true;
    note = `bwrap 沙箱 · ${caps.label}`;
  }

  registry.register(createBashTool(runner, { networkBlocked }));

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
    mode,
    sandbox: { enabled, note },
    defaultPermissionRules: registry.defaultPermissionRules(),
  };
}
