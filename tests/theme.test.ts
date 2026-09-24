import { afterEach, describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/tui/markdown.ts";
import { applyTheme, COLOR, currentBackground, darkTheme } from "../src/tui/theme.ts";

afterEach(() => applyTheme("dark"));

/** 行内代码的底色；Bun 会给深色终端挑 236、浅色终端挑 254。 */
const inlineCodeBackground = (): string | undefined =>
  /48;5;(\d+)m/.exec(renderMarkdown("按 `Ctrl+J` 换行。", 60).join("\n"))?.[1];

describe("主题", () => {
  test("COLOR 就是当前生效的主题", () => {
    applyTheme("dark");
    expect(COLOR).toBe(darkTheme);
    expect(COLOR.diffAdd).toBe(darkTheme.diffAdd);
  });

  test("diff 两色压过饱和度", () => {
    // 旧值是 #4ade80（饱和 69%）/ #f87171（饱和 91%），一屏 diff 看着很累
    expect(darkTheme.diffAdd).toBe("#a3be8c");
    expect(darkTheme.diffRemove).toBe("#d08770");
  });
});

describe("底色决定 markdown 行内代码配色", () => {
  test("深色终端用 236", () => {
    applyTheme("dark");
    expect(currentBackground()).toBe("dark");
    expect(inlineCodeBackground()).toBe("236");
  });

  test("浅色终端用 254", () => {
    applyTheme("light");
    expect(currentBackground()).toBe("light");
    expect(inlineCodeBackground()).toBe("254");
  });

  test("显式传 light 时以参数为准", () => {
    applyTheme("dark");
    const line = renderMarkdown("`x`", 60, { light: true }).join("\n");
    expect(/48;5;(\d+)m/.exec(line)?.[1]).toBe("254");
  });
});
