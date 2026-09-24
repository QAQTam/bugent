/**
 * 权限/能力授权弹窗的按钮布局与鼠标命中。
 *
 * 渲染和命中分开：`composeDialogActions()` 产出可写入对话框的 ANSI 文本，
 * 同时记录每个按钮在“整行可见坐标”里的区间；TuiApp 只需要把鼠标坐标
 * 转成列号后调用 `hitDialogAction()`。
 */

import { visibleWidth } from "./ansi.ts";
import {
  buttonWidth,
  buttonRows,
  glyphOf,
  paintButtonLines,
  type ButtonShape,
  type ButtonTone,
} from "./button.ts";

export type DialogActionTone = ButtonTone;

export interface DialogAction<T = boolean> {
  label: string;
  value: T;
  tone?: DialogActionTone;
  /** 显示在按钮里的键盘快捷键，例如“同意（y）”。 */
  shortcut?: string;
}

export interface DialogButtonHit<T = boolean> {
  /** 0-based 可见列，包含左侧边框。 */
  start: number;
  /** 0-based 可见列，包含右侧边框。 */
  end: number;
  /** 相对动作组首行的 0-based 行号（框形态下按钮占 3 行）。 */
  row: number;
  /** 占几行。 */
  rowSpan: number;
  /** 左上角字形，自检锚点用它比对画面。 */
  glyph: string;
  value: T;
}

export interface DialogButtonRowHit<T = boolean> {
  /** 相对弹窗顶部的 0-based 行号。 */
  line: number;
  hit: DialogButtonHit<T>;
}

export interface ComposedDialogActions<T = boolean> {
  /** 动作组占的行（框形态 3 行，紧凑形态 1 行）。 */
  lines: string[];
  hits: DialogButtonHit<T>[];
}

export interface DialogActionRenderState<T = boolean> {
  hovered?: T;
  pressed?: T;
}

export interface DialogActionLayout {
  /** 按钮形态；终端放不下框时退化成紧凑形态。 */
  shape?: ButtonShape;
}

/**
 * 生成一组动作按钮，例如 `┌────┐   ┌────┐` / `│ 同意（y） │   │ 拒绝（n） │` / `└────┘   └────┘`。
 *
 * 每个按钮都走 `paintButtonLines()`（矩形 + 背景 + 悬停/按下态），这里只负责
 * 一组里排几个、间距多少。`start/end` 按包含左边框的整行坐标计算，鼠标命中
 * 逻辑无需改变；`row/rowSpan` 让调用方把弹窗局部行换算成屏幕矩形。
 */
export function composeDialogActions<T = boolean>(
  actions: readonly DialogAction<T>[],
  state: DialogActionRenderState<T> = {},
  layout: DialogActionLayout = {},
): ComposedDialogActions<T> {
  const shape = layout.shape ?? "box";
  const rows = buttonRows(shape);
  const hits: DialogButtonHit<T>[] = [];
  // 第 0 列是对话框左边框；文本从第 1 列开始，按钮从第 2 列开始。
  const lines = Array.from({ length: rows }, () => " ");
  let cursor = 2;

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    if (index > 0) {
      for (let row = 0; row < rows; row += 1) lines[row] += "   ";
      cursor += 3;
    }

    const label = action.shortcut === undefined ? action.label : `${action.label}（${action.shortcut}）`;
    const start = cursor;
    const pressed = state.pressed !== undefined && state.pressed === action.value;
    const hovered = !pressed && state.hovered !== undefined && state.hovered === action.value;
    const painted = paintButtonLines(label, action.tone, { hovered, pressed }, shape);
    for (let row = 0; row < rows; row += 1) lines[row] += painted[row]!;

    hits.push({
      start,
      end: cursor + buttonWidth(label) - 1,
      row: 0,
      rowSpan: rows,
      glyph: glyphOf(shape),
      value: action.value,
    });
    cursor += buttonWidth(label);
  }

  return { lines, hits };
}

/** 判断某一行的可见列是否命中按钮；返回按钮值，未命中返回 undefined。 */
export function hitDialogAction<T = boolean>(
  hits: readonly DialogButtonHit<T>[],
  column: number,
): T | undefined {
  for (const hit of hits) {
    if (column >= hit.start && column <= hit.end) return hit.value;
  }
  return undefined;
}

/** 按行过滤后再命中；同一行可能有多个按钮。 */
export function hitDialogActionAtLine<T = boolean>(
  rows: readonly DialogButtonRowHit<T>[],
  line: number,
  column: number,
): T | undefined {
  const hits = rows.filter((entry) => entry.line === line).map((entry) => entry.hit);
  return hits.length === 0 ? undefined : hitDialogAction(hits, column);
}

/** 弹窗在屏幕上的位置。 */
export interface DialogGeometry {
  /** 弹窗首行的 0-based 屏幕行号。 */
  top: number;
  /** 弹窗总行数。 */
  height: number;
  /** 水平居中后左侧留白的列数。 */
  leftPadding: number;
}

/** 弹窗内容区宽度（不含左右边框）。 */
export function dialogInnerWidth(width: number): number {
  return Math.max(16, Math.min(width - 2, 74));
}

/**
 * 弹窗水平居中后的左内边距。
 *
 * 渲染与鼠标命中共用这一个函数：命中区间是在**弹窗自己的坐标系**里算的，
 * 而鼠标坐标是屏幕坐标系，两者之间只差这个 padding。各算一遍就会偏。
 */
export function dialogLeftPadding(width: number): number {
  return Math.max(0, Math.floor((width - (dialogInnerWidth(width) + 2)) / 2));
}

/**
 * 屏幕坐标（1-based）-> 弹窗内坐标（0-based）。
 *
 * `leftPadding` 不能省：弹窗是水平居中的，按钮的命中区间却是在弹窗自己的
 * 坐标系里算出来的。漏掉这一项，命中区就整体左移 padding 列 —— 终端越宽
 * 偏得越多（80 列偏 2 列，120 列偏 22 列），表现就是"点按钮没反应"或者
 * "点到了隔壁按钮"。
 *
 * 返回 undefined 表示这次点击不在弹窗范围内。
 */
export function dialogPointAt(
  geometry: DialogGeometry,
  x: number,
  y: number,
): { row: number; column: number } | undefined {
  const row = y - 1 - geometry.top;
  if (row < 0 || row >= geometry.height) return undefined;
  const column = x - 1 - geometry.leftPadding;
  if (column < 0) return undefined;
  return { row, column };
}
