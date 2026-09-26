/**
 * 内置工具渲染器的注册聚合点。
 *
 * 为什么需要这个文件：
 *   之前把 `registerToolRenderer(TODO_TOOL_NAME, ...)` 放在 src/index.ts，
 *   结果只有 CLI 入口能生效 —— 直接 import TuiApp 的场景（测试、冒烟脚本、
 *   将来的 WebUI）全都拿不到自定义外观，todo 又变回一坨 JSON。
 *
 * 现在由 TuiApp 构造时自动调用，且幂等。代价是这个文件认识工具名，
 * 但它是**唯一**认识的地方，而且只是映射表，没有渲染逻辑。
 *
 * 新增带自定义外观的工具 = 加一个 renderer 文件 + 这里加一行。
 */

import { registerToolDisplayName, registerToolRenderer } from "./renderers.ts";
import { renderTodoTool } from "./render-todo.ts";
import {
  renderApplyPatchTool,
  renderBashTool,
  renderDiffTool,
  renderReadFileTool,
} from "./render-tools.ts";
import { TODO_TOOL_NAME } from "../tools/todo.ts";
import { APPLY_PATCH_TOOL_NAME } from "../tools/apply-patch.ts";

let registered = false;

/**
 * 工具注册名 -> TUI 显示名。
 *
 * 只有这里的映射表认识工具名（见文件头）。加新工具时两边各加一行：renderer 决定
 * 长什么样，显示名决定叫它什么。没列的工具照原样显示注册名。
 */
const DISPLAY_NAMES: readonly (readonly [string, string])[] = [
  ["bash", "Bash"],
  ["read_file", "Read"],
  ["write_file", "Write"],
  ["edit_file", "Edit"],
  [APPLY_PATCH_TOOL_NAME, "Patch"],
  [TODO_TOOL_NAME, "Todo"],
];

export function registerBuiltinToolRenderers(): void {
  if (registered) return;
  registered = true;

  for (const [name, label] of DISPLAY_NAMES) registerToolDisplayName(name, label);

  registerToolRenderer(TODO_TOOL_NAME, renderTodoTool);
  registerToolRenderer("bash", renderBashTool);
  registerToolRenderer("read_file", renderReadFileTool);
  registerToolRenderer("write_file", renderDiffTool);
  registerToolRenderer("edit_file", renderDiffTool);
  registerToolRenderer(APPLY_PATCH_TOOL_NAME, renderApplyPatchTool);
}
