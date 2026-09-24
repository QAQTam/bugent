import { describe, expect, test } from "bun:test";
import { visibleWidth } from "../src/tui/ansi.ts";
import { bg } from "../src/tui/markdown.ts";
import { COLOR } from "../src/tui/theme.ts";
import {
  USER_BAND_MARK,
  bandText,
  composeUserBand,
  shouldPinUserMessage,
} from "../src/tui/user-band.ts";

describe("吸顶用户消息行", () => {
  test("整行铺底色，宽度正好等于终端宽度", () => {
    const line = composeUserBand("帮我跑一下测试", 40);
    expect(line).toContain(bg(COLOR.userBandBg));
    expect(visibleWidth(line)).toBe(40);
    const plain = Bun.stripANSI(line);
    expect(plain.startsWith(`${USER_BAND_MARK} › 帮我跑一下测试`)).toBe(true);
    // 右侧补空格，所以整行看起来是一块"区域"而不是一行正文
    expect(plain.endsWith(" ".repeat(6))).toBe(true);
  });

  test("多行输入只取第一行有内容的", () => {
    expect(bandText("\n\n  第一行  \n第二行")).toBe("第一行");
    const line = composeUserBand("\n\n  第一行  \n第二行", 30);
    expect(Bun.stripANSI(line)).toContain("第一行");
    expect(Bun.stripANSI(line)).not.toContain("第二行");
  });

  test("太长时截断，不越界", () => {
    const line = composeUserBand("很长".repeat(50), 20);
    expect(visibleWidth(line)).toBe(20);
    expect(Bun.stripANSI(line)).toContain("…");
  });

  test("宽度为 0 或负数时返回空串", () => {
    expect(composeUserBand("abc", 0)).toBe("");
    expect(composeUserBand("abc", -5)).toBe("");
  });
});

describe("吸顶时机", () => {
  test("整块滚到窗口上方才吸顶", () => {
    expect(shouldPinUserMessage(5, 6)).toBe(true);
    expect(shouldPinUserMessage(5, 20)).toBe(true);
  });

  test("还有一行露在窗口里就不吸顶", () => {
    expect(shouldPinUserMessage(6, 6)).toBe(false);
    expect(shouldPinUserMessage(9, 6)).toBe(false);
  });

  test("窗口起点为 0 时不吸顶 —— 它本来就在屏幕上", () => {
    expect(shouldPinUserMessage(0, 0)).toBe(false);
    expect(shouldPinUserMessage(-1, 0)).toBe(false);
  });

  test("没有对应的块（还没渲染）时不吸顶", () => {
    expect(shouldPinUserMessage(undefined, 10)).toBe(false);
  });
});
