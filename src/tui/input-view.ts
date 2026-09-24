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

export interface InputLayout {
  /** Wrapped visual lines. Newlines start a new line even when width remains. */
  lines: string[];
  /** Character index at the start of each visual line. */
  starts: number[];
  /** Cursor row inside `lines`. */
  cursorRow: number;
  /** 0-based visible column inside the cursor row. */
  cursorColumn: number;
}

export function layoutInput(
  input: string,
  cursor: number,
  available: number,
): InputLayout {
  const chars = Array.from(input);
  const safeAvailable = Math.max(1, available);
  const safeCursor = Math.max(0, Math.min(cursor, chars.length));
  const lines = [""];
  const starts = [0];
  let row = 0;
  let column = 0;
  let cursorRow = 0;
  let cursorColumn = 0;

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (char === "\n") {
      if (index === safeCursor) {
        cursorRow = row;
        cursorColumn = column;
      }
      row += 1;
      lines.push("");
      starts.push(index + 1);
      column = 0;
      continue;
    }

    const width = Math.max(0, visibleWidth(char));
    if (column > 0 && column + width > safeAvailable) {
      row += 1;
      lines.push("");
      starts.push(index);
      column = 0;
    }
    if (index === safeCursor) {
      cursorRow = row;
      cursorColumn = column;
    }
    lines[row] += char;
    column += width;
  }

  if (safeCursor === chars.length) {
    cursorRow = row;
    cursorColumn = column;
  }

  return { lines, starts, cursorRow, cursorColumn };
}

/** Convert a visual row/column back to a character index. */
export function inputIndexAt(layout: InputLayout, row: number, column: number): number {
  const safeRow = Math.max(0, Math.min(row, layout.lines.length - 1));
  const line = layout.lines[safeRow] ?? "";
  const start = layout.starts[safeRow] ?? 0;
  let width = 0;
  let count = 0;
  for (const char of Array.from(line)) {
    const next = width + Math.max(0, visibleWidth(char));
    if (next > column) break;
    width = next;
    count += 1;
  }
  return start + count;
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
