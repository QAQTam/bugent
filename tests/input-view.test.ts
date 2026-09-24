import { describe, expect, test } from "bun:test";
import { inputViewport } from "../src/tui/input-view.ts";

describe("TUI input viewport", () => {
  test("光标列包含左侧边框和提示符", () => {
    expect(inputViewport("abc", 0, 20)).toMatchObject({
      start: 0,
      cursorColumn: 3,
    });
    expect(inputViewport("abc", 2, 20)).toMatchObject({
      start: 0,
      cursorColumn: 5,
    });
    expect(inputViewport("abc", 3, 20)).toMatchObject({
      start: 0,
      cursorColumn: 6,
    });
  });

  test("CJK 与 emoji 按终端显示宽度计算", () => {
    expect(inputViewport("中文", 1, 20).cursorColumn).toBe(5);
    expect(inputViewport("中文", 2, 20).cursorColumn).toBe(7);
    expect(inputViewport("🙂x", 1, 20).cursorColumn).toBe(5);
  });

  test("水平滚动后光标仍在可用区域内", () => {
    const view = inputViewport("abcdefghij", 10, 4);
    expect(view.start).toBe(7);
    expect(view.cursorColumn).toBe(6);
    expect(view.cursorWidth).toBe(1);
  });

  test("光标停在宽字符上时把整个字符留在视口内", () => {
    const view = inputViewport("ab中", 2, 4);
    expect(view.start).toBe(0);
    expect(view.cursorColumn).toBe(5);
    expect(view.cursorWidth).toBe(2);
  });
});
