/**
 * 内置工具的折叠渲染。
 *
 * 设计目标：**工具输出可能极长，屏幕只给固定的几行**。
 *
 *   bash        最多 5 行：头 2 + 「已忽略 N 行」+ 尾 2
 *   read_file   头 3 + 「已忽略 N 行」+ 尾 3
 *   write/edit  同上，但内容是 diff（+/- 着色）
 *
 * 运行中的 bash 另走一条路：显示最新 6 行进度（对应
 * Transcript.TOOL_PROGRESS_LINES），让用户看到"现在跑到哪了"。
 */

import { BOLD, DIM, RESET, fg, renderPlain } from "./markdown.ts";
import { truncateAnsi, visibleWidth } from "./ansi.ts";
import { COLOR } from "./theme.ts";
import type { ToolItem } from "./renderers.ts";

/** 折叠规格：头几行 + 尾几行。 */
export const FOLD_SPEC = {
  bash: { head: 2, tail: 2 },
  file: { head: 3, tail: 3 },
} as const;

function argsSummary(item: ToolItem): string {
  const args = item.args as Record<string, unknown> | null;
  if (args === null || typeof args !== "object") return "";
  const command = args.command;
  if (typeof command === "string") return command;
  const path = args.path;
  if (typeof path === "string") return path;
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

function header(item: ToolItem, width: number, marker: string, color: string): string {
  const summary = argsSummary(item);
  const budget = Math.max(0, width - visibleWidth(item.name) - 4);
  return `${fg(color)}${marker}${RESET} ${BOLD}${item.name}${RESET} ${DIM}${truncateAnsi(
    summary,
    budget,
  )}${RESET}`;
}

/** 折叠成「头 N 行 + 已忽略 M 行 + 尾 K 行」。 */
export function foldLines(
  lines: readonly string[],
  head: number,
  tail: number,
  color: string,
): string[] {
  if (lines.length <= head + tail + 1) return [...lines];

  const omitted = lines.length - head - tail;
  const note = `${DIM}${fg(color)}  … 已忽略 ${omitted} 行 …${RESET}`;
  return [...lines.slice(0, head), note, ...lines.slice(lines.length - tail)];
}

function bodyLines(text: string, width: number, color: string): string[] {
  return renderPlain(text, Math.max(1, width - 2)).map(
    (line) => `${DIM}${fg(color)}  ${line}${RESET}`,
  );
}

/* ------------------------------------------------------------------ */
/* bash                                                                */
/* ------------------------------------------------------------------ */

export function renderBashTool(item: ToolItem, width: number): string[] {
  const head = header(item, width, "⏺", COLOR.tool);

  // 运行中：显示最新几行进度（Transcript 已经保证只留最后 N 行）
  if (!item.done) {
    const progress = item.progress.length > 0 ? item.progress : "…";
    const lines = renderPlain(progress, Math.max(1, width - 2));
    return [head, ...lines.map((line) => `${DIM}${line}${RESET}`)];
  }

  const color = item.ok ? COLOR.toolOk : COLOR.error;
  const body = bodyLines(item.output, width, color);
  return [head, ...foldLines(body, FOLD_SPEC.bash.head, FOLD_SPEC.bash.tail, color)];
}

/* ------------------------------------------------------------------ */
/* 文件工具                                                            */
/* ------------------------------------------------------------------ */

export function renderReadFileTool(item: ToolItem, width: number): string[] {
  const head = header(item, width, "⏺", COLOR.tool);
  if (!item.done) return [head, `${DIM}  读取中…${RESET}`];

  const color = item.ok ? COLOR.toolOk : COLOR.error;
  const body = bodyLines(item.output, width, color);
  return [head, ...foldLines(body, FOLD_SPEC.file.head, FOLD_SPEC.file.tail, color)];
}

/** write_file / edit_file：按 diff 语义着色。 */
export function renderDiffTool(item: ToolItem, width: number): string[] {
  const head = header(item, width, "⏺", COLOR.tool);
  if (!item.done) return [head, `${DIM}  写入中…${RESET}`];

  const [summary, ...rest] = item.output.split("\n");
  const lines: string[] = [`${DIM}${summary ?? ""}${RESET}`];

  const colored = rest.map((line) => {
    const prefix = line[0];
    const text = line.slice(1);
    if (prefix === "+") return `${fg(COLOR.diffAdd)}  +${text}${RESET}`;
    if (prefix === "-") return `${fg(COLOR.diffRemove)}  -${text}${RESET}`;
    return `${DIM}  ${line}${RESET}`;
  });

  return [head, ...lines, ...foldLines(colored, FOLD_SPEC.file.head, FOLD_SPEC.file.tail, COLOR.tool)];
}
