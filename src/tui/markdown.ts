/**
 * 内容渲染 —— 直接吃 Bun 原生能力，零依赖。
 *
 *   Bun.markdown.ansi()  markdown -> ANSI（自带 ts/js 代码高亮、标题、列表、引用块样式）
 *   Bun.wrapAnsi()       ANSI 感知换行（不会把转义序列切断）
 *   Bun.stringWidth()    CJK 宽度计算
 *   Bun.color()          颜色 -> ANSI
 *
 * 这一层就是 Phase 8 的主体。
 */

/** 按可见宽度折行，返回若干行（不含换行符）。 */
export function wrapToLines(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];

  for (const line of text.split("\n")) {
    if (Bun.stringWidth(line) === 0) {
      out.push("");
      continue;
    }
    // hard: true —— 英文优先按空格断行，超长单词与无空格的中文按可见宽度硬断。
    // 不加这个的话 CJK 段落会因为"没有空格"而完全不折行。
    for (const part of Bun.wrapAnsi(line, width, { hard: true }).split("\n")) out.push(part);
  }
  return out;
}

/** markdown -> 终端 ANSI -> 按宽度折行。 */
export function renderMarkdown(text: string, width: number): string[] {
  return wrapToLines(Bun.markdown.ansi(text), width);
}

/** 纯文本（不解析 markdown），用于工具输出等。 */
export function renderPlain(text: string, width: number): string[] {
  return wrapToLines(text, width);
}

/** 颜色 -> ANSI 前景色序列。传入非法颜色时返回空串，绝不抛错。 */
export function fg(color: string, depth: "ansi-16" | "ansi-256" | "ansi-16m" = "ansi-256"): string {
  try {
    const result = Bun.color(color, depth);
    return typeof result === "string" ? result : "";
  } catch {
    return "";
  }
}

export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";
