import { describe, expect, test } from "bun:test";
import {
  composeDialogActions,
  dialogInnerWidth,
  dialogLeftPadding,
  dialogPointAt,
  hitDialogAction,
  hitDialogActionAtLine,
  type DialogAction,
} from "../src/tui/dialog.ts";
import { visibleWidth } from "../src/tui/ansi.ts";
import { bg } from "../src/tui/markdown.ts";
import { COLOR } from "../src/tui/theme.ts";

describe("授权弹窗按钮", () => {
  const actions: DialogAction[] = [
    { label: "同意", value: true, tone: "ok", shortcut: "y" },
    { label: "拒绝", value: false, tone: "error", shortcut: "n" },
  ];

  test("按钮使用方框底板，并把快捷键合进标签", () => {
    const composed = composeDialogActions(actions);
    const plain = composed.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

    expect(plain).toContain("▐ 同意（y） ▌");
    expect(plain).toContain("▐ 拒绝（n） ▌");
    expect(plain).not.toContain("[ 同意 ]");
    expect(composed.hits).toHaveLength(2);
    expect(composed.hits[0]!.value).toBe(true);
    expect(composed.hits[1]!.value).toBe(false);
    expect(composed.hits[0]!.end).toBeLessThan(composed.hits[1]!.start);
  });

  test("同意 / 拒绝使用不同语义底板", () => {
    const composed = composeDialogActions(actions);
    expect(composed.text).toContain(bg(COLOR.buttonOkBg));
    expect(composed.text).toContain(bg(COLOR.buttonErrorBg));
  });

  test("高危授权使用警告色底板，而不是危险红或安全绿", () => {
    const elevated = composeDialogActions([
      { label: "允许这一次", value: true, tone: "warn", shortcut: "y" },
    ]);
    expect(elevated.text).toContain(bg(COLOR.buttonWarnBg));
    expect(elevated.text).not.toContain(bg(COLOR.buttonErrorBg));
    expect(elevated.text).not.toContain(bg(COLOR.buttonOkBg));
  });

  test("命中边界包含按钮首尾，按钮外不误触", () => {
    const { hits } = composeDialogActions(actions);
    const allow = hits[0]!;
    const deny = hits[1]!;

    expect(hitDialogAction([allow], allow.start)).toBe(true);
    expect(hitDialogAction([allow], allow.end)).toBe(true);
    expect(hitDialogAction([allow], allow.start - 1)).toBeUndefined();
    expect(hitDialogAction([allow], allow.end + 1)).toBeUndefined();
    expect(hitDialogAction([deny], deny.start)).toBe(false);
    expect(hitDialogAction([deny], deny.end)).toBe(false);
  });

  test("按钮文本宽度计算包含左侧边框占位", () => {
    const composed = composeDialogActions(actions);
    expect(composed.hits[0]!.start).toBe(2);
    expect(composed.hits[0]!.end - composed.hits[0]!.start + 1).toBe(
      visibleWidth("▐ 同意（y） ▌"),
    );
  });

  test("回归：同一行有两个按钮时，第二个按钮也能命中", () => {
    const { hits } = composeDialogActions(actions);
    const rows = [
      { line: 4, hit: hits[0]! },
      { line: 4, hit: hits[1]! },
    ];

    expect(hitDialogActionAtLine(rows, 4, hits[0]!.start)).toBe(true);
    expect(hitDialogActionAtLine(rows, 4, hits[1]!.start)).toBe(false);
    expect(hitDialogActionAtLine(rows, 3, hits[1]!.start)).toBeUndefined();
  });

  test("hover / pressed 使用不同背景，pressed 优先于 hover", () => {
    const normal = composeDialogActions(actions).text;
    const hovered = composeDialogActions(actions, { hovered: true }).text;
    const pressed = composeDialogActions(actions, { hovered: true, pressed: true }).text;

    expect(hovered).not.toBe(normal);
    expect(pressed).not.toBe(hovered);
    expect(hovered).toContain(bg(COLOR.buttonHoverBg));
    expect(pressed).toContain(bg(COLOR.buttonPressedBg));
  });
});

describe("弹窗屏幕坐标换算", () => {
  test("扣掉居中留白，行号相对弹窗顶部", () => {
    const geometry = { top: 20, height: 10, leftPadding: 22 };
    // 弹窗占 0-based 第 20..29 行，即 1-based 的 21..30 行
    expect(dialogPointAt(geometry, 23, 21)).toEqual({ row: 0, column: 0 });
    expect(dialogPointAt(geometry, 25, 28)).toEqual({ row: 7, column: 2 });
    expect(dialogPointAt(geometry, 23, 30)).toEqual({ row: 9, column: 0 });
  });

  test("弹窗范围之外返回 undefined", () => {
    const geometry = { top: 20, height: 10, leftPadding: 22 };
    expect(dialogPointAt(geometry, 25, 20)).toBeUndefined(); // 上方
    expect(dialogPointAt(geometry, 25, 31)).toBeUndefined(); // 下方
    expect(dialogPointAt(geometry, 22, 25)).toBeUndefined(); // 左侧留白
  });

  test("居中留白随终端宽度变化", () => {
    // 弹窗宽度固定为 inner + 2 = 76，超出部分对半留白
    expect(dialogLeftPadding(80)).toBe(2);
    expect(dialogLeftPadding(120)).toBe(22);
    expect(dialogLeftPadding(76)).toBe(0);
    expect(dialogLeftPadding(40)).toBe(0); // 窄屏：inner 收缩，没有留白
    expect(dialogInnerWidth(40)).toBe(38);
  });

  /**
   * 回归：按钮画在哪里，就得能点在哪里。
   *
   * 之前命中判定用 `x - 1` 直接当弹窗列，漏了居中留白 —— 80 列终端偏 2 列
   * 还能蒙中，120 列偏 22 列就完全点不到了。
   */
  test("按钮渲染位置换算回去必须落在同一个按钮上", () => {
    const wide: DialogAction<string>[] = [
      { label: "撤回到这里", value: "undo", tone: "warn", shortcut: "u" },
      { label: "从这里分叉", value: "fork", tone: "ok", shortcut: "f" },
      { label: "重试此轮", value: "retry", tone: "neutral", shortcut: "r" },
    ];

    for (const width of [80, 100, 120, 200]) {
      const padding = dialogLeftPadding(width);
      const { hits } = composeDialogActions(wide);
      const geometry = { top: 20, height: 10, leftPadding: padding };
      // 按钮所在行是弹窗内的第 7 行 -> 1-based 屏幕行 = top + 7 + 1
      const screenRow = geometry.top + 8;

      for (const [index, hit] of hits.entries()) {
        // 按钮在屏幕上占据的列：居中留白 + 弹窗列，1-based 再 +1
        const screenStart = padding + hit.start + 1;
        const screenEnd = padding + hit.end + 1;
        const expected = wide[index]!.value;

        for (const x of [screenStart, Math.floor((screenStart + screenEnd) / 2), screenEnd]) {
          const point = dialogPointAt(geometry, x, screenRow);
          expect(point).toEqual({ row: 7, column: x - 1 - padding });
          expect(hitDialogAction(hits, point!.column)).toBe(expected);
        }
      }
    }
  });
});
