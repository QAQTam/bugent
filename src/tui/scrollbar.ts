/**
 * Scrollbar geometry and rendering for the full-screen TUI.
 *
 * The scrollbar represents the main viewport's accessible scrollback range.
 * `scrollOffset = 0` is the live tail (thumb at the bottom); max offset is the
 * oldest line reachable from the main view (thumb at the top).
 */

import { padAnsi, truncateAnsi } from "./ansi.ts";
import { DIM, fg, RESET } from "./markdown.ts";
import { COLOR } from "./theme.ts";
import { maxScrollOffset } from "./transcript-layout.ts";

export interface ScrollbarMetrics {
  /** 1-based screen row of the first track cell. */
  trackTop: number;
  /** Number of track cells. */
  trackHeight: number;
  /** 1-based terminal column. */
  trackColumn: number;
  /** 1-based screen row of the first thumb cell. */
  thumbTop: number;
  /** Number of thumb cells. */
  thumbHeight: number;
  /** Maximum main-viewport scroll offset. */
  maxOffset: number;
  /** Viewport height represented by one thumb span. */
  viewportHeight: number;
}

export interface CreateScrollbarOptions {
  trackTop: number;
  trackHeight: number;
  trackColumn: number;
  totalLines: number;
  viewportHeight: number;
  scrollOffset: number;
  /** Override the computed max offset when the caller uses a different scroll clamp. */
  maxOffset?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function createScrollbarMetrics(
  options: CreateScrollbarOptions,
): ScrollbarMetrics | undefined {
  const trackHeight = Math.max(0, Math.floor(options.trackHeight));
  const viewportHeight = Math.max(1, Math.floor(options.viewportHeight));
  const maxOffset =
    options.maxOffset ?? maxScrollOffset(options.totalLines, viewportHeight);
  if (trackHeight <= 0 || maxOffset <= 0 || options.trackColumn < 1) return undefined;

  const contentSpan = viewportHeight + maxOffset;
  const thumbHeight = clamp(
    Math.round((trackHeight * viewportHeight) / contentSpan),
    1,
    trackHeight,
  );
  const travel = trackHeight - thumbHeight;
  const progress = clamp(options.scrollOffset / maxOffset, 0, 1);
  const thumbTop = options.trackTop + Math.round(travel * (1 - progress));

  return {
    trackTop: options.trackTop,
    trackHeight,
    trackColumn: options.trackColumn,
    thumbTop,
    thumbHeight,
    maxOffset,
    viewportHeight,
  };
}

export function scrollbarThumbAt(metrics: ScrollbarMetrics, y: number): boolean {
  return y >= metrics.thumbTop && y < metrics.thumbTop + metrics.thumbHeight;
}

export function hitScrollbar(metrics: ScrollbarMetrics | undefined, x: number, y: number): boolean {
  return (
    metrics !== undefined &&
    x === metrics.trackColumn &&
    y >= metrics.trackTop &&
    y < metrics.trackTop + metrics.trackHeight
  );
}

/** Map a pointer row to scrollOffset while preserving the grabbed thumb offset. */
export function scrollOffsetFromDrag(
  metrics: ScrollbarMetrics,
  y: number,
  grabOffset: number,
): number {
  const travel = metrics.trackHeight - metrics.thumbHeight;
  if (travel <= 0) return metrics.maxOffset;
  const thumbTop = clamp(
    y - grabOffset,
    metrics.trackTop,
    metrics.trackTop + travel,
  );
  const progressFromTop = (thumbTop - metrics.trackTop) / travel;
  return Math.round((1 - progressFromTop) * metrics.maxOffset);
}

export function composeScrollbar(
  lines: readonly string[],
  width: number,
  metrics: ScrollbarMetrics,
  screenTop = 1,
): string[] {
  if (width < 2) return [...lines];
  const out = [...lines];
  for (let offset = 0; offset < metrics.trackHeight; offset += 1) {
    const lineIndex = metrics.trackTop - screenTop + offset;
    if (lineIndex < 0 || lineIndex >= out.length) continue;
    const thumb = scrollbarThumbAt(metrics, metrics.trackTop + offset);
    const glyph = thumb
      ? `${fg(COLOR.inputEdge)}█${RESET}`
      : `${DIM}│${RESET}`;
    const content = truncateAnsi(out[lineIndex] ?? "", width - 1);
    out[lineIndex] = `${padAnsi(content, width - 1)}${glyph}`;
  }
  return out;
}
