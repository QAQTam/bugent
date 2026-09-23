import { describe, expect, test } from "bun:test";
import { composeHistoryDrawer, historyPaneHeights } from "../src/tui/history-drawer.ts";

describe("历史抽屉布局", () => {
  test("上下半屏比例稳定，小高度也能降级", () => {
    expect(historyPaneHeights(10)).toEqual({ top: 4, divider: 1, bottom: 5 });
    expect(historyPaneHeights(2)).toEqual({ top: 1, divider: 1, bottom: 0 });
    expect(historyPaneHeights(1)).toEqual({ top: 1, divider: 0, bottom: 0 });
  });

  test("上半屏是历史，下半屏是最新，中间有分隔行", () => {
    const layout = composeHistoryDrawer({
      width: 40,
      height: 6,
      topLines: ["old1", "old2"],
      bottomLines: ["new1", "new2"],
      offset: 12,
      maxOffset: 100,
    });

    expect(layout.lines).toHaveLength(6);
    expect(layout.lines.slice(0, 2)).toEqual(["old1", "old2"]);
    expect(layout.lines[layout.dividerRow]).toContain("更早消息");
    expect(layout.lines[layout.dividerRow]).toContain("最新消息");
    expect(layout.lines.slice(layout.bottomStart, layout.bottomEnd)).toEqual(["new1", "new2", ""]);
    expect(layout.lines.slice(layout.bottomEnd)).toEqual([]);
  });

  test("历史偏移和最大偏移显示在分隔行", () => {
    const layout = composeHistoryDrawer({
      width: 50,
      height: 6,
      topLines: [],
      bottomLines: [],
      offset: 42,
      maxOffset: 99,
    });

    expect(layout.lines[layout.dividerRow]).toContain("42/99");
  });
});
