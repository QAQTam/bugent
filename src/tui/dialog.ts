/**
 * 权限/能力授权弹窗的按钮布局与鼠标命中。
 *
 * 渲染和命中分开：`composeDialogActions()` 产出可写入对话框的 ANSI 文本，
 * 同时记录每个按钮在“整行可见坐标”里的区间；TuiApp 只需要把鼠标坐标
 * 转成列号后调用 `hitDialogAction()`。
 */

import { visibleWidth } from "./ansi.ts";
import { BOLD, bg, fg, RESET } from "./markdown.ts";
import { COLOR } from "./theme.ts";

export type DialogActionTone = "ok" | "warn" | "error" | "neutral";

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
  value: T;
}

export interface DialogButtonRowHit<T = boolean> {
  /** 相对弹窗顶部的 0-based 行号。 */
  line: number;
  hit: DialogButtonHit<T>;
}

export interface ComposedDialogActions<T = boolean> {
  text: string;
  hits: DialogButtonHit<T>[];
}

export interface DialogActionRenderState<T = boolean> {
  hovered?: T;
  pressed?: T;
}

function tonePalette(tone: DialogActionTone | undefined): { background: string; foreground: string } {
  switch (tone) {
    case "ok":
      return { background: COLOR.buttonOkBg, foreground: COLOR.buttonOkFg };
    case "warn":
      return { background: COLOR.buttonWarnBg, foreground: COLOR.buttonWarnFg };
    case "error":
      return { background: COLOR.buttonErrorBg, foreground: COLOR.buttonErrorFg };
    case "neutral":
    default:
      return { background: COLOR.buttonNeutralBg, foreground: COLOR.buttonNeutralFg };
  }
}

/**
 * 生成一行按钮，例如 `▐ 同意（y） ▌   ▐ 拒绝（n） ▌`。
 *
 * 按钮使用填充背景 + 半块字符形成“方框”，不再只是 `[ ]`。
 * `start/end` 仍按包含左边框的整行坐标计算，鼠标命中逻辑无需改变。
 */
export function composeDialogActions<T = boolean>(
  actions: readonly DialogAction<T>[],
  state: DialogActionRenderState<T> = {},
): ComposedDialogActions<T> {
  const hits: DialogButtonHit<T>[] = [];
  let text = " ";
  // 第 0 列是对话框左边框；文本从第 1 列开始，按钮从第 2 列开始。
  let cursor = 2;

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    if (index > 0) {
      text += "   ";
      cursor += 3;
    }

    const label = action.shortcut === undefined ? action.label : `${action.label}（${action.shortcut}）`;
    const boxed = `▐ ${label} ▌`;
    const start = cursor;
    const pressed = state.pressed !== undefined && state.pressed === action.value;
    const hovered = !pressed && state.hovered !== undefined && state.hovered === action.value;
    const palette = tonePalette(action.tone);
    const background = pressed
      ? bg(COLOR.buttonPressedBg)
      : hovered
        ? bg(COLOR.buttonHoverBg)
        : bg(palette.background);
    const foreground = pressed
      ? fg(COLOR.buttonPressedFg)
      : hovered
        ? fg(COLOR.buttonHoverFg)
        : fg(palette.foreground);
    text += `${BOLD}${background}${foreground}${boxed}${RESET}`;
    cursor += visibleWidth(boxed);

    hits.push({
      start,
      end: cursor - 1,
      value: action.value,
    });
  }

  return { text, hits };
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
