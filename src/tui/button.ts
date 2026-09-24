/**
 * 可点按钮的唯一实现。
 *
 * 外观是一个描边矩形：整块填背景色，边框和文字同色，所以"悬停变亮"只需要换
 * 背景色，不必改字形。正文区的「查看更多消息」、思考区的「回到最新消息」、
 * 弹窗动作都走这里 —— 以前每个调用点各画一套，`[ xxx ]` 这种纯文字样式没有
 * 背景，鼠标悬上去也没有任何反馈。
 *
 * 两种形态，宽度一样（都是标签 + 4 列），差别只在高度：
 *
 *   box      3 行，`┌──┐ / │ 标签 │ / └──┘`，默认形态
 *   compact  1 行，`▐ 标签 ▌`，终端太矮时退化用，保证按钮还在
 *
 * 悬停/按下的配色取"比任何 tone 底色都亮"的一档，这样同一个高亮色套在
 * 中性/成功/警告/错误四种按钮上都读得出"被选中"，不需要每个 tone 再配一套。
 */

import { truncateAnsi, visibleWidth } from "./ansi.ts";
import type { HitRect } from "./hit.ts";
import { BOLD, bg, fg, RESET } from "./markdown.ts";
import { COLOR } from "./theme.ts";

export type ButtonTone = "neutral" | "ok" | "warn" | "error";
export type ButtonShape = "box" | "compact";

/** 紧凑形态的左右边框；半块字符，配合背景填充也是一个矩形。 */
export const BUTTON_LEFT = "▐";
export const BUTTON_RIGHT = "▌";
/** 框形态的边框。左上角那个字形同时是自检锚点要比对的字符。 */
export const BUTTON_TOP_LEFT = "┌";
export const BUTTON_TOP_RIGHT = "┐";
export const BUTTON_BOTTOM_LEFT = "└";
export const BUTTON_BOTTOM_RIGHT = "┘";
export const BUTTON_HORIZONTAL = "─";
export const BUTTON_VERTICAL = "│";

export const BUTTON_BOX_ROWS = 3;

export function buttonRows(shape: ButtonShape): number {
  return shape === "box" ? BUTTON_BOX_ROWS : 1;
}

/**
 * 只有 `room` 行可用时该用哪种形态；一行都放不下返回 undefined。
 *
 * 调用方据此退化：框放不下就换紧凑形态，而不是把按钮截掉一半。
 */
export function buttonShapeFor(room: number): ButtonShape | undefined {
  if (room >= BUTTON_BOX_ROWS) return "box";
  return room >= 1 ? "compact" : undefined;
}

/** 按钮占几列：两种形态都是标签宽度 + 左右各 1 列边框 + 左右各 1 列内边距。 */
export function buttonWidth(label: string): number {
  return visibleWidth(label) + 4;
}

export interface ButtonState {
  hovered?: boolean;
  pressed?: boolean;
}

export interface ButtonPalette {
  background: string;
  foreground: string;
}

export function tonePalette(tone: ButtonTone | undefined): ButtonPalette {
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

/** 按下 > 悬停 > 本色。 */
export function buttonPalette(
  tone: ButtonTone | undefined,
  state: ButtonState = {},
): ButtonPalette {
  if (state.pressed === true) {
    return { background: COLOR.buttonPressedBg, foreground: COLOR.buttonPressedFg };
  }
  if (state.hovered === true) {
    return { background: COLOR.buttonHoverBg, foreground: COLOR.buttonHoverFg };
  }
  return tonePalette(tone);
}

/** 按钮的纯文本形状（不含颜色）；命中宽度按它算。 */
export function buttonShape(label: string, shape: ButtonShape = "box"): string[] {
  if (shape === "compact") return [`${BUTTON_LEFT} ${label} ${BUTTON_RIGHT}`];
  const rule = BUTTON_HORIZONTAL.repeat(buttonWidth(label) - 2);
  return [
    `${BUTTON_TOP_LEFT}${rule}${BUTTON_TOP_RIGHT}`,
    `${BUTTON_VERTICAL} ${label} ${BUTTON_VERTICAL}`,
    `${BUTTON_BOTTOM_LEFT}${rule}${BUTTON_BOTTOM_RIGHT}`,
  ];
}

/** 画一个按钮（含 ANSI 颜色），返回 1 行或 3 行。 */
export function paintButtonLines(
  label: string,
  tone: ButtonTone | undefined = "neutral",
  state: ButtonState = {},
  shape: ButtonShape = "box",
): string[] {
  const palette = buttonPalette(tone, state);
  const paint = `${BOLD}${bg(palette.background)}${fg(palette.foreground)}`;
  return buttonShape(label, shape).map((line) => `${paint}${line}${RESET}`);
}

export interface ComposedButton {
  /** 按钮占的屏幕行（框形态 3 行，紧凑形态 1 行）；放不下时为空数组。 */
  lines: string[];
  /** 可点矩形（1-based 屏幕坐标）；宽度不够画不出按钮时为 undefined。 */
  hit: HitRect | undefined;
  /** 左上角字形，自检锚点用它比对画面。 */
  glyph: string;
}

export interface ComposeButtonInput {
  label: string;
  /** 可用总宽。 */
  width: number;
  /** 按钮首行的屏幕行号（1-based）。 */
  row: number;
  tone?: ButtonTone;
  state?: ButtonState;
  shape?: ButtonShape;
  /** 按钮左侧的暗色说明文字；放在标签那一行的左边，不算可点区。 */
  hint?: string;
}

/**
 * 生成居中按钮。
 *
 * 放不下时按「丢 hint -> 截断标签 -> 放弃按钮」的顺序退化，绝不画出一个
 * 宽度超出屏幕、命中区却更宽的按钮 —— 那样锚点自检会直接报错。
 */
export function composeButton(input: ComposeButtonInput): ComposedButton {
  const width = Math.max(0, Math.floor(input.width));
  const shape = input.shape ?? "box";
  const rows = buttonRows(shape);
  const empty = { lines: [] as string[], hit: undefined, glyph: glyphOf(shape) };
  let label = input.label;
  let hint = input.hint ?? "";

  if (visibleWidth(hint) + buttonWidth(label) > width) hint = "";
  if (buttonWidth(label) > width) {
    const maxLabel = width - 4;
    if (maxLabel < 1) return empty;
    label = truncateAnsi(label, maxLabel);
  }

  const hintWidth = visibleWidth(hint);
  const boxWidth = buttonWidth(label);
  const left = Math.max(0, Math.floor((width - hintWidth - boxWidth) / 2));
  // hint 只出现在标签那一行，其余行用等宽空白占位，边框才能对齐
  const labelRow = Math.min(1, rows - 1);
  const painted = paintButtonLines(label, input.tone, input.state, shape);
  const lines = painted.map((line, index) => {
    const prefix = index === labelRow ? hint : " ".repeat(hintWidth);
    return truncateAnsi(`${" ".repeat(left)}${prefix}${line}`, width);
  });

  return {
    lines,
    hit: {
      top: input.row,
      bottom: input.row + rows - 1,
      left: left + hintWidth + 1,
      right: left + hintWidth + boxWidth,
    },
    glyph: glyphOf(shape),
  };
}

/** 左上角字形。 */
export function glyphOf(shape: ButtonShape): string {
  return shape === "box" ? BUTTON_TOP_LEFT : BUTTON_LEFT;
}
