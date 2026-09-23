/**
 * 默认工具集装配处。
 *
 * 集中在一处的好处：Phase 6 换沙箱 runner、Phase 7 加文件工具时，
 * 都只改这个文件，CLI / TUI 不需要知道细节。
 */

import { createBashTool, createShellRunner, type ShellRunner } from "./bash.ts";
import { ToolRegistry } from "./types.ts";

export interface DefaultToolsOptions {
  /** 覆盖执行层（Phase 6 会传入沙箱 runner）。 */
  runner?: ShellRunner;
}

export function createDefaultTools(options: DefaultToolsOptions = {}): ToolRegistry {
  const runner = options.runner ?? createShellRunner();
  return new ToolRegistry().register(createBashTool(runner));
}
