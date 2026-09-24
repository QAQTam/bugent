import { describe, expect, test } from "bun:test";
import { visibleWidth } from "../src/tui/ansi.ts";
import { layoutInput } from "../src/tui/input-view.ts";
import {
  composeInputBox,
  inputBoxGeometry,
  inputBoxRows,
  inputCursorFromClick,
  INPUT_MAX_CONTENT_ROWS,
  type InputBoxRect,
} from "../src/tui/input-box.ts";

const plain = (text: string): string => Bun.stripANSI(text);

/** 80 列下的框：宽 79，文本区 75 列，文本从第 3 列开始。 */
const rect80 = (overrides: Partial<InputBoxRect> = {}): InputBoxRect => ({
  top: 22,
  height: 3,
  contentTop: 23,
  contentRows: 1,
  startRow: 0,
  textLeft: 3,
  boxWidth: 79,
  ...overrides,
});

describe("输入框几何", () => {
  test("宽度比终端少 1 格，文本区扣掉边框与内边距", () => {
    expect(inputBoxGeometry(80)).toEqual({ boxWidth: 79, textWidth: 75, textLeft: 3 });
    expect(inputBoxGeometry(40)).toEqual({ boxWidth: 39, textWidth: 35, textLeft: 3 });
  });

  test("窄终端下文本区至少 1 列，不会算出 0 或负数", () => {
    expect(inputBoxGeometry(4).textWidth).toBe(1);
    expect(inputBoxGeometry(1).textWidth).toBe(1);
    expect(inputBoxGeometry(1).boxWidth).toBeGreaterThanOrEqual(3);
  });
});

describe("输入框高度", () => {
  const base = { height: 24, todoRows: 0, thinkingRows: 3 };

  test("空输入是 1 行内容，整个框 3 行", () => {
    const rows = inputBoxRows({ ...base, inputLines: 1 });
    expect(rows.contentRows).toBe(1);
    expect(rows.boxHeight).toBe(3);
  });

  test("按输入行数增长，封顶在 INPUT_MAX_CONTENT_ROWS", () => {
    expect(inputBoxRows({ ...base, inputLines: 2 }).contentRows).toBe(2);
    expect(inputBoxRows({ ...base, inputLines: 4 }).contentRows).toBe(4);
    expect(inputBoxRows({ ...base, inputLines: 99 }).contentRows).toBe(INPUT_MAX_CONTENT_ROWS);
  });

  test("终端变矮时收缩，保证状态栏与至少 1 行正文", () => {
    // height - 4 - todo - thinking 就是内容区预算
    expect(inputBoxRows({ height: 8, todoRows: 0, thinkingRows: 3, inputLines: 9 }).contentRows).toBe(1);
    expect(inputBoxRows({ height: 12, todoRows: 0, thinkingRows: 3, inputLines: 9 }).contentRows).toBe(5);
    expect(inputBoxRows({ height: 6, todoRows: 0, thinkingRows: 2, inputLines: 9 }).contentRows).toBe(1);
  });

  test("待办面板挤占高度时内容区跟着缩", () => {
    expect(inputBoxRows({ height: 24, todoRows: 8, thinkingRows: 3, inputLines: 9 }).contentRows).toBe(5);
    expect(inputBoxRows({ height: 20, todoRows: 10, thinkingRows: 3, inputLines: 9 }).contentRows).toBe(3);
  });

  test("内容区永远是 1..max 的正整数", () => {
    for (const height of [1, 4, 6, 10, 24, 60]) {
      const rows = inputBoxRows({ height, todoRows: 0, thinkingRows: 3, inputLines: 9 });
      expect(rows.contentRows).toBeGreaterThanOrEqual(1);
      expect(rows.contentRows).toBeLessThanOrEqual(INPUT_MAX_CONTENT_ROWS);
      expect(rows.boxHeight).toBe(rows.contentRows + 2);
    }
  });
});

