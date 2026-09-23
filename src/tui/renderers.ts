/**
 * 工具渲染扩展点。
 *
 * 目的：让 TUI 核心**不认识任何具体工具名**。
 *
 *   - 通用工具（bash / read_file / …）走 renderGenericTool，什么都不用注册
 *   - 需要自定义外观的工具（todo_write 的 checkbox 列表）注册一个 renderer
 *
 * 注册发生在组装根（src/index.ts），不在这里 import 任何具体工具 ——
 * 否则这个文件就又变成耦合点了。
 */

import type { DisplayItem } from "./transcript.ts";
import { BOLD, DIM, RESET, fg, renderPlain } from "./markdown.ts";
import { truncateAnsi, visibleWidth } from "./ansi.ts";
import { COLOR } from "./theme.ts";

export type ToolItem = Extract<DisplayItem, { kind: "tool" }>;

/** 返回若干行；返回空数组表示"这次没什么可显示的"。 */
export type ToolRenderer = (item: ToolItem, width: number) => string[];

const registry = new Map<string, ToolRenderer>();

export function registerToolRenderer(name: string, renderer: ToolRenderer): void {
  registry.set(name, renderer);
}

export function registeredToolRenderers(): string[] {
  return [...registry.keys()];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

/** 默认外观：`⏺ 工具名 {参数}` + 输出。 */
export function renderGenericTool(item: ToolItem, width: number): string[] {
  const argsText = safeJson(item.args);
  const budget = Math.max(0, width - visibleWidth(item.name) - 4);
  const head = `${fg(COLOR.tool)}⏺${RESET} ${BOLD}${item.name}${RESET} ${DIM}${truncateAnsi(
    argsText,
    budget,
  )}${RESET}`;

  const lines = [head];
  if (item.done) {
    const color = item.ok ? COLOR.toolOk : COLOR.error;
    for (const line of renderPlain(item.output, Math.max(1, width - 2))) {
      lines.push(`${DIM}${fg(color)}  ${line}${RESET}`);
    }
  }
  return lines;
}

/** 查表渲染，没有注册就回退到通用外观。 */
export function renderToolItem(item: ToolItem, width: number): string[] {
  const custom = registry.get(item.name);
  if (custom !== undefined) return custom(item, width);
  return renderGenericTool(item, width);
}
