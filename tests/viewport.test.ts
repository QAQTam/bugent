import { describe, expect, test } from "bun:test";
import { sliceViewport, type ViewportSpan } from "../src/tui/viewport.ts";

/** 造一个 20 行的条目，头部是 `HEADER`。 */
function longItem(start: number, length: number, header: string): { lines: string[]; span: ViewportSpan } {
  const lines = Array.from({ length }, (_, i) => (i === 0 ? header : `  line${i}`));
  return { lines, span: { start, end: start + length - 1, header } };
}

describe("视窗：钉底", () => {
  test("内容不超过高度时全量显示并补空行", () => {
    const result = sliceViewport(["a", "b"], [], 5, 0);
    expect(result.lines).toEqual(["a", "b", "", "", ""]);
    expect(result.start).toBe(0);
  });

  test("内容超长时默认显示最新的若干行", () => {
    const all = Array.from({ length: 100 }, (_, i) => `l${i}`);
    const result = sliceViewport(all, [], 10, 0);
    expect(result.lines).toHaveLength(10);
    expect(result.lines[9]).toBe("l99"); // 最后一行是最新的
    expect(result.start).toBe(90);
  });

  test("scrollOffset 向上回看", () => {
    const all = Array.from({ length: 100 }, (_, i) => `l${i}`);
    const result = sliceViewport(all, [], 10, 20);
    expect(result.lines[9]).toBe("l79"); // 往回 20 行
  });

  test("回看到顶时不会越界", () => {
    const all = Array.from({ length: 100 }, (_, i) => `l${i}`);
    const result = sliceViewport(all, [], 10, 999);
    expect(result.start).toBe(0);
    expect(result.lines[0]).toBe("l0");
  });
});

describe("视窗：长条目吸顶", () => {
  test("窗口起点落在条目内部时，头部被钉在第一行", () => {
    // 前 5 行是别的条目，接着是一个 40 行的长条目
    const prefix = ["user", "blank", "", "", ""];
    const { lines, span } = longItem(prefix.length, 40, "HEADER +20 -20");
    const all = [...prefix, ...lines, "", "结尾"];
    const spans = [span];

    const result = sliceViewport(all, spans, 10, 0);

    expect(result.lines[0]).toBe("HEADER +20 -20");
    // 头部原来不在窗口里，所以第一行是被"覆盖"上去的
    expect(result.start).toBeGreaterThan(span.start);
  });

  test("起点正好落在条目开头时不覆盖（头部本来就在第一行）", () => {
    const { lines, span } = longItem(0, 20, "HEADER");
    const all = [...lines, "", "after"]; // 共 22 行

    // scrollOffset = 12 → end = 10 → start = 0，正好落在条目起点
    const result = sliceViewport(all, [span], 10, 12);

    expect(result.start).toBe(0);
    expect(result.lines[0]).toBe("HEADER");
  });

  test("窗口完全落在条目之后时不吸顶", () => {
    // 条目在很前面，窗口只覆盖它后面的内容
    const { lines, span } = longItem(0, 10, "HEADER");
    const all = [...lines, "", ...Array.from({ length: 30 }, (_, i) => `tail${i}`)];

    const result = sliceViewport(all, [span], 10, 0);

    expect(result.start).toBeGreaterThan(span.end);
    expect(result.lines[0]).not.toBe("HEADER");
  });

  test("吸顶不改变窗口起始下标（鼠标命中仍按真实下标）", () => {
    const prefix = Array.from({ length: 5 }, (_, i) => `p${i}`);
    const { lines, span } = longItem(prefix.length, 40, "HEADER");
    const all = [...prefix, ...lines, "", "tail"];

    const withSticky = sliceViewport(all, [span], 10, 0);
    const withoutSticky = sliceViewport(all, [], 10, 0);

    expect(withSticky.start).toBe(withoutSticky.start);
  });

  test("多个长条目时，命中的是当前覆盖的那个", () => {
    const first = longItem(0, 20, "FIRST");
    const second = longItem(21, 20, "SECOND");
    const all = [...first.lines, "", ...second.lines];

    const result = sliceViewport(all, [first.span, second.span], 10, 0);
    expect(result.lines[0]).toBe("SECOND");
  });

  test("头部为空时不覆盖（避免把内容擦掉）", () => {
    const all = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const spans: ViewportSpan[] = [{ start: 5, end: 25, header: "" }];
    const result = sliceViewport(all, spans, 10, 0);
    expect(result.lines[0]).not.toBe("");
  });
});
