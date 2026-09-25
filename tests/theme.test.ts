import { afterEach, describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/tui/markdown.ts";
import { applyTheme, COLOR, currentBackground, darkTheme } from "../src/tui/theme.ts";

afterEach(() => applyTheme("dark"));

/** 行内代码的底色；bugent 刻意剥掉，应该始终是 undefined。 */
const inlineCodeBackground = (): string | undefined =>
  /48;5;(\d+)m/.exec(renderMarkdown("按 `Ctrl+J` 换行。", 60).join("\n"))?.[1];

/** 行内代码的字色；Bun 会给深色终端挑 215、浅色终端挑 124。 */
const inlineCodeForeground = (): string | undefined =>
  /38;5;(\d+)m/.exec(renderMarkdown("按 `Ctrl+J` 换行。", 60).join("\n"))?.[1];

describe("主题", () => {
  test("COLOR 就是当前生效的主题", () => {
    applyTheme("dark");
    expect(COLOR).toBe(darkTheme);
    expect(COLOR.diffAdd).toBe(darkTheme.diffAdd);
  });

  test("diff 增删两色是高饱和绿/红，标记列底色取同色相深色", () => {
    // 绿 hsl(113, 64%, 43%)、红 hsl(345, 64%, 43%)；底色是各自的深色版
    expect(darkTheme.diffAdd).toBe("#37b227");
    expect(darkTheme.diffRemove).toBe("#b2274a");
    expect(darkTheme.diffAddBg).toBe("#214a1c");
    expect(darkTheme.diffRemoveBg).toBe("#4a1c28");
  });
});

describe("markdown 行内代码配色", () => {
  test("深色终端：字色 215，且不铺底色", () => {
    applyTheme("dark");
    expect(currentBackground()).toBe("dark");
    expect(inlineCodeForeground()).toBe("215");
    expect(inlineCodeBackground()).toBeUndefined();
  });

  test("浅色终端：字色 124，且不铺底色", () => {
    applyTheme("light");
    expect(currentBackground()).toBe("light");
    expect(inlineCodeForeground()).toBe("124");
    expect(inlineCodeBackground()).toBeUndefined();
  });

  test("显式传 light 时以参数为准", () => {
    applyTheme("dark");
    const line = renderMarkdown("`x`", 60, { light: true }).join("\n");
    expect(/38;5;(\d+)m/.exec(line)?.[1]).toBe("124");
    expect(/48;5;(\d+)m/.test(line)).toBe(false);
  });
});
