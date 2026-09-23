export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";

import { highlightCode, isNativeLanguage, normalizeLanguage } from "./highlight.ts";

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
    //   不加这个的话 CJK 段落会因为"没有空格"而完全不折行。
    // trim: false —— **默认是 true，会剥掉行首空白**。对散文无所谓，
    //   对代码是灾难：Python 的缩进就是语法，`    return x` 被削成
    //   `return x` 之后整段代码读不懂了。这里必须显式关掉。
    for (const part of Bun.wrapAnsi(line, width, { hard: true, trim: false }).split("\n")) {
      out.push(part);
    }
  }
  return out;
}

/** markdown -> 终端 ANSI -> 按宽度折行。 */
export function renderMarkdown(text: string, width: number): string[] {
  const out: string[] = [];

  for (const segment of splitMarkdown(text)) {
    if (segment.kind === "prose") {
      // **必须传 columns** —— Bun.markdown.ansi 默认按 80 列折行，
      // 终端再宽也没用，表现就是"回答提前换行"。
      // 注意参数名是 columns 而不是 width（width 会被静默忽略）。
      out.push(...wrapToLines(Bun.markdown.ansi(segment.text, { columns: width }), width));
    } else {
      out.push(...renderCodeSegment(segment, width));
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 代码块：绕开 Bun 原生只支持 ts/js 的限制                              */
/* ------------------------------------------------------------------ */

export type MarkdownSegment =
  | { kind: "prose"; text: string }
  | { kind: "code"; language: string; code: string };

function isClosingFence(line: string, char: string, minLength: number): boolean {
  const trimmed = line.trim();
  if (trimmed.length < minLength) return false;
  for (const ch of trimmed) if (ch !== char) return false;
  return true;
}

/**
 * 把 markdown 切成「散文」与「代码块」。
 *
 * 为什么要切：`Bun.markdown.render()` 的自定义 `code` 回调会**顶掉全部
 * 原生排版**（标题、列表、引用都没样式了），代价太大。切开之后散文仍然
 * 交给 Bun 原生渲染，只有代码块走我们自己的高亮器。
 */
export function splitMarkdown(text: string): MarkdownSegment[] {
  const lines = text.split("\n");
  const segments: MarkdownSegment[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    if (prose.length === 0) return;
    segments.push({ kind: "prose", text: prose.join("\n") });
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);

    if (fence === null) {
      prose.push(line);
      i += 1;
      continue;
    }

    const marker = fence[1]!;
    const char = marker[0]!;
    const language = fence[2] ?? "";

    // 找结束围栏。流式输出中途会遇到未闭合的围栏，那时按普通文本处理，
    // 等闭合了再切成代码块 —— 否则每帧的解析结果会跳变。
    let j = i + 1;
    const codeLines: string[] = [];
    while (j < lines.length && !isClosingFence(lines[j]!, char, marker.length)) {
      codeLines.push(lines[j]!);
      j += 1;
    }

    if (j >= lines.length) {
      prose.push(line);
      i += 1;
      continue;
    }

    flushProse();
    segments.push({ kind: "code", language, code: codeLines.join("\n") });
    i = j + 1;
  }

  flushProse();
  return segments;
}

/** 从 Bun 原生输出里抽出代码正文（去掉它自带的 ┌─/│/└─ 边框）。 */
function nativeHighlightedBody(code: string, language: string): string {
  const wrapped = Bun.markdown.ansi(`\`\`\`${language}\n${code}\n\`\`\``);
  return wrapped
    .split("\n")
    .filter((line) => line.startsWith(`${DIM}│`))
    .map((line) => line.replace(/^\x1b\[2m│ \x1b\[0m/, ""))
    .join("\n");
}

function renderCodeSegment(
  segment: Extract<MarkdownSegment, { kind: "code" }>,
  width: number,
): string[] {
  const language = normalizeLanguage(segment.language);

  const highlighted = isNativeLanguage(language)
    ? nativeHighlightedBody(segment.code, language)
    : highlightCode(segment.code, language);

  // 先折行再加边框：直接折带 `│ ` 前缀的整行会让边框断掉
  const available = Math.max(1, width - 2);
  const body = wrapToLines(highlighted, available);

  const label = language.length > 0 ? `${DIM}${language}${RESET}` : "";
  const lines = [`${DIM}┌─ ${label}${RESET}`];
  for (const line of body) lines.push(`${DIM}│${RESET} ${line}`);
  lines.push(`${DIM}└─${RESET}`);
  return lines;
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

/**
 * 颜色 -> ANSI 背景色序列。
 *
 * Bun.color 只产出前景色，所以把 `38;` 换成 `48;` —— 这是 ANSI 的标准约定，
 * 16 色 / 256 色 / truecolor 三种格式都适用。
 */
export function bg(color: string, depth: "ansi-16" | "ansi-256" | "ansi-16m" = "ansi-16m"): string {
  const sequence = fg(color, depth);
  return sequence.replace("\x1b[38;", "\x1b[48;");
}

