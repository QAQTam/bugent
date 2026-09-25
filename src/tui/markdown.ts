export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";

import { highlightCode, isNativeLanguage, normalizeLanguage } from "./highlight.ts";
import { currentBackground } from "./theme.ts";
import { padAnsi, truncateAnsi, visibleWidth } from "./ansi.ts";
import {
  parseMarkdownTree,
  readClosedFencedCode,
  readTableModel,
  type MarkdownTableAlignment,
  type MarkdownTableModel,
  type MarkdownTableRow,
} from "./markdown-ast.ts";

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

export interface MarkdownRenderOptions {
  /** 是否输出 OSC 8 可点击链接；不传时按终端能力探测。 */
  hyperlinks?: boolean;
  /** 是否启用 Kitty Graphics；不传时只在已知支持的终端开启。 */
  kittyGraphics?: boolean;
  /**
   * 终端底色是否为浅色。影响行内代码的**字色**（Bun 会给深色终端挑
   * `38;5;215`、给浅色终端挑 `38;5;124`）。不传时用启动时探测到的结果。
   *
   * 注意行内代码的**底色**被 bugent 主动剥掉了（见 `stripBackground`），
   * 所以 `light` 不再影响底色。
   */
  light?: boolean;
}

function terminalSupportsHyperlinks(): boolean {
  if (process.stdout.isTTY !== true) return false;
  return process.env.TERM !== "dumb";
}

function terminalSupportsKittyGraphics(): boolean {
  if (process.stdout.isTTY !== true) return false;
  const env = process.env;
  return Boolean(
    env.KITTY_WINDOW_ID ??
      env.WEZTERM_PANE ??
      env.GHOSTTY_RESOURCES_DIR ??
      (env.TERM?.toLowerCase().includes("kitty") ? env.TERM : undefined) ??
      (env.TERM_PROGRAM === "WezTerm" || env.TERM_PROGRAM === "ghostty"
        ? env.TERM_PROGRAM
        : undefined),
  );
}

/**
 * Bun.wrapAnsi 不认 Kitty Graphics 的 APC 序列，会把图片行折成空串；
 * 图片控制序列必须原样透传，其余行继续正常折行。
 */
function wrapPreservingGraphics(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.includes("\x1b_G")) {
      out.push(line);
      continue;
    }
    out.push(...wrapToLines(line, width));
  }
  return out;
}

/**
 * 去掉「设置背景色」的 SGR 序列，让底色透出终端本身。
 *
 * 唯一的来源是 `Bun.markdown.ansi` 给行内代码铺的那层底（深色终端
 * `48;5;236`、浅色终端 `48;5;254`）。bugent 不要色块，只要字色，所以把
 * 这些序列整段剥掉。
 *
 * 只剥「设置」（`4x` / `48;5;n` / `48;2;r;g;b`），不碰 `49` 复位：复位只是
 * 回到默认底，不画色块，留着无害；而误删复位反而可能让颜色渗到后续文本。
 */
