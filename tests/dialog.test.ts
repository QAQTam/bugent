import { describe, expect, test } from "bun:test";
import {
  composeDialogActions,
  hitDialogAction,
  hitDialogActionAtLine,
  type DialogAction,
} from "../src/tui/dialog.ts";
import { visibleWidth } from "../src/tui/ansi.ts";

describe("授权弹窗按钮", () => {
  const actions: DialogAction[] = [
    { label: "允许", value: true, tone: "ok" },
    { label: "拒绝", value: false, tone: "error" },
  ];

  test("按钮布局保留标签，并给两个按钮分别建立命中区间", () => {
    const composed = composeDialogActions(actions);
    const plain = composed.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

    expect(plain).toContain("[ 允许 ]");
    expect(plain).toContain("[ 拒绝 ]");
    expect(composed.hits).toHaveLength(2);
    expect(composed.hits[0]!.value).toBe(true);
    expect(composed.hits[1]!.value).toBe(false);
    expect(composed.hits[0]!.end).toBeLessThan(composed.hits[1]!.start);
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
      visibleWidth("[ 允许 ]"),
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
    expect(hovered).toContain("\x1b[48;");
    expect(pressed).toContain("\x1b[48;");
  });
});
