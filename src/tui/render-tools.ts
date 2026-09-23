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
import { parseDiffStat, type DiffStat } from "../tools/diff.ts";

/** 折叠规格：头几行 + 尾几行。 */
export const FOLD_SPEC = {
  bash: { head: 2, tail: 2 },
  file: { head: 3, tail: 3 },
} as const;

/** diff 默认展示的最大行数（超出走"点击展开"）。 */
export const DIFF_DISPLAY_LINES = 14;

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

/**
 * 头部行：`⏺ 工具名 摘要`，可选在**右侧右对齐**一个徽标（如 `+12 -3`）。
 *
 * 右对齐要 ANSI 感知：徽标的可见宽度用 visibleWidth 算，
 * 而不是字符串长度 —— 否则带颜色的 `+12 -3` 会把间隔算错。
 * 窄屏时先压缩摘要，摘要压到 0 就直接不要它，保证徽标不被挤掉。
 */
function header(item: ToolItem, width: number, marker: string, color: string, badge = ""): string {
  const badgeWidth = visibleWidth(badge);
  const reserved = badgeWidth > 0 ? badgeWidth + 1 : 0; // 徽标 + 至少 1 格间隔

  const nameWidth = visibleWidth(item.name);
  const summaryBudget = Math.max(0, width - reserved - nameWidth - 4);
  const summary = argsSummary(item);

  const left =
    `${fg(color)}${marker}${RESET} ${BOLD}${item.name}${RESET}` +
    (summary.length > 0 && summaryBudget > 0
      ? ` ${DIM}${truncateAnsi(summary, summaryBudget)}${RESET}`
      : "");

  if (badgeWidth === 0) return left;

  const gap = Math.max(1, width - visibleWidth(left) - badgeWidth);
  return `${left}${" ".repeat(gap)}${badge}`;
}

/**
 * 从**开头**截断，而不是头尾都留。
 *
 * diff 专用：头尾折叠会把改动（通常在中段）藏起来，只剩一堆没变的上下文 ——
 * 而且 `compactDiff` 已经裁过远处上下文了，这里再折一层纯属帮倒忙。
 * 所以只保留开头若干行，剩下的交给"点击展开"。
 */
function foldTail(lines: readonly string[], max: number, color: string, expanded = false): string[] {
  if (expanded || lines.length <= max) return [...lines];

  const shown = lines.slice(0, max - 1);
  const note = `${DIM}${fg(color)}  … 还有 ${lines.length - shown.length} 行（点击展开）${RESET}`;
  return [...shown, note];
}

/** `+12 -3` 徽标，带颜色。增删为 0 的部分不显示。 */
export function formatStatBadge(stat: DiffStat): string {
  const parts: string[] = [];
  if (stat.added > 0) parts.push(`${fg(COLOR.diffAdd)}+${stat.added}${RESET}`);
  if (stat.removed > 0) parts.push(`${fg(COLOR.diffRemove)}-${stat.removed}${RESET}`);
  return parts.join(" ");
}

/** 折叠成「头 N 行 + 已忽略 M 行 + 尾 K 行」。展开状态下原样返回。 */
export function foldLines(
  lines: readonly string[],
  head: number,
  tail: number,
  color: string,
  expanded = false,
): string[] {
  if (expanded) return [...lines];
  if (lines.length <= head + tail + 1) return [...lines];

  const omitted = lines.length - head - tail;
  const note = `${DIM}${fg(color)}  … 已忽略 ${omitted} 行 …（点击展开）${RESET}`;
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
  return [head, ...foldLines(body, FOLD_SPEC.bash.head, FOLD_SPEC.bash.tail, color, item.expanded)];
}

/* ------------------------------------------------------------------ */
/* 文件工具                                                            */
/* ------------------------------------------------------------------ */

export function renderReadFileTool(item: ToolItem, width: number): string[] {
  const head = header(item, width, "⏺", COLOR.tool);
  if (!item.done) return [head, `${DIM}  读取中…${RESET}`];

  const color = item.ok ? COLOR.toolOk : COLOR.error;
  const body = bodyLines(item.output, width, color);
  return [head, ...foldLines(body, FOLD_SPEC.file.head, FOLD_SPEC.file.tail, color, item.expanded)];
}

/** write_file / edit_file：按 diff 语义着色，右侧右对齐 +N -M。 */
export function renderDiffTool(item: ToolItem, width: number): string[] {
  // 统计从工具输出里反解 —— 不需要额外字段，也不会和模型看到的内容不一致
  const stat = item.done && item.ok ? parseDiffStat(item.output) : undefined;
  const head = header(item, width, "⏺", COLOR.tool, stat === undefined ? "" : formatStatBadge(stat));

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

  return [
    head,
    ...lines,
    ...foldTail(colored, DIFF_DISPLAY_LINES, COLOR.tool, item.expanded),
  ];
}