const BACKGROUND_SET = /\x1b\[(?:4[0-7]|48;5;\d+|48;2;\d+;\d+;\d+)m/g;

function stripBackground(text: string): string {
  return text.replace(BACKGROUND_SET, "");
}

/** markdown -> 终端 ANSI -> 按宽度折行。 */
export function renderMarkdown(
  text: string,
  width: number,
  options: MarkdownRenderOptions = {},
): string[] {
  const out: string[] = [];
  const hyperlinks = options.hyperlinks ?? terminalSupportsHyperlinks();
  const kittyGraphics = options.kittyGraphics ?? terminalSupportsKittyGraphics();
  // 显式传 light，不依赖 Bun 自己在进程启动时读的 COLORFGBG
  const light = options.light ?? currentBackground() === "light";

  for (const segment of splitMarkdown(text)) {
    if (segment.kind === "prose") {
      // **必须传 columns** —— Bun.markdown.ansi 默认按 80 列折行，
      // 终端再宽也没用，表现就是"回答提前换行"。
      // 注意参数名是 columns 而不是 width（width 会被静默忽略）。
      const rendered = Bun.markdown.ansi(segment.text, {
        columns: width,
        hyperlinks,
        light,
        ...(kittyGraphics ? { kittyGraphics: true } : {}),
      });
      out.push(...wrapPreservingGraphics(stripBackground(rendered), width));
    } else if (segment.kind === "table") {
      out.push(
        ...renderTableSegment(segment.lines, segment.model, width, { hyperlinks }),
      );
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
  | { kind: "code"; language: string; code: string }
  | { kind: "table"; lines: readonly string[]; model: MarkdownTableModel };

const MAX_INLINE_CELL_CACHE_ENTRIES = 2048;
const inlineCellCache = new Map<string, string>();

function renderInlineTableCell(source: string, hyperlinks: boolean): string {
  const key = `${hyperlinks ? "1" : "0"}\u0000${source}`;
  const cached = inlineCellCache.get(key);
  if (cached !== undefined) {
    inlineCellCache.delete(key);
    inlineCellCache.set(key, cached);
    return cached;
  }

  const rendered = Bun.markdown.render(source, {
    strong: (children) => `${BOLD}${children}${RESET}`,
    emphasis: (children) => `\x1b[3m${children}\x1b[23m`,
    codespan: (children) => `\x1b[38;5;215m${children}${RESET}`,
    strikethrough: (children) => `\x1b[9m${children}\x1b[29m`,
    link: (children, meta) =>
      hyperlinks ? `\x1b]8;;${meta.href}\x07${children}\x1b]8;;\x07` : children,
    image: (children) => children,
  });
  inlineCellCache.set(key, rendered);
  while (inlineCellCache.size > MAX_INLINE_CELL_CACHE_ENTRIES) {
    const oldest = inlineCellCache.keys().next().value;
    if (oldest === undefined) break;
    inlineCellCache.delete(oldest);
  }
  return rendered;
}

function padTableCell(
  text: string,
  width: number,
  align: MarkdownTableAlignment,
): string {
  const clipped = truncateAnsi(text, width);
  const gap = Math.max(0, width - visibleWidth(clipped));
  if (gap === 0) return clipped;
  switch (align) {
    case "right":
      return " ".repeat(gap) + clipped;
    case "center": {
      const left = Math.floor(gap / 2);
      return " ".repeat(left) + clipped + " ".repeat(gap - left);
    }
    case "left":
    default:
      return padAnsi(clipped, width);
  }
}

function renderTableRow(
  row: MarkdownTableRow,
  widths: readonly number[],
  alignments: readonly MarkdownTableAlignment[],
  hyperlinks: boolean,
): string[] {
  const cells = widths.map((width, index) => {
    const inline = renderInlineTableCell(row.cells[index] ?? "", hyperlinks);
    return wrapToLines(row.header ? `${BOLD}${inline}${RESET}` : inline, width);
  });
  const height = Math.max(1, ...cells.map((lines) => lines.length));
  const vertical = `${DIM}│${RESET}`;
  const out: string[] = [];

  for (let line = 0; line < height; line += 1) {
    let rendered = vertical;
    for (let column = 0; column < widths.length; column += 1) {
      const content = cells[column]?.[line] ?? "";
      rendered += ` ${padTableCell(content, widths[column]!, alignments[column] ?? "left")} `;
      rendered += vertical;
    }
    out.push(rendered);
  }
  return out;
}

function renderTableSegment(
  lines: readonly string[],
  model: MarkdownTableModel,
  width: number,
  options: { hyperlinks: boolean },
): string[] {
  const source = lines.join("\n");
  if (model.rows.length === 0) return wrapToLines(source, width);

  const columns = Math.max(
    model.alignments.length,
    ...model.rows.map((row) => row.cells.length),
  );
  if (columns === 0) return [];

  const rows = model.rows.map((row) => ({
    ...row,
    cells: Array.from({ length: columns }, (_, index) =>
      renderInlineTableCell(row.cells[index] ?? "", options.hyperlinks),
    ),
  }));
  const alignments = Array.from(
    { length: columns },
    (_, index) => model.alignments[index] ?? "left",
  );
  const natural = Array.from({ length: columns }, (_, index) => {
    let max = 1;
    for (const row of rows) {
      max = Math.max(max, visibleWidth(row.cells[index] ?? ""));
    }
    return max;
  });
  const minimum = Array.from({ length: columns }, (_, index) => {
    let min = 1;
    for (const row of rows) {
      for (const char of Bun.stripANSI(row.cells[index] ?? "")) {
        min = Math.max(min, Bun.stringWidth(char));
      }
    }
    return min;
  });

  // 每列左右各留 1 空格，再加 columns + 1 根竖线。
  const borderCost = columns * 3 + 1;
  const available = width - borderCost;
  if (available < minimum.reduce((sum, value) => sum + value, 0)) {
    return lines.map((line) => truncateAnsi(line, width));
  }

  const widths = [...natural];
  let total = widths.reduce((sum, value) => sum + value, 0);
  while (total > available) {
    let widest = 0;
    for (let index = 1; index < widths.length; index += 1) {
      if (
        widths[index]! > widths[widest]! &&
        widths[index]! > minimum[index]!
      ) {
        widest = index;
      }
    }
    if (widths[widest]! <= minimum[widest]!) break;
    widths[widest] = widths[widest]! - 1;
    total -= 1;
  }

  const border = (left: string, middle: string, right: string): string =>
    `${DIM}${left}${widths.map((value) => "─".repeat(value + 2)).join(middle)}${right}${RESET}`;

  const out = [border("┌", "┬", "┐")];
  out.push(...renderTableRow(rows[0]!, widths, alignments, options.hyperlinks));
  out.push(border("├", "┼", "┤"));
  for (let index = 1; index < rows.length; index += 1) {
    out.push(...renderTableRow(rows[index]!, widths, alignments, options.hyperlinks));
  }
  out.push(border("└", "┴", "┘"));
  return out;
}

/**
 * 把 markdown 切成「散文 / 代码块 / 表格」。
 *
 * 结构识别交给 Lezer AST；Bun 只负责散文和表格单元格的行内排版。这样不再
 * 维护“围栏怎么闭合、表格 delimiter 长什么样”的第二套正则规则。
 */
export function splitMarkdown(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const tree = parseMarkdownTree(text);
  let cursor = 0;

  const pushProse = (end: number, separatorBeforeBlock: boolean): void => {
    let proseEnd = end;
    if (separatorBeforeBlock) {
      if (text.endsWith("\r\n", proseEnd)) proseEnd -= 2;
      else if (text[proseEnd - 1] === "\n") proseEnd -= 1;
    }
    if (proseEnd <= cursor) return;
    segments.push({ kind: "prose", text: text.slice(cursor, proseEnd) });
  };

  const consumeLineEnding = (): void => {
    if (text.startsWith("\r\n", cursor)) cursor += 2;
    else if (text[cursor] === "\n") cursor += 1;
  };

  for (let node = tree.topNode.firstChild; node !== null; node = node.nextSibling) {
    if (node.name === "Table") {
      const model = readTableModel(node, text);
      if (model === undefined) continue;
      pushProse(node.from, true);
      segments.push({
        kind: "table",
        lines: text.slice(node.from, node.to).split("\n"),
        model,
      });
      cursor = node.to;
      consumeLineEnding();
      continue;
    }

    if (node.name !== "FencedCode") continue;
    const code = readClosedFencedCode(node, text);
    if (code === undefined) continue;

    pushProse(node.from, true);
    segments.push({ kind: "code", language: code.language, code: code.code });
    cursor = node.to;
    consumeLineEnding();
  }

  pushProse(text.length, false);
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