describe("点击映射到光标", () => {
  const layout = layoutInput("abc", 3, 75);

  test("框外返回 undefined —— 调用方据此什么都不做", () => {
    const rect = rect80();
    expect(inputCursorFromClick(undefined, layout, 10, 23)).toBeUndefined();
    expect(inputCursorFromClick(rect, layout, 10, 21)).toBeUndefined(); // 框上方
    expect(inputCursorFromClick(rect, layout, 10, 25)).toBeUndefined(); // 框下方
    expect(inputCursorFromClick(rect, layout, 0, 23)).toBeUndefined(); // 左边框之外
    expect(inputCursorFromClick(rect, layout, 80, 23)).toBeUndefined(); // 右边框之外
  });

  test("点文本区按列换算字符索引", () => {
    const rect = rect80();
    expect(inputCursorFromClick(rect, layout, 3, 23)).toBe(0); // 首列
    expect(inputCursorFromClick(rect, layout, 5, 23)).toBe(2);
    expect(inputCursorFromClick(rect, layout, 6, 23)).toBe(3); // 行尾之后
    expect(inputCursorFromClick(rect, layout, 40, 23)).toBe(3); // 行尾很远也夹到行尾
  });

  test("点在边框上按最近的内容行处理，边框不是死区", () => {
    const rect = rect80();
    expect(inputCursorFromClick(rect, layout, 1, 23)).toBe(0); // 左边框
    expect(inputCursorFromClick(rect, layout, 79, 23)).toBe(3); // 右边框
    expect(inputCursorFromClick(rect, layout, 1, 22)).toBe(0); // 上边框
    expect(inputCursorFromClick(rect, layout, 6, 24)).toBe(3); // 下边框
  });

  test("CJK 宽字符不会被劈开：点在字符右半格仍落在该字符之前", () => {
    const cjk = layoutInput("中文", 2, 75);
    const rect = rect80();
    expect(inputCursorFromClick(rect, cjk, 3, 23)).toBe(0); // 中 的左半格
    expect(inputCursorFromClick(rect, cjk, 4, 23)).toBe(0); // 中 的右半格
    expect(inputCursorFromClick(rect, cjk, 5, 23)).toBe(1); // 文 的左半格
    expect(inputCursorFromClick(rect, cjk, 7, 23)).toBe(2); // 文 之后
  });

  test("多行输入按行换算", () => {
    const multi = layoutInput("one\ntwo", 7, 75);
    const rect = rect80({ height: 4, contentRows: 2 });
    expect(inputCursorFromClick(rect, multi, 3, 23)).toBe(0); // 第 1 行行首
    expect(inputCursorFromClick(rect, multi, 3, 24)).toBe(4); // 第 2 行行首
    expect(inputCursorFromClick(rect, multi, 6, 24)).toBe(7); // 第 2 行行尾
  });

  test("内容滚动后点击落在当前可见行上，而不是第一行", () => {
    const scrolled = layoutInput("a\nb\nc", 5, 75);
    // 只显示 1 行内容，且已经滚到第 3 行（startRow=2）
    const rect = rect80({ startRow: 2 });
    expect(inputCursorFromClick(rect, scrolled, 3, 23)).toBe(4); // 'c' 之前
    expect(inputCursorFromClick(rect, scrolled, 4, 23)).toBe(5); // 'c' 之后
  });
});

describe("输入框渲染", () => {
  const compose = (input: string, cursor: number, contentRows = 1, placeholder?: string) =>
    composeInputBox({
      width: 80,
      top: 22,
      input,
      layout: layoutInput(input, cursor, inputBoxGeometry(80).textWidth),
      contentRows,
      ...(placeholder !== undefined ? { placeholder } : {}),
    });

  test("框高 = 内容行数 + 2，每行宽度都等于框宽", () => {
    for (const contentRows of [1, 3, 5]) {
      const frame = compose("hi", 2, contentRows);
      expect(frame.lines).toHaveLength(contentRows + 2);
      for (const line of frame.lines) {
        expect(visibleWidth(line)).toBe(79);
      }
    }
  });

  test("上下边框用制表符，内容行两侧是竖线", () => {
    const frame = compose("hi", 2);
    const lines = frame.lines.map(plain);
    expect(lines[0]?.startsWith("┌")).toBe(true);
    expect(lines[0]?.endsWith("┐")).toBe(true);
    expect(lines[1]?.startsWith("│")).toBe(true);
    expect(lines[1]?.endsWith("│")).toBe(true);
    expect(lines[2]?.startsWith("└")).toBe(true);
    expect(lines[2]?.endsWith("┘")).toBe(true);
    expect(lines[1]).toContain(" hi ");
  });

  test("空输入显示占位提示，有内容就消失", () => {
    const empty = compose("", 0, 1, "输入消息，/ 查看命令").lines.map(plain);
    expect(empty[1]).toContain("输入消息，/ 查看命令");

    const typed = compose("h", 1, 1, "输入消息，/ 查看命令").lines.map(plain);
    expect(typed[1]).not.toContain("输入消息");
    expect(typed[1]).toContain("h");
  });

  test("占位提示超宽时被截断，不撑破边框", () => {
    const frame = composeInputBox({
      width: 12,
      top: 22,
      input: "",
      layout: layoutInput("", 0, inputBoxGeometry(12).textWidth),
      contentRows: 1,
      placeholder: "输入消息，/ 查看命令",
    });
    for (const line of frame.lines) expect(visibleWidth(line)).toBe(11);
  });

  test("硬件光标列 = 文本区首列 + 文本内列偏移", () => {
    expect(compose("", 0).cursor).toEqual({ row: 1, column: 3 });
    expect(compose("abc", 3).cursor).toEqual({ row: 1, column: 6 });
    expect(compose("中文", 2).cursor).toEqual({ row: 1, column: 7 });
  });

  test("光标行跟着内容滚动，最后一行的光标留在框内", () => {
    const frame = compose("a\nb\nc", 5, 1);
    // 只显示 1 行内容，光标在第 3 行 → 视窗滚到第 3 行
    expect(frame.rect.startRow).toBe(2);
    expect(frame.cursor.row).toBe(1); // 框内：0 是上边框，1 是唯一内容行
    expect(plain(frame.lines[1]!)).toContain("c");
  });

  test("登记的位置信息与渲染一致：rect 指向的内容行就是画出来的那一行", () => {
    const frame = compose("one\ntwo", 7, 2);
    expect(frame.rect.top).toBe(22);
    expect(frame.rect.contentTop).toBe(23);
    expect(frame.rect.contentRows).toBe(2);
    expect(frame.rect.height).toBe(4);
    expect(plain(frame.lines[1]!)).toContain("one");
    expect(plain(frame.lines[2]!)).toContain("two");
    expect(frame.cursor.row).toBe(2); // 内容第 2 行
  });
});
