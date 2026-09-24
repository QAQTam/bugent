/**
 * 命中区间自检：每个可点区域，用它**自己登记的矩形中心**去问一次
 * "这里点下去会命中谁"，答案必须还是它自己。
 *
 * 为什么需要：渲染和命中判定各自维护一份坐标换算（弹窗居中留白、body 行
 * 偏移、内容行窗口偏移…），两边各自自洽、单测各自通过，只有组合起来才错。
 * 这类 bug 的表现是"点按钮没反应"或"点到了隔壁"，而且偏差随终端尺寸放大，
 * 端到端跑一下经常蒙中，所以很难靠手测发现。
 *
 * 这条不变量成立时，不可点击的区域在数学上不存在；不成立时，报错会直接
 * 点名是哪个区域、在什么尺寸下、偏到了哪里 —— 不需要再人工二分排查。
 */

import type { ProbeButton } from "./hit-target.ts";

export interface HitProbe {
  /** 报错定位用：如 `dialog:action:true`、`tool:call-3`。 */
  name: string;
  /** 屏幕坐标（1-based）。取自该区域自己登记的矩形。 */
  x: number;
  y: number;
  /**
   * 用哪个键点。目标与按键有关：工具卡片左键是展开/收起，右键才是消息菜单，
   * 所以同一个矩形在两种按键下本来就该命中不同的目标。
   */
  button: ProbeButton;
}

export interface HitProbeFailure {
  probe: HitProbe;
  /** 实际命中的目标；undefined 表示这里什么都点不到。 */
  actual: string | undefined;
}

/**
 * 把探针逐个喂回命中入口，返回对不上的那些。
 *
 * `resolve` 必须是鼠标处理真正使用的那条路径 —— 另写一份实现就等于在测试
 * 另一份实现，什么也保证不了。
 */
export function checkHitProbes(
  probes: readonly HitProbe[],
  resolve: (x: number, y: number, button: ProbeButton) => string | undefined,
): HitProbeFailure[] {
  const failures: HitProbeFailure[] = [];
  for (const probe of probes) {
    const actual = resolve(probe.x, probe.y, probe.button);
    if (actual !== probe.name) failures.push({ probe, actual });
  }
  return failures;
}

export function formatHitProbeFailures(
  failures: readonly HitProbeFailure[],
  size: { width: number; height: number },
): string {
  const lines = [
    `命中区间自检失败：${failures.length} 个区域点不到（终端 ${size.width}x${size.height}）`,
  ];
  for (const { probe, actual } of failures) {
    const key = probe.button === "right" ? "右键" : "左键";
    lines.push(
      `  ${probe.name} ${key}点在 (${probe.x},${probe.y}) -> ${actual ?? "什么都没命中"}`,
    );
  }
  return lines.join("\n");
}

/**
 * 内容行下标 -> 屏幕行号（1-based）。
 *
 * 正文区从第 2 行开始（第 1 行是状态栏），中间还隔着窗口起点和
 * "查看更多消息"那一行。不在可见窗口内返回 undefined —— 没画出来的东西
 * 本来就不该被点到。
 */
export function contentLineToScreenRow(
  lineIndex: number,
  windowStart: number,
  contentOffset: number,
  visibleRows: number,
): number | undefined {
  const row = lineIndex - windowStart + contentOffset;
  if (row < 0 || row >= visibleRows) return undefined;
  return row + 2;
}

/**
 * 取区间与可见窗口交集里的一行，用来给这个区间生成探针。
 *
 * 不能简单地 `max(start, windowStart)`：区间可能整个滚到窗口上方去了
 * （`end < windowStart`），那时交集是空的，这个区间**没有画出来**，也就不该
 * 被要求可点击。
 *
 * 窗口在内容行空间里的范围是 `[windowStart, windowStart + visibleRows -
 * contentOffset - 1]` —— 下界不含 `- contentOffset`：`contentOffset` 那一行
 * 是"查看更多消息"按钮占的，属于按钮自己的区间，不属于任何内容块。
 */
export function visibleRangeOf(
  range: { start: number; end: number },
  windowStart: number,
  contentOffset: number,
  visibleRows: number,
): { first: number; last: number } | undefined {
  const first = Math.max(range.start, windowStart);
  const last = Math.min(range.end, windowStart + visibleRows - 1 - contentOffset);
  return first > last ? undefined : { first, last };
}

/** 矩形中心列；`start`/`end` 是同一坐标系下的闭区间。 */
export function centerColumn(start: number, end: number): number {
  return Math.floor((start + end) / 2);
}

/** 视觉锚点：登记的位置必须和画出来的位置重合。 */
export interface VisualAnchor {
  name: string;
  x: number;
  y: number;
  /** 这一格应该画出来的字符。 */
  glyph: string;
}

export interface AnchorFailure {
  anchor: VisualAnchor;
  actual: string;
}

/**
 * 检查登记的矩形是否真的落在画出来的控件上。
 *
 * 为什么还需要它：登记改用屏幕坐标之后，中心探针只能验证"命中路径与登记表
 * 一致"；登记表自己算错（比如居中留白算错）时两边会一起错、互相抵消。锚点
 * 直接比对渲染出来的字符，把登记钉在真实画面上 —— 这是唯一不受换算影响的
 * 参照物。
 */
export function checkVisualAnchors(
  anchors: readonly VisualAnchor[],
  cellAt: (x: number, y: number) => string,
): AnchorFailure[] {
  const failures: AnchorFailure[] = [];
  for (const anchor of anchors) {
    const actual = cellAt(anchor.x, anchor.y);
    if (actual !== anchor.glyph) failures.push({ anchor, actual });
  }
  return failures;
}

export function formatAnchorFailures(
  failures: readonly AnchorFailure[],
  size: { width: number; height: number },
): string {
  const lines = [
    `命中锚点自检失败：${failures.length} 处登记位置与画面不符（终端 ${size.width}x${size.height}）`,
  ];
  for (const { anchor, actual } of failures) {
    lines.push(
      `  ${anchor.name} 期望 (${anchor.x},${anchor.y}) 是 ${JSON.stringify(anchor.glyph)}，实际 ${JSON.stringify(actual)}`,
    );
  }
  return lines.join("\n");
}
