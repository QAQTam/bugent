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

  test("到达三屏上限后显示查看更多消息", () => {
    const state = { ...initialHistoryView(), followTail: false, scrollOffset: 20 };
    expect(shouldShowMoreButton(state, 100, 10)).toBe(true);

    state.scrollOffset = 19;
    expect(shouldShowMoreButton(state, 100, 10)).toBe(false);
  });

  test("打开历史抽屉时落在主区三屏窗口上方", () => {
    const state = openHistoryView(initialHistoryView(), 100, 10);
    expect(state.historyOpen).toBe(true);
    expect(state.historyOffset).toBe(30); // main max 20 + body height 10
  });

  test("新内容到达时主区和历史区都保持锚点", () => {
    const state = {
      ...openHistoryView(initialHistoryView(), 100, 10),
      followTail: false,
      scrollOffset: 5,
    };
    const next = syncHistoryView(state, 105, 10, 5);

    expect(next.scrollOffset).toBe(10);
    expect(next.historyOffset).toBe(35);
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
