/**
 * 消息区视窗计算。
 *
 * 两个方向相反的策略在这里汇合，所以单独抽出来：
 *   - 视窗是**钉底**的（scrollOffset = 0 时看最新内容）
 *   - 长条目的渲染是**从开头截断**的（head + "还有 N 行"）
 *
 * 直接叠加的结果是：滚到底时既看不到条目头部（含 +N -M 徽标），
 * 也看不到内容结尾，只剩信息量最低的中段。
 *
 * 解法是**吸顶**：窗口起点落在某个条目内部时，把该条目的头部
 * 覆盖到第一行。对 bash 长输出、read_file 大文件同样有效。
 */

export interface ViewportSpan {
  /** 在完整内容里的起止下标（含）。 */
  start: number;
  end: number;
  /** 该区间的头部行（如工具条目的 `⏺ edit_file x.ts  +2 -3`），用于吸顶。 */
  header: string;
}

export interface ViewportResult {
  lines: string[];
  /** 窗口在完整内容里的起始下标（用于鼠标命中测试）。 */
  start: number;
}

export function sliceViewport(
  all: readonly string[],
  spans: readonly ViewportSpan[],
  height: number,
  scrollOffset: number,
): ViewportResult {
  const total = all.length;

  if (total <= height) {
    const lines = all.slice();
    while (lines.length < height) lines.push("");
    return { lines, start: 0 };
  }

  const end = scrollOffset === 0 ? total : Math.max(height, total - scrollOffset);
  const start = Math.max(0, end - height);
  const lines = all.slice(start, end);

  // 吸顶：只在下标严格落在条目内部时替换 —— 正好在条目开头时头部本来就在第一行
  if (start > 0 && lines.length > 0) {
    const covering = spans.find((span) => start > span.start && start <= span.end);
    if (covering !== undefined && covering.header.length > 0) {
      lines[0] = covering.header;
    }
  }

  return { lines, start };
}
