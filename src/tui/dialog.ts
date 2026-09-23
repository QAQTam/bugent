/**
 * 权限/能力授权弹窗的按钮布局与鼠标命中。
 *
 * 渲染和命中分开：`composeDialogActions()` 产出可写入对话框的 ANSI 文本，
 * 同时记录每个按钮在“整行可见坐标”里的区间；TuiApp 只需要把鼠标坐标
 * 转成列号后调用 `hitDialogAction()`。
 */

import { visibleWidth } from "./ansi.ts";
import { BOLD, fg, RESET } from "./markdown.ts";
import { COLOR } from "./theme.ts";

export type DialogActionTone = "ok" | "warn" | "error";

export interface DialogAction<T = boolean> {
  label: string;
  value: T;
  tone?: DialogActionTone;
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

function toneColor(tone: DialogActionTone | undefined): string {
  switch (tone) {
    case "ok":
      return COLOR.ok;
    case "error":
      return COLOR.error;
    case "warn":
    default:
      return COLOR.warn;
  }
}

/**
 * 生成一行按钮，例如 ` [ 允许 ]   [ 拒绝 ] `。
 *
 * 行文本本身不包含对话框左右边框；`start/end` 按包含左边框的整行坐标计算。
 * 这样 TuiApp 可以直接用 `key.x - 1` 做命中，不需要重复知道边框宽度。
 */
export function composeDialogActions<T = boolean>(
  actions: readonly DialogAction<T>[],
): ComposedDialogActions<T> {
  const hits: DialogButtonHit<T>[] = [];
  let text = " ";
  // 第 0 列是对话框左边框；文本从第 1 列开始。
  let cursor = 2;

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    if (index > 0) {
      text += "   ";
      cursor += 3;
    }

    const label = `[ ${action.label} ]`;
    const start = cursor;
    text += `${BOLD}${fg(toneColor(action.tone))}${label}${RESET}`;
    cursor += visibleWidth(label);

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
