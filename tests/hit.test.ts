import { describe, expect, test } from "bun:test";
import { hitRect, rectCenter, rectOfRow } from "../src/tui/hit.ts";
import { composeCenteredButton } from "../src/tui/history-drawer.ts";
import { hitTargetName } from "../src/tui/hit-target.ts";
import { visibleWidth } from "../src/tui/ansi.ts";

describe("鼠标命中", () => {
  test("只在矩形内命中，undefined 永远不命中", () => {
    const rect = { top: 4, bottom: 6, left: 10, right: 20 };
    expect(hitRect(rect, 10, 4)).toBe(true);
    expect(hitRect(rect, 20, 4)).toBe(true);
    expect(hitRect(rect, 15, 6)).toBe(true);
    expect(hitRect(rect, 9, 4)).toBe(false);
    expect(hitRect(rect, 10, 3)).toBe(false);
    expect(hitRect(rect, 10, 7)).toBe(false);
    expect(hitRect(undefined, 10, 4)).toBe(false);
  });

  test("单行区间与中心", () => {
    expect(rectOfRow(7, 9, 11)).toEqual({ top: 7, bottom: 7, left: 9, right: 11 });
    expect(rectCenter({ top: 4, bottom: 6, left: 10, right: 20 })).toEqual({ x: 15, y: 5 });
    expect(rectCenter(rectOfRow(7, 9, 10))).toEqual({ x: 9, y: 7 });
  });

  test("居中按钮返回正确的点击区间", () => {
    const button = composeCenteredButton("abc", 20, 7);
    expect(visibleWidth(button.line)).toBe(11);
    expect(button.line.trimEnd()).toBe("        abc");
    expect(button.hit).toEqual({ top: 7, bottom: 7, left: 9, right: 11 });
  });

  test("窄屏时按钮被截断，命中区间不越界", () => {
    const button = composeCenteredButton("[ 查看更多消息 ]", 5, 0);
    expect(visibleWidth(button.line)).toBeLessThanOrEqual(5);
    expect(button.hit).toEqual({ top: 0, bottom: 0, left: 1, right: 5 });
  });
});

describe("命中目标 id", () => {
  test("每种目标都有稳定 id，用于自检比较与报错定位", () => {
    expect(hitTargetName({ kind: "scrollbar" })).toBe("scrollbar");
    expect(hitTargetName({ kind: "dialogButton", value: true })).toBe("dialog:action:true");
    expect(hitTargetName({ kind: "messageButton", value: "copy" })).toBe("dialog:message:copy");
    expect(hitTargetName({ kind: "dialogBody" })).toBe("dialog:body");
    expect(hitTargetName({ kind: "askLine", line: 3 })).toBe("ask:line:3");
    expect(hitTargetName({ kind: "input", index: 5 })).toBe("input:5");
    expect(hitTargetName({ kind: "returnToLatest" })).toBe("returnToLatest");
    expect(hitTargetName({ kind: "moreHistory" })).toBe("moreHistory");
    expect(hitTargetName({ kind: "tool", callId: "c1" })).toBe("tool:c1");
    expect(hitTargetName({ kind: "message", msgid: 7, undoMsgid: 7 })).toBe("message:7");
  });
});
