/**
 * Reasoning / Thought 的纯渲染。
 *
 * live 只画一行，不触碰完整正文；完成态默认折叠，只有 expanded=true 才交给
 * Markdown renderer。这样流式热路径不会因为完整思考文本反复布局。
 */

import type { DisplayItem } from "./transcript.ts";
import { BOLD, DIM, RESET, fg, renderMarkdown } from "./markdown.ts";
import { truncateAnsi } from "./ansi.ts";
import { COLOR } from "./theme.ts";
import { formatTokenCount } from "./metrics.ts";

export type ReasoningItem = Extract<DisplayItem, { kind: "reasoning" }>;

/** 毫秒 -> 紧凑耗时文案；恢复会话没有 durationMs 时调用方直接省略。 */
export function formatReasoningDuration(durationMs: number): string {
  const safe = Math.max(0, durationMs);
  if (safe < 1000) return `${Math.round(safe)}ms`;

  const seconds = safe / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

function reasoningHeader(item: ReasoningItem, width: number): string {
  if (!item.done) {
    return truncateAnsi(
      `${DIM}${fg(COLOR.reasoningSpinnerDim)}✻${RESET} ${DIM}Thinking…${RESET}`,
      width,
    );
  }

  const marker = item.expanded ? "−" : "✦";
  const label = item.sequence === undefined ? "Thought" : `Thought ${item.sequence}`;
  const meta: string[] = [];
  if (item.durationMs !== undefined) meta.push(formatReasoningDuration(item.durationMs));
  if (item.tokens !== undefined) meta.push(`${formatTokenCount(item.tokens)} tok`);
  if (item.interrupted === true) meta.push("interrupted");

  const suffix = [
    meta.length > 0 ? `${DIM}· ${meta.join(" · ")}${RESET}` : "",
    `${DIM}（点击${item.expanded ? "折叠" : "展开"}）${RESET}`,
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  return truncateAnsi(
    `${fg(COLOR.reasoning)}${BOLD}${marker}${RESET} ${BOLD}${label}${RESET} ${suffix}`,
    width,
  );
}

/** 渲染一个 reasoning item；折叠态绝不渲染 item.text。 */
export function renderReasoningItem(item: ReasoningItem, width: number): string[] {
  const lines = [reasoningHeader(item, width)];
  if (!item.done || !item.expanded || item.text.length === 0) return lines;

  const bodyWidth = Math.max(1, width - 2);
  for (const line of renderMarkdown(item.text, bodyWidth)) {
    lines.push(line.length > 0 ? `  ${line}` : line);
  }
  return lines;
}
