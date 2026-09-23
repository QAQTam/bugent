/**
 * 历史浏览状态机。
 *
 * 从 TuiApp 里抽出来，避免 followTail / historyOpen / anchor 只靠 PTY 验证。
 * 这里不碰终端、不碰渲染，只负责状态迁移。
 */

import { historyPaneHeights } from "./history-drawer.ts";
import { HISTORY_WINDOW_MULTIPLIER, maxScrollOffset } from "./transcript-layout.ts";

export interface HistoryViewState {
  /** 是否钉底跟随最新消息。 */
  followTail: boolean;
  /** 主消息区距底部的偏移。 */
  scrollOffset: number;
  /** 是否打开半屏历史抽屉。 */
  historyOpen: boolean;
  /** 历史抽屉上半屏距底部的偏移。 */
  historyOffset: number;
}

export function initialHistoryView(): HistoryViewState {
  return {
    followTail: true,
    scrollOffset: 0,
    historyOpen: false,
    historyOffset: 0,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function maxHistoryOffset(totalLines: number, height: number): number {
  return Math.max(0, totalLines - historyPaneHeights(height).top);
}

/** 内容行数变化后保持回看锚点，并重新夹紧所有偏移。 */
export function syncHistoryView(
  state: HistoryViewState,
  totalLines: number,
  height: number,
  deltaLines: number,
): HistoryViewState {
  let scrollOffset = state.scrollOffset;
  if (!state.followTail && deltaLines !== 0) scrollOffset += deltaLines;
  scrollOffset = clamp(scrollOffset, 0, maxScrollOffset(totalLines, height));

  let historyOffset = state.historyOffset;
  if (state.historyOpen && deltaLines !== 0) historyOffset += deltaLines;
  historyOffset = clamp(historyOffset, 0, maxHistoryOffset(totalLines, height));

  return {
    followTail: scrollOffset === 0,
    scrollOffset,
    historyOpen: state.historyOpen,
    historyOffset,
  };
}

export function scrollMainView(
  state: HistoryViewState,
  delta: number,
  totalLines: number,
  height: number,
): HistoryViewState {
  const offset = clamp(state.scrollOffset + delta, 0, maxScrollOffset(totalLines, height));
  return {
    ...state,
    followTail: offset === 0,
    scrollOffset: offset,
  };
}

export function scrollHistoryView(
  state: HistoryViewState,
  delta: number,
  totalLines: number,
  height: number,
): HistoryViewState {
  if (!state.historyOpen) return state;
  return {
    ...state,
    historyOffset: clamp(state.historyOffset + delta, 0, maxHistoryOffset(totalLines, height)),
  };
}

export function openHistoryView(
  state: HistoryViewState,
  totalLines: number,
  height: number,
): HistoryViewState {
  const mainMax = maxScrollOffset(totalLines, height);
  const max = maxHistoryOffset(totalLines, height);
  return {
    ...state,
    historyOpen: true,
    historyOffset: Math.min(max, mainMax + height),
  };
}

export function closeHistoryView(state: HistoryViewState): HistoryViewState {
  if (!state.historyOpen) return state;
  return {
    ...state,
    historyOpen: false,
    historyOffset: 0,
  };
}

export function returnToLatestView(_state: HistoryViewState): HistoryViewState {
  return {
    followTail: true,
    scrollOffset: 0,
    historyOpen: false,
    historyOffset: 0,
  };
}

export function shouldShowMoreButton(
  state: HistoryViewState,
  totalLines: number,
  height: number,
): boolean {
  const max = maxScrollOffset(totalLines, height);
  return totalLines > height * HISTORY_WINDOW_MULTIPLIER && max > 0 && state.scrollOffset >= max;
}

export function shouldShowReturnButton(state: HistoryViewState): boolean {
  return !state.followTail || state.historyOpen;
}
