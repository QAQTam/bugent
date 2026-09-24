/**
 * Input viewport math shared by the TUI renderer and hardware cursor.
 *
 * The cursor column is 1-based relative to the whole input row, including the
 * `▌ ` prefix. `available` is the number of visible text cells between that
 * prefix and the reserved right edge.
 */

import { visibleWidth } from "./ansi.ts";

export interface InputViewport {
  /** First character index rendered in the viewport. */
  start: number;
  /** 1-based terminal column of the hardware cursor. */
  cursorColumn: number;
  /** Width of the character under the cursor, or 1 at end-of-input. */
  cursorWidth: number;
}

export function inputViewport(
  input: string,
  cursor: number,
  available: number,
): InputViewport {
  const chars = Array.from(input);
  const safeAvailable = Math.max(1, available);
  const safeCursor = Math.max(0, Math.min(cursor, chars.length));
  let start = 0;

  while (start < safeCursor) {
    const before = visibleWidth(chars.slice(start, safeCursor).join(""));
    const current = chars[safeCursor];
    const currentWidth = current === undefined ? 1 : Math.max(1, visibleWidth(current));
    if (before + currentWidth <= safeAvailable) break;
    start += 1;
  }

  const before = visibleWidth(chars.slice(start, safeCursor).join(""));
  const current = chars[safeCursor];
  return {
    start,
    cursorColumn: before + 3,
    cursorWidth: current === undefined ? 1 : Math.max(1, visibleWidth(current)),
  };
}
