import { describe, expect, test } from "bun:test";
import { hitTest } from "../src/tui/hit.ts";
import { composeCenteredButton } from "../src/tui/history-drawer.ts";
import { visibleWidth } from "../src/tui/ansi.ts";

describe("鼠标命中", () => {
  test("只在区间内命中，undefined 永远不命中", () => {
    const region = { row: 4, start: 10, end: 20 };
    expect(hitTest(region, 10, 4)).toBe(true);
    expect(hitTest(region, 20, 4)).toBe(true);
    expect(hitTest(region, 9, 4)).toBe(false);
    expect(hitTest(region, 10, 5)).toBe(false);
    expect(hitTest(undefined, 10, 4)).toBe(false);
  });

  test("居中按钮返回正确的点击区间", () => {
    const button = composeCenteredButton("abc", 20, 7);
    expect(visibleWidth(button.line)).toBe(11);
    expect(button.line.trimEnd()).toBe("        abc");
    expect(button.hit).toEqual({ row: 7, start: 9, end: 11 });
  });

  test("窄屏时按钮被截断，命中区间不越界", () => {
    const button = composeCenteredButton("[ 查看更多消息 ]", 5, 0);
    expect(visibleWidth(button.line)).toBeLessThanOrEqual(5);
    expect(button.hit).toEqual({ row: 0, start: 1, end: 5 });
  });
});
