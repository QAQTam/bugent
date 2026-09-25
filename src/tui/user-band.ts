/**
 * 吸顶的本轮用户消息。
 *
 * 长回合里最常问的一句是"我刚才让它干什么来着" —— 而这一轮的用户消息早已
 * 滚出可视区。所以它整个滚出窗口时，正文区顶部常驻一行摘要。
 *
 * 只画这一行：位置、是否该出现、命中登记都由 TuiApp 管；这里保持纯函数，
 * 免得"什么时候吸顶"这种判断只能靠 PTY 里滚一下来验证。
 */

import { truncateAnsi, visibleWidth } from "./ansi.ts";
import { bg, fg, RESET } from "./markdown.ts";
import { COLOR } from "./theme.ts";

/** 前缀标记：`↥` 表示"这条是从上面吸下来的"。 */
export const USER_BAND_MARK = "↥";

/**
 * 该不该吸顶。
 *
 * 条件：本轮用户消息**整块**滚到窗口上方（`contentEnd < windowStart`），且窗口
 * 起点不为 0 —— 起点为 0 时它本来就在屏幕上，再钉一行只是重复。
 *
 * 判断放在这里而不是 TuiApp 里，是为了让"什么时候出现/消失"能被单测钉住；
 * TuiApp 只负责取窗口起点。
 */
export function shouldPinUserMessage(
  contentEnd: number | undefined,
  windowStart: number,
): boolean {
  if (contentEnd === undefined) return false;
  return windowStart > 0 && contentEnd < windowStart;
}

/** 取第一行有内容的文本 —— 用户消息可能是多行的。 */
export function bandText(text: string): string {
  return (text.split("\n").find((line) => line.trim().length > 0) ?? "").trim();
}

/**
 * 画吸顶行：整行铺底色，所以它看起来是一个"区域"而不是一行正文。
 *
 * 宽度不足时截断文本；`width <= 0` 返回空串（调用方据此不登记命中）。
 */
export function composeUserBand(text: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth <= 0) return "";
  const prefix = `${USER_BAND_MARK} › `;
  const room = Math.max(0, safeWidth - visibleWidth(prefix));
  const content = `${prefix}${truncateAnsi(bandText(text), room)}`;
  const padding = " ".repeat(Math.max(0, safeWidth - visibleWidth(content)));
  return `${bg(COLOR.userBandBg)}${fg(COLOR.userBandFg)}${content}${padding}${RESET}`;
}
