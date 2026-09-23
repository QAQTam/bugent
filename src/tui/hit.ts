/** 屏幕坐标命中区间；row/x 都是 1-based。 */
export interface HitRegion {
  row: number;
  start: number;
  end: number;
}

export function hitTest(region: HitRegion | undefined, x: number, y: number): boolean {
  return region !== undefined && y === region.row && x >= region.start && x <= region.end;
}
