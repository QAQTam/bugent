import { describe, expect, test } from "bun:test";
import {
  closeHistoryView,
  initialHistoryView,
  openHistoryView,
  returnToLatestView,
  scrollHistoryView,
  scrollMainView,
  shouldShowMoreButton,
  shouldShowReturnButton,
  syncHistoryView,
} from "../src/tui/history-state.ts";

describe("HistoryViewState", () => {
  test("向上滚动退出钉底，滚回底部恢复 followTail", () => {
    const scrolled = scrollMainView(initialHistoryView(), 3, 100, 10);
    expect(scrolled.scrollOffset).toBe(3);
    expect(scrolled.followTail).toBe(false);

    const back = scrollMainView(scrolled, -3, 100, 10);
    expect(back.scrollOffset).toBe(0);
    expect(back.followTail).toBe(true);
  });

  test("滚到回看上限后显示查看更多消息", () => {
    // 200 行内容、10 行正文：窗口 100 行 → 回看上限 90
    const state = { ...initialHistoryView(), followTail: false, scrollOffset: 90 };
    expect(shouldShowMoreButton(state, 200, 10)).toBe(true);

    state.scrollOffset = 89;
    expect(shouldShowMoreButton(state, 200, 10)).toBe(false);
  });

  test("内容全在主视图里时不显示查看更多消息", () => {
    // 100 行刚好被窗口覆盖（下限 100）→ 上面没有更早的消息
    const state = { ...initialHistoryView(), followTail: false, scrollOffset: 90 };
    expect(shouldShowMoreButton(state, 100, 10)).toBe(false);
  });

  test("打开历史抽屉时落在主区窗口上方", () => {
    const state = openHistoryView(initialHistoryView(), 200, 10);
    expect(state.historyOpen).toBe(true);
    // 抽屉自己的上限 = 200 - top(4) = 196；主区窗口上方 = 90 + 10 = 100
    expect(state.historyOffset).toBe(100);
  });

  test("新内容到达时主区和历史区都保持锚点", () => {
    const state = {
      ...openHistoryView(initialHistoryView(), 100, 10),
      followTail: false,
      scrollOffset: 5,
    };
    const next = syncHistoryView(state, 105, 10, 5);

    expect(next.scrollOffset).toBe(10);
    // 抽屉开在 min(抽屉上限 96, 主区窗口上方 90+10) = 96；新内容 +5 后
    // 顶到抽屉自己的上限 maxHistoryOffset(105,10) = 105 - 4 = 101
    expect(next.historyOffset).toBe(101);
  });

  test("关闭抽屉与回到最新是两种不同语义", () => {
    const opened = openHistoryView(
      { ...initialHistoryView(), followTail: false, scrollOffset: 8 },
      100,
      10,
    );

    const closed = closeHistoryView(opened);
    expect(closed.historyOpen).toBe(false);
    expect(closed.scrollOffset).toBe(8); // 仍停留在回看位置

    const latest = returnToLatestView(opened);
    expect(latest).toEqual(initialHistoryView());
    expect(shouldShowReturnButton(latest)).toBe(false);
  });

  test("历史区滚动会被夹紧", () => {
    const state = openHistoryView(initialHistoryView(), 100, 10);
    expect(scrollHistoryView(state, 999, 100, 10).historyOffset).toBe(96);
    expect(scrollHistoryView(state, -999, 100, 10).historyOffset).toBe(0);
  });
});
