/**
 * ANSI 工具 —— 全部建立在 Bun 原生能力之上，零依赖。
 *
 * 关键点：宽度计算用 `Bun.stringWidth`，截断用 `Bun.sliceAnsi`。
 * 两者都原生忽略 ANSI 转义序列、正确处理 CJK / emoji grapheme，
 * 并且默认采用一致的 ambiguous-width 规则。
 *
 * 唯一的例外是 **TAB**：`Bun.stringWidth("\t") === 0`，而终端把它渲染成
 * "跳到下一个制表位"（默认 8 列）。一行里只要有一个 TAB，TUI 认为的宽度就比终端
 * 实际渲染的窄 1~7 列 —— 补白、截断、滚动条都按这个偏小的宽度算，于是那一行顶出
 * 右边界，右对齐的东西（滚动条字符、`+N -M` 徽标）被挤掉。
 *
 * 所以本模块统一在**测量与截断之前**把 TAB 展开成空格（`expandTabs`），并在
 * `Screen.draw` 里对每一行做最后一次兜底展开。约定：测量宽度 = 展开后的宽度 =
 * 终端渲染宽度。
 */

const RESET = "\x1b[0m";

/** 制表位间隔，与终端默认值一致。 */
export const TAB_WIDTH = 8;

/**
 * 找到从 `index`（指向 ESC）开始的 ANSI 序列结束位置。
 *
 * 只认两类实际会用到的：CSI（`ESC [ ... final`）与 OSC（`ESC ] ... BEL|ST`）。
 * 其它 ESC 序列按两字符处理，宁可少吞也不能把正文吃掉。
 */
function ansiSequenceEnd(text: string, index: number): number {
  const kind = text[index + 1];
  if (kind === "[") {
    let cursor = index + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return cursor + 1;
      cursor += 1;
    }
    return text.length;
  }
  if (kind === "]") {
    let cursor = index + 2;
    while (cursor < text.length) {
      if (text[cursor] === "\x07") return cursor + 1;
      if (text[cursor] === "\x1b" && text[cursor + 1] === "\\") return cursor + 2;
      cursor += 1;
    }
    return text.length;
  }
  return Math.min(text.length, index + 2);
}

/**
 * 把 TAB 展开成空格，制表位按**可见列**推进（ANSI 序列不占列）。
 *
 * 没有 TAB 时原样返回（零拷贝路径：绝大多数行都不含 TAB）。
 */
export function expandTabs(text: string, tabWidth: number = TAB_WIDTH): string {
  if (!text.includes("\t")) return text;
  let out = "";
  let column = 0;
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;

    if (char === "\x1b") {
      const end = ansiSequenceEnd(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }

    if (char === "\t") {
      const spaces = tabWidth - (column % tabWidth);
      out += " ".repeat(spaces);
      column += spaces;
      index += 1;
      continue;
    }

    const code = text.codePointAt(index)!;
    const piece = String.fromCodePoint(code);
    out += piece;
    column += Bun.stringWidth(piece);
    index += piece.length;
  }

  return out;
}

/** 可见宽度（自动忽略 ANSI 序列，CJK 按 2 计，TAB 按制表位展开）。 */
export function visibleWidth(text: string): number {
  return Bun.stringWidth(expandTabs(text));
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
  const expanded = expandTabs(text);
  if (Bun.stringWidth(expanded) <= maxWidth) return expanded;
  const ellipsisWidth = Bun.stringWidth(ellipsis);
  if (ellipsisWidth > maxWidth) return Bun.sliceAnsi(expanded, 0, maxWidth, "", true);
  for (let budget = maxWidth - ellipsisWidth; budget >= 0; budget -= 1) {
    const head = Bun.sliceAnsi(expanded, 0, budget, "", true);
    if (Bun.stringWidth(head) + ellipsisWidth <= maxWidth) return `${head}${ellipsis}`;
  }
  return "";
}

/** 右侧补空格到指定可见宽度（已超宽则原样返回）。 */
export function padAnsi(text: string, width: number): string {
  const expanded = expandTabs(text);
  const current = Bun.stringWidth(expanded);
  if (current >= width) return expanded;
  return expanded + " ".repeat(width - current);
}

/** 用空格居中到指定可见宽度。 */
export function centerAnsi(text: string, width: number): string {
  const expanded = expandTabs(text);
  const current = Bun.stringWidth(expanded);
  if (current >= width) return expanded;
  const left = Math.floor((width - current) / 2);
  return " ".repeat(left) + expanded;
}

/** 一行是否为空（忽略 ANSI）。 */
export function isBlank(text: string): boolean {
  return visibleWidth(text) === 0;
}

export { RESET };
