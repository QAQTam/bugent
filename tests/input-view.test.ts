import { describe, expect, test } from "bun:test";
import { inputIndexAt, inputViewport, layoutInput } from "../src/tui/input-view.ts";

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

describe("TUI multiline input layout", () => {
  test("显式换行生成独立视觉行", () => {
    const layout = layoutInput("one\ntwo", 7, 20);
    expect(layout.lines).toEqual(["one", "two"]);
    expect(layout.starts).toEqual([0, 4]);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorColumn).toBe(3);
  });

  test("超宽内容自动折行，光标在下一视觉行起点", () => {
    const layout = layoutInput("abcd", 4, 4);
    expect(layout.lines).toEqual(["abcd"]);
    expect(layout.cursorRow).toBe(0);
    expect(layout.cursorColumn).toBe(4);

    const wrapped = layoutInput("abcde", 4, 4);
    expect(wrapped.lines).toEqual(["abcd", "e"]);
    expect(wrapped.cursorRow).toBe(1);
    expect(wrapped.cursorColumn).toBe(0);
  });

  test("CJK 宽字符折行时不会超过可用宽度", () => {
    const layout = layoutInput("中文中文", 2, 5);
    expect(layout.lines).toEqual(["中文", "中文"]);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorColumn).toBe(0);
  });

  test("视觉行列可以映射回字符索引", () => {
    const layout = layoutInput("one\ntwo", 0, 20);
    expect(inputIndexAt(layout, 0, 2)).toBe(2);
    expect(inputIndexAt(layout, 1, 0)).toBe(4);
    expect(inputIndexAt(layout, 1, 3)).toBe(7);
  });
});
