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

/**
 * TUI 显示名。
 *
 * 工具名（`write_file` / `apply_patch`）是**给模型看的协议标识**，不是给人看的
 * 文案：卡片头部是用户扫一眼就知道"它干了什么"的地方，不该出现下划线和内部
 * 命名。映射集中在这里（本文件已经是"唯一认识工具名的地方"），未知工具**回退
 * 注册名** —— 宁可显示得难看，也不要静默丢掉"这是哪个工具"这条信息。
 */
const displayNames = new Map<string, string>();

export function registerToolDisplayName(name: string, label: string): void {
  displayNames.set(name, label);
}

export function toolDisplayName(name: string): string {
  return displayNames.get(name) ?? name;
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
  const label = toolDisplayName(item.name);
  const budget = Math.max(0, width - visibleWidth(label) - 4);
  const head = `${fg(COLOR.tool)}⏺${RESET} ${BOLD}${label}${RESET} ${DIM}${truncateAnsi(
    argsText,
    budget,
  )}${RESET}`;

  const lines = [head];
  if (item.evicted === true) {
    // PERF-002：正文已移出内存。这不是错误态，引导用户点击回放。
    lines.push(`${DIM}  （更早内容已从内存释放 —— 点击此卡片重新加载回放）${RESET}`);
    return lines;
  }
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
  // 已释放的卡片不走自定义渲染器 —— 它们会去解析已经清空的 output。
  if (item.evicted === true) return renderGenericTool(item, width);
  const custom = registry.get(item.name);
  const lines = custom !== undefined ? custom(item, width) : renderGenericTool(item, width);

  // 兜底：工具卡片返回的**任何一行**都不许超过 width。
  //
  // 该折行的（路径、命令、正文）在各自渲染器里已经折了，这里只兜住那些固定
  // 文案 —— "… 还有 N 行（点击展开）"、"… 还有 N 个文件"、"[exit code: N]" ——
  // 它们在极窄终端上比 width 还宽。放在这个出口而不是每处各夹一次：卡片形态
  // 再多也不用记得加。
  return lines.map((line) => truncateAnsi(line, width));
}
