/**
 * 历史抽屉布局。
 *
 * 主消息区只保留最近三屏；更早内容从这里进入：
 *   上半屏：可独立回看的更早消息
 *   下半屏：始终钉底的最近消息
 *
 * 这里保持纯函数，方便单测；TuiApp 只负责取 window、路由按键和鼠标。
 */

import { truncateAnsi, visibleWidth } from "./ansi.ts";
import type { HitRect } from "./hit.ts";
import { DIM, RESET } from "./markdown.ts";

export interface HistoryPaneHeights {
  top: number;
  divider: number;
  bottom: number;
}

export function historyPaneHeights(height: number): HistoryPaneHeights {
  const safeHeight = Math.max(1, Math.floor(height));
  if (safeHeight === 1) return { top: 1, divider: 0, bottom: 0 };

  const divider = 1;
  const available = safeHeight - divider;
  const top = Math.max(1, Math.floor(available / 2));
  const bottom = Math.max(0, available - top);
  return { top, divider, bottom };
}

export interface CenteredButton {
  line: string;
  hit: HitRect;
}

/** 生成居中按钮行，并返回可点击的可见列区间。 */
export function composeCenteredButton(label: string, width: number, row: number): CenteredButton {
  const safeWidth = Math.max(0, Math.floor(width));
  const labelWidth = visibleWidth(label);
  const left = Math.max(0, Math.floor((safeWidth - labelWidth) / 2));
  const available = Math.max(0, safeWidth - left);
  const line = `${" ".repeat(left)}${truncateAnsi(label, available)}`;
  return {
    line,
    hit: {
      top: row,
      bottom: row,
      left: left + 1,
      right: left + Math.min(labelWidth, available),
    },
  };
}

export interface HistoryDrawerInput {
  width: number;
  height: number;
  topLines: readonly string[];
  bottomLines: readonly string[];
  /** 距历史底部的偏移。 */
  offset: number;
  /** 历史区允许的最大偏移。 */
  maxOffset: number;
}

export interface HistoryDrawerLayout {
  lines: string[];
  dividerRow: number;
  topStart: number;
  topEnd: number;
  bottomStart: number;
  bottomEnd: number;
}

function padLines(lines: readonly string[], height: number): string[] {
  const out = lines.slice(0, height);
  while (out.length < height) out.push("");
  return out;
}

export function composeHistoryDrawer(input: HistoryDrawerInput): HistoryDrawerLayout {
  const heights = historyPaneHeights(input.height);
  const top = padLines(input.topLines, heights.top);
  const bottom = padLines(input.bottomLines, heights.bottom);

  const lines: string[] = [...top];
  let dividerRow = -1;
  if (heights.divider > 0) {
    dividerRow = lines.length;
    const left = `├─ 更早消息 · ↑↓ ${Math.max(0, input.offset)}/${Math.max(0, input.maxOffset)} `;
    const right = ` 最新消息 ─┤`;
    const fill = Math.max(0, input.width - Bun.stringWidth(left) - Bun.stringWidth(right));
    const divider = `${left}${"─".repeat(fill)}${right}`;
    lines.push(`${DIM}${truncateAnsi(divider, input.width)}${RESET}`);
  }

  const bottomStart = lines.length;
  lines.push(...bottom);

  return {
    lines: padLines(lines, input.height),
    dividerRow,
    topStart: 0,
    topEnd: heights.top,
    bottomStart,
    bottomEnd: bottomStart + bottom.length,
  };
}
