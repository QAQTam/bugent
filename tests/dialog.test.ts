import { describe, expect, test } from "bun:test";
import {
  composeDialogActions,
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
