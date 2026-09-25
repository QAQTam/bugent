import { describe, expect, test } from "bun:test";
import { visibleWidth } from "../src/tui/ansi.ts";
import {
  composeScrollbar,
  createScrollbarMetrics,
  hitScrollbar,
  scrollbarThumbAt,
  scrollOffsetFromDrag,
} from "../src/tui/scrollbar.ts";

function metrics(scrollOffset: number) {
  return createScrollbarMetrics({
    trackTop: 2,
    trackHeight: 10,
    trackColumn: 40,
    totalLines: 100,
    viewportHeight: 10,
    scrollOffset,
  })!;
}

describe("TUI scrollbar", () => {
  test("底部是 followTail，顶部是最大回看偏移", () => {
    // totalLines=100 / viewport=10 → 回看上限 90（下限 100 行），
    // contentSpan = 10 + 90 = 100，thumb 只占 1 格
    const bottom = metrics(0);
    expect(bottom.maxOffset).toBe(90);
    expect(bottom.thumbTop).toBe(11);
    expect(bottom.thumbHeight).toBe(1);

    const top = metrics(bottom.maxOffset);
    expect(top.thumbTop).toBe(2);
    expect(scrollbarThumbAt(top, 2)).toBe(true);
    expect(scrollbarThumbAt(top, 5)).toBe(false);
  });

  test("拖动 thumb 精确映射 scrollOffset", () => {
    const base = metrics(0);
    const grab = 1;
    const bottomY = base.thumbTop + grab;
    expect(scrollOffsetFromDrag(base, bottomY, grab)).toBe(0);
    expect(scrollOffsetFromDrag(base, base.trackTop, grab)).toBe(base.maxOffset);
    expect(scrollOffsetFromDrag(base, 5, grab)).toBeGreaterThan(0);
  });

  test("命中检测只接受最右列轨道", () => {
    const value = metrics(0);
    expect(hitScrollbar(value, 40, 2)).toBe(true);
    expect(hitScrollbar(value, 39, 2)).toBe(false);
    expect(hitScrollbar(value, 40, 12)).toBe(false);
  });

  test("滚动条覆盖最右列且不破坏原行宽度", () => {
    const value = metrics(0);
    const lines = Array.from({ length: 12 }, (_, index) => `line${index}`);
    const composed = composeScrollbar(lines, 10, value);
    expect(composed).toHaveLength(lines.length);
    expect(visibleWidth(composed[1]!)).toBe(10);
    expect(composed[1]).toContain("│");
  });
});
