/**
 * ANSI 宽度工具 —— 重点盯 TAB。
 *
 * `Bun.stringWidth("\t") === 0`，终端却把 TAB 渲染成"跳到下一个制表位"（8 列）。
 * 只要测量与渲染不一致，补白/截断/滚动条就会算错：read_file 的行号分隔符是 TAB，
 * 于是右侧滚动条在那一行缺一个格子。
 */

import { describe, expect, test } from "bun:test";
import {
  centerAnsi,
  expandTabs,
  isBlank,
  padAnsi,
  truncateAnsi,
  visibleWidth,
} from "../src/tui/ansi.ts";

/** 终端实际渲染宽度：TAB 前进到下一个 8 的倍数（模拟真实终端）。 */
function terminalWidth(line: string): number {
  let column = 0;
  // 先剥掉 ANSI 序列：终端不把它们算进列数
  for (const char of Bun.stripANSI(line)) {
    if (char === "\t") {
      column += 8 - (column % 8);
      continue;
    }
    column += Bun.stringWidth(char);
  }
  return column;
}

describe("TAB 展开", () => {
  test("按可见列推进到下一个制表位", () => {
    expect(expandTabs("\t")).toBe(" ".repeat(8));
    expect(expandTabs("abc\tx")).toBe(`abc${" ".repeat(5)}x`);
    expect(expandTabs("12345678\tx")).toBe(`12345678${" ".repeat(8)}x`);
  });

  test("CJK 按 2 列参与制表位计算", () => {
    // "中" 占 2 列，TAB 补到第 8 列 → 6 个空格
    expect(expandTabs("中\tx")).toBe(`中${" ".repeat(6)}x`);
  });

  test("ANSI 序列不占列", () => {
    const colored = "\x1b[31mab\x1b[0m\tx";
    expect(expandTabs(colored)).toBe(`\x1b[31mab\x1b[0m${" ".repeat(6)}x`);
  });

  test("不含 TAB 时原样返回", () => {
    const text = "\x1b[2mhello\x1b[0m";
    expect(expandTabs(text)).toBe(text);
  });
});

describe("宽度测量把 TAB 算成制表位", () => {
  test("Bun 原生算 0，visibleWidth 算展开后的列数", () => {
    expect(Bun.stringWidth("\t")).toBe(0);
    expect(visibleWidth("\t")).toBe(8);
    expect(visibleWidth("a\tb")).toBe(9);
  });

  test("测量宽度 == 终端渲染宽度", () => {
    for (const sample of ["\t", "     1\t/**", "abc\tx", "中\tx", "\x1b[31mab\x1b[0m\tx"]) {
      expect(visibleWidth(sample)).toBe(terminalWidth(sample));
    }
  });

  test("只含 TAB 的行算空行", () => {
    expect(isBlank("\t")).toBe(false); // 展开后是 8 个空格，但宽度非 0
    expect(isBlank("")).toBe(true);
  });
});

describe("截断与补白不再留下 TAB", () => {
  test("truncateAnsi 展开后再截断", () => {
    const out = truncateAnsi("     1\t/**", 10);
    expect(out).not.toContain("\t");
    expect(visibleWidth(out)).toBeLessThanOrEqual(10);
    expect(terminalWidth(out)).toBe(visibleWidth(out));
  });

  test("padAnsi 展开后再补白", () => {
    const out = padAnsi("     1\t/**", 20);
    expect(out).not.toContain("\t");
    expect(visibleWidth(out)).toBe(20);
    expect(terminalWidth(out)).toBe(20);
  });

  test("centerAnsi 同理", () => {
    const out = centerAnsi("\tx", 12);
    expect(out).not.toContain("\t");
    expect(terminalWidth(out)).toBe(visibleWidth(out));
  });
});

describe("滚动条缺口的根因回归", () => {
  test("滚动条那一行不会被 TAB 顶出右边界", () => {
    // composeScrollbar 的做法：截断到 width-1、补白、再把滚动条字符贴在最后
    const width = 20;
    const row = "     1\t/**";
    const composed = `${padAnsi(truncateAnsi(row, width - 1), width - 1)}█`;

    expect(visibleWidth(composed)).toBe(width);
    // 修复前这里会 > width：终端把 TAB 渲染成 2 列，最右列的滚动条字符被挤出去
    expect(terminalWidth(composed)).toBe(width);
    expect(composed.endsWith("█")).toBe(true);
  });
});
