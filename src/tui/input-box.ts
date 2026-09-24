/**
 * 输入框：制表符框的几何、渲染与鼠标命中映射。
 *
 * 三处消费者必须共用同一份几何 —— 渲染、硬件光标定位、鼠标点击换算。
 * 任何一处自己算一遍宽度或列偏移，都会让光标和实际文本差一列，
 * 而这种偏差只有在真终端里才看得出来。
 *
 * 关于"焦点"：输入框**没有**激活状态。它永远是按键汇聚点，点击框外
 * 只影响光标位置（或者什么都不做），不会让后续按键被丢弃。因此这里
 * 只有"这次点击落在框内的哪个字符上"，没有 focus / blur 概念。
 */

import { truncateAnsi, visibleWidth } from "./ansi.ts";
import { inputIndexAt, type InputLayout } from "./input-view.ts";
import { fg, RESET } from "./markdown.ts";
import { COLOR } from "./theme.ts";

/** 边框宽度（左右各一条竖线）。 */
export const INPUT_BORDER = 1;
/** 边框与文本之间的内边距。 */
export const INPUT_PADDING = 1;
/** 内容区最多显示多少行；超出的部分跟随光标滚动。 */
export const INPUT_MAX_CONTENT_ROWS = 5;
/** 空输入时的占位提示。 */
export const INPUT_PLACEHOLDER = "输入消息，/ 查看命令";

export interface InputBoxGeometry {
  /** 整框宽度（含左右边框），比终端宽度少 1 格。 */
  boxWidth: number;
  /** 文本区可容纳的显示列数。 */
  textWidth: number;
  /** 文本区首列（1-based 终端列）。 */
  textLeft: number;
}

export function inputBoxGeometry(width: number): InputBoxGeometry {
  // 末尾留一格：写满整行会让终端自动折行，把布局顶乱
  const boxWidth = Math.max(3, width - 1);
  const chrome = INPUT_BORDER + INPUT_PADDING;
  return {
    boxWidth,
    textWidth: Math.max(1, boxWidth - 2 * chrome),
    textLeft: chrome + 1,
  };
}

export interface InputBoxRows {
  /** 内容区可见行数（1..INPUT_MAX_CONTENT_ROWS）。 */
  contentRows: number;
  /** 整框高度 = 内容行数 + 上下边框。 */
  boxHeight: number;
  /** 内容区的高度预算：保证状态栏与至少 1 行正文之后还剩多少行。 */
  budgetRows: number;
}

/**
 * 输入框高度：按输入行数增长并封顶。
 *
 * 空输入是 1 行内容（整个框 3 行），只有折行或显式换行才长高，
 * 因此"单行为主"是默认形态。高度上限同时受终端高度约束：
 * 正文高度是 `height - 3 - contentRows - todo - thinking`，必须 >= 1。
 */
export function inputBoxRows(options: {
  height: number;
  inputLines: number;
  todoRows: number;
  thinkingRows: number;
}): InputBoxRows {
  const budgetRows = Math.max(
    1,
    options.height - 4 - options.todoRows - options.thinkingRows,
  );
  const contentRows = Math.max(
    1,
    Math.min(options.inputLines, INPUT_MAX_CONTENT_ROWS, budgetRows),
  );
  return { contentRows, boxHeight: contentRows + 2, budgetRows };
}

/** 输入框在屏幕上的位置；行号与列号都是 1-based。 */
export interface InputBoxRect {
  /** 整框首行。 */
  top: number;
  /** 整框高度（含上下边框）。 */
  height: number;
  /** 内容区首行。 */
  contentTop: number;
  /** 内容区可见行数。 */
  contentRows: number;
  /** 内容区首行对应的 `layout.lines` 下标；内容滚动时大于 0。 */
  startRow: number;
  /** 文本区首列。 */
  textLeft: number;
  /** 整框宽度。 */
  boxWidth: number;
}

/**
 * 屏幕坐标 -> 输入框内的字符索引。
 *
 * 返回 undefined 表示这次点击不在框内，调用方什么都不该做 —— 这正是
 * "输入框永远可输入"的实现方式：点击框外不产生任何需要后续按键去解除
 * 的状态。
 *
 * 点在边框上时按最近的内容行处理，所以边框不是死区。
 */
export function inputCursorFromClick(
  rect: InputBoxRect | undefined,
  layout: InputLayout,
  x: number,
  y: number,
): number | undefined {
  if (rect === undefined) return undefined;
  if (y < rect.top || y >= rect.top + rect.height) return undefined;
  if (x < 1 || x > rect.boxWidth) return undefined;

  const rowInBox = y - rect.contentTop;
  const offset = Math.max(0, Math.min(rowInBox, rect.contentRows - 1));
  const column = Math.max(0, x - rect.textLeft);
  return inputIndexAt(layout, rect.startRow + offset, column);
}

export interface InputBoxFrame {
  /** 整框的屏幕行，含上下边框。 */
  lines: string[];
  rect: InputBoxRect;
  /** 硬件光标位置：框内 0-based 行号 + 1-based 终端列。 */
  cursor: { row: number; column: number };
}

export function composeInputBox(options: {
  width: number;
  /** 整框首行（1-based 屏幕行）。 */
  top: number;
  input: string;
  layout: InputLayout;
  contentRows: number;
  placeholder?: string;
}): InputBoxFrame {
  const geometry = inputBoxGeometry(options.width);
  const { layout, contentRows } = options;
  const maxStart = Math.max(0, layout.lines.length - contentRows);
  const startRow = Math.max(0, Math.min(layout.cursorRow - contentRows + 1, maxStart));

  const border = fg(COLOR.inputEdge);
  const text = fg(COLOR.inputText);
  const rule = "─".repeat(Math.max(0, geometry.boxWidth - 2));
  const lines: string[] = [`${border}┌${rule}┐${RESET}`];

  for (let index = 0; index < contentRows; index += 1) {
    const line = layout.lines[startRow + index];
    let body = "";
    if (line !== undefined && line.length > 0) {
      body = `${text}${line}${RESET}`;
    } else if (
      options.placeholder !== undefined &&
      options.input.length === 0 &&
      index === 0
    ) {
      const hint = truncateAnsi(options.placeholder, geometry.textWidth);
      body = `${fg(COLOR.inputPlaceholder)}${hint}${RESET}`;
    }
    const padding = " ".repeat(Math.max(0, geometry.textWidth - visibleWidth(body)));
    lines.push(`${border}│${RESET} ${body}${padding} ${border}│${RESET}`);
  }

  lines.push(`${border}└${rule}┘${RESET}`);

  return {
    lines,
    rect: {
      top: options.top,
      height: contentRows + 2,
      contentTop: options.top + 1,
      contentRows,
      startRow,
      textLeft: geometry.textLeft,
      boxWidth: geometry.boxWidth,
    },
    cursor: {
      row: 1 + (layout.cursorRow - startRow),
      column: geometry.textLeft + layout.cursorColumn,
    },
  };
}
