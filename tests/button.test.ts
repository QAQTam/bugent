import { describe, expect, test } from "bun:test";
import { visibleWidth } from "../src/tui/ansi.ts";
import {
  BUTTON_LEFT,
  BUTTON_TOP_LEFT,
  buttonShape,
  buttonShapeFor,
  buttonWidth,
  composeButton,
  paintButtonLines,
} from "../src/tui/button.ts";
import { perceivedLuminance } from "../src/tui/background.ts";
import { bg } from "../src/tui/markdown.ts";
import { COLOR } from "../src/tui/theme.ts";

/** 取按钮行里某一列的字形（1-based），用来核对命中区真的落在画出来的边框上。 */
const cellAt = (line: string, column: number): string =>
  Bun.stripANSI(Bun.sliceAnsi(line, column - 1, column));

const plain = (line: string): string => Bun.stripANSI(line);

describe("矩形按钮", () => {
  test("框形态是描边 + 背景填充，两种形态同宽", () => {
    expect(buttonShape("abc", "box")).toEqual(["┌─────┐", "│ abc │", "└─────┘"]);
    expect(buttonShape("abc", "compact")).toEqual([`${BUTTON_LEFT} abc ▌`]);
    // 形态只改高度，不改宽度：换形态不会让按钮左右跳
    expect(buttonWidth("同意（y）")).toBe(visibleWidth("│ 同意（y） │"));
    expect(visibleWidth(buttonShape("同意（y）", "compact")[0]!)).toBe(buttonWidth("同意（y）"));
  });

  test("居中摆放，命中区正好覆盖整个框", () => {
    const button = composeButton({ label: "abc", width: 20, row: 7 });
    // 框宽 7，居中后左边留白 (20 - 7) / 2 = 6
    expect(button.hit).toEqual({ top: 7, bottom: 9, left: 7, right: 13 });
    expect(button.lines).toHaveLength(3);
    expect(plain(button.lines[0]!)).toBe(`${" ".repeat(6)}┌─────┐`);
    expect(plain(button.lines[1]!)).toBe(`${" ".repeat(6)}│ abc │`);
    expect(plain(button.lines[2]!)).toBe(`${" ".repeat(6)}└─────┘`);
    expect(button.glyph).toBe(BUTTON_TOP_LEFT);
    expect(cellAt(button.lines[0]!, 7)).toBe("┌");
    expect(cellAt(button.lines[0]!, 13)).toBe("┐");
  });

  test("紧凑形态只有一行，命中区也跟着是一行", () => {
    const button = composeButton({ label: "abc", width: 20, row: 7, shape: "compact" });
    expect(button.lines).toHaveLength(1);
    expect(button.hit).toEqual({ top: 7, bottom: 7, left: 7, right: 13 });
    expect(button.glyph).toBe(BUTTON_LEFT);
    expect(cellAt(button.lines[0]!, 7)).toBe(BUTTON_LEFT);
  });

  test("hint 只出现在标签那一行，但整组一起居中", () => {
    const hint = "↑ 更早消息已折叠 ";
    const button = composeButton({ label: "查看更多消息", hint, width: 40, row: 2 });
    const hintWidth = visibleWidth(hint);
    expect(button.hit?.left).toBeGreaterThan(hintWidth);
    expect(plain(button.lines[1]!)).toContain(hint);
    // 上下两行用等宽空白占位，边框才对得齐
    expect(plain(button.lines[0]!).startsWith(" ".repeat(hintWidth))).toBe(true);
    expect(plain(button.lines[2]!).startsWith(" ".repeat(hintWidth))).toBe(true);
    expect(cellAt(button.lines[0]!, button.hit!.left)).toBe(BUTTON_TOP_LEFT);
    // hint 最后一列与按钮左框之间必须是空白，否则说明命中和画面错位
    expect(cellAt(button.lines[1]!, button.hit!.left - 1)).toBe(" ");
  });

  test("三种状态各用各的底色，三行都铺满", () => {
    const idle = paintButtonLines("abc", "neutral");
    expect(idle.every((line) => line.includes(bg(COLOR.buttonNeutralBg)))).toBe(true);
    const hovered = paintButtonLines("abc", "neutral", { hovered: true });
    expect(hovered.every((line) => line.includes(bg(COLOR.buttonHoverBg)))).toBe(true);
    const pressed = paintButtonLines("abc", "neutral", { hovered: true, pressed: true });
    expect(pressed.every((line) => line.includes(bg(COLOR.buttonPressedBg)))).toBe(true);
    expect(paintButtonLines("abc", "ok")[0]).toContain(bg(COLOR.buttonOkBg));
    expect(paintButtonLines("abc", "warn")[0]).toContain(bg(COLOR.buttonWarnBg));
    expect(paintButtonLines("abc", "error")[0]).toContain(bg(COLOR.buttonErrorBg));
  });

  test("悬停底色比任何一种按钮底色都亮 —— 否则读不出“选中”", () => {
    const hover = perceivedLuminance(COLOR.buttonHoverBg);
    const pressed = perceivedLuminance(COLOR.buttonPressedBg);
    for (const base of [
      COLOR.buttonNeutralBg,
      COLOR.buttonOkBg,
      COLOR.buttonWarnBg,
      COLOR.buttonErrorBg,
    ]) {
      expect(hover).toBeGreaterThan(perceivedLuminance(base));
      expect(pressed).toBeGreaterThan(perceivedLuminance(base));
    }
  });

  test("窄屏时截断标签，命中区不越界", () => {
    const button = composeButton({ label: "查看更多消息", width: 5, row: 0 });
    expect(button.lines.every((line) => visibleWidth(line) <= 5)).toBe(true);
    expect(button.hit).toEqual({ top: 0, bottom: 2, left: 1, right: 5 });
    expect(cellAt(button.lines[0]!, 1)).toBe(BUTTON_TOP_LEFT);
    expect(cellAt(button.lines[0]!, 5)).toBe("┐");
  });

  test("连边框都放不下时不登记命中", () => {
    const button = composeButton({ label: "查看更多消息", width: 3, row: 0 });
    expect(button.hit).toBeUndefined();
    expect(button.lines).toEqual([]);
  });

  test("按可用行数挑形态：放不下框就退化，一行都没有就不画", () => {
    expect(buttonShapeFor(5)).toBe("box");
    expect(buttonShapeFor(3)).toBe("box");
    expect(buttonShapeFor(2)).toBe("compact");
    expect(buttonShapeFor(1)).toBe("compact");
    expect(buttonShapeFor(0)).toBeUndefined();
  });
});
