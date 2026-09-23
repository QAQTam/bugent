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

import { registerToolRenderer } from "./renderers.ts";
import { renderTodoTool } from "./render-todo.ts";
import { TODO_TOOL_NAME } from "../tools/todo.ts";

let registered = false;

export function registerBuiltinToolRenderers(): void {
  if (registered) return;
  registered = true;

  registerToolRenderer(TODO_TOOL_NAME, renderTodoTool);
}
