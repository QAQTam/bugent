import { describe, expect, test } from "bun:test";
import {
  centerColumn,
  checkHitProbes,
  contentLineToScreenRow,
  formatHitProbeFailures,
  visibleRangeOf,
  type HitProbe,
} from "../src/tui/hit-probe.ts";

describe("命中自检", () => {
  const probes: HitProbe[] = [
    { name: "dialog:action:true", x: 30, y: 27, button: "left" },
    { name: "input:0", x: 3, y: 23, button: "left" },
  ];

  test("全部命中时没有失败项", () => {
    const resolve = (x: number, y: number): string | undefined =>
      probes.find((p) => p.x === x && p.y === y)?.name;
    expect(checkHitProbes(probes, resolve)).toEqual([]);
  });

  test("按键是判定的一部分：同一个点左右键命中不同目标", () => {
    const tool: HitProbe[] = [{ name: "message:5", x: 4, y: 13, button: "right" }];
    const resolve = (_x: number, _y: number, button: string): string =>
      button === "right" ? "message:5" : "tool:call-1";
    expect(checkHitProbes(tool, resolve)).toEqual([]);
    expect(checkHitProbes([{ ...tool[0]!, button: "left" }], resolve)).toHaveLength(1);
  });

  test("命中到别的目标时报告，并带上期望与实际", () => {
    const failures = checkHitProbes(probes, () => "dialog:action:false");
    expect(failures).toHaveLength(2);
    expect(failures[0]).toEqual({
      probe: { name: "dialog:action:true", x: 30, y: 27, button: "left" },
      actual: "dialog:action:false",
    });
  });

  test("什么都点不到时 actual 是 undefined", () => {
    const failures = checkHitProbes(probes, () => undefined);
    expect(failures.every((f) => f.actual === undefined)).toBe(true);
  });

  test("报错文本包含尺寸、目标、坐标与实际命中", () => {
    const message = formatHitProbeFailures(
      [
        {
          probe: { name: "dialog:message:copy", x: 31, y: 28, button: "left" },
          actual: "dialog:message:inspect",
        },
      ],
      { width: 120, height: 30 },
    );
    expect(message).toContain("120x30");
    expect(message).toContain("dialog:message:copy");
    expect(message).toContain("(31,28)");
    expect(message).toContain("dialog:message:inspect");
  });
});

describe("内容行 -> 屏幕行", () => {
  test("窗口首行落在正文第一行（第 2 行）", () => {
    expect(contentLineToScreenRow(10, 10, 0, 5)).toBe(2);
    expect(contentLineToScreenRow(13, 10, 0, 5)).toBe(5);
  });

  test("有“查看更多消息”时内容整体下移一行", () => {
    expect(contentLineToScreenRow(10, 10, 1, 5)).toBe(3);
  });

  test("窗口之外返回 undefined", () => {
    expect(contentLineToScreenRow(9, 10, 0, 5)).toBeUndefined();
    expect(contentLineToScreenRow(15, 10, 0, 5)).toBeUndefined();
  });
});

describe("区间可见性", () => {
  test("区间在窗口内时取整段", () => {
    expect(visibleRangeOf({ start: 12, end: 14 }, 10, 0, 5)).toEqual({ first: 12, last: 14 });
  });

  test("区间跨越窗口边界时夹到窗口内", () => {
    expect(visibleRangeOf({ start: 8, end: 20 }, 10, 0, 5)).toEqual({ first: 10, last: 14 });
  });

  test("区间整个滚到窗口上方时不可见", () => {
    // 这正是自检最初误报的场景：块已经滚出去了，不该要求它可点击
    expect(visibleRangeOf({ start: 3, end: 9 }, 10, 0, 5)).toBeUndefined();
  });

  test("区间整个在窗口下方时不可见", () => {
    expect(visibleRangeOf({ start: 15, end: 20 }, 10, 0, 5)).toBeUndefined();
  });

  test("“查看更多消息”占的那一行不算内容可见范围", () => {
    // contentOffset=1 时，窗口首行是按钮行，内容从窗口首行开始
    expect(visibleRangeOf({ start: 10, end: 12 }, 10, 1, 5)).toEqual({ first: 10, last: 12 });
    // 可见内容只有 4 行（5 - 1），所以第 14 行及以后看不到
    expect(visibleRangeOf({ start: 14, end: 16 }, 10, 1, 5)).toBeUndefined();
  });
});

describe("矩形中心列", () => {
  test("取闭区间中点", () => {
    expect(centerColumn(2, 14)).toBe(8);
    expect(centerColumn(2, 3)).toBe(2);
  });
});
