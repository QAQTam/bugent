/**
 * 屏幕坐标命中区。
 *
 * 全项目只保留这一种坐标系：**1-based 屏幕行列，闭区间**。
 *
 * 为什么只留一种：渲染和命中判定各自维护一套换算时（弹窗局部列、body 相对
 * 行、内容行窗口偏移…），两边各自自洽、单测各自通过，偏差只在特定终端尺寸
 * 下才暴露。把登记统一到屏幕坐标之后，命中判定退化成"点在不在这个矩形里"，
 * 没有第二次换算，也就没有"两个空间对不上"这一类 bug。
 *
 * 各区域之间的优先级由调用方的判定顺序决定，与坐标系无关。
 */

export interface HitRect {
  /** 1-based 屏幕行，闭区间。 */
  top: number;
  bottom: number;
  /** 1-based 屏幕列，闭区间。 */
  left: number;
  right: number;
}

export function hitRect(rect: HitRect | undefined, x: number, y: number): boolean {
  return (
    rect !== undefined && y >= rect.top && y <= rect.bottom && x >= rect.left && x <= rect.right
  );
}

/** 单行区间：行号与列区间都是 1-based 屏幕坐标。 */
export function rectOfRow(row: number, start: number, end: number): HitRect {
  return { top: row, bottom: row, left: start, right: end };
}

/** 矩形中心，用于生成命中探针。 */
export function rectCenter(rect: HitRect): { x: number; y: number } {
  return {
    x: Math.floor((rect.left + rect.right) / 2),
    y: Math.floor((rect.top + rect.bottom) / 2),
  };
}
