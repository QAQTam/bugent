/**
 * ANSI 工具 —— 全部建立在 Bun 原生能力之上，零依赖。
 *
 * 关键点：`Bun.stringWidth` 本身就会**忽略 ANSI 转义序列**并正确计算 CJK 宽字符，
 * 所以宽度计算不需要自己写 strip-ansi。
 */

const ESC = "\x1b";
const RESET = "\x1b[0m";

/** 可见宽度（自动忽略 ANSI 序列，CJK 按 2 计）。 */
export function visibleWidth(text: string): number {
  return Bun.stringWidth(text);
}

/** 返回从 index 处的转义序列结束后的下标。 */
function escapeEnd(text: string, index: number): number {
  const next = text[index + 1];
  if (next === "[") {
    let i = index + 2;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1;
      i += 1;
    }
    return text.length;
  }
  if (next === "]") {
    let i = index + 2;
    while (i < text.length) {
      if (text[i] === "\x07") return i + 1;
      if (text[i] === ESC && text[i + 1] === "\\") return i + 2;
      i += 1;
    }
    return text.length;
  }
  return Math.min(index + 2, text.length);
}

/** 按可见宽度截断，保留 ANSI 序列完整性，并追加省略号。 */
export function truncateAnsi(text: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  const ellipsisWidth = visibleWidth(ellipsis);
  const budget = Math.max(0, maxWidth - ellipsisWidth);

  let width = 0;
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === ESC) {
      const end = escapeEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const charWidth = Bun.stringWidth(char);
    if (width + charWidth > budget) break;
    out += char;
    width += charWidth;
    i += char.length;
  }
  return `${out}${RESET}${ellipsis}`;
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
