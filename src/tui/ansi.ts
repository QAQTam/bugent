/**
 * ANSI 工具 —— 全部建立在 Bun 原生能力之上，零依赖。
 *
 * 关键点：宽度计算用 `Bun.stringWidth`，截断用 `Bun.sliceAnsi`。
 * 两者都原生忽略 ANSI 转义序列、正确处理 CJK / emoji grapheme，
 * 并且默认采用一致的 ambiguous-width 规则。
 */

const RESET = "\x1b[0m";

/** 可见宽度（自动忽略 ANSI 序列，CJK 按 2 计）。 */
export function visibleWidth(text: string): number {
  return Bun.stringWidth(text);
}

/**
 * 按可见宽度截断，保留 ANSI 序列完整性，并追加省略号。
 *
 * 结果**保证**不超过 maxWidth。`Bun.sliceAnsi` 自己不做这个保证：它按列切，
 * 但会把跨界的宽字符整个带出来（预算 15 列切 CJK 会返回 16 列），省略号也
 * 不计入预算。差这一列，整行就会在终端里自动折行 —— 铺满整行的底色块（吸顶
 * 用户消息）一旦折行就散了。所以这里切完再量，不满足就少给一列重切。
 */
export function truncateAnsi(text: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth > maxWidth) return Bun.sliceAnsi(text, 0, maxWidth, "", true);
  for (let budget = maxWidth - ellipsisWidth; budget >= 0; budget -= 1) {
    const head = Bun.sliceAnsi(text, 0, budget, "", true);
    if (visibleWidth(head) + ellipsisWidth <= maxWidth) return `${head}${ellipsis}`;
  }
  return "";
}

/** 右侧补空格到指定可见宽度（已超宽则原样返回）。 */
export function padAnsi(text: string, width: number): string {
  const current = visibleWidth(text);
  if (current >= width) return text;
  return text + " ".repeat(width - current);
}

/** 用空格居中到指定可见宽度。 */
export function centerAnsi(text: string, width: number): string {
  const current = visibleWidth(text);
  if (current >= width) return text;
  const left = Math.floor((width - current) / 2);
  return " ".repeat(left) + text;
}

/** 一行是否为空（忽略 ANSI）。 */
export function isBlank(text: string): boolean {
  return visibleWidth(text) === 0;
}

export { RESET };
