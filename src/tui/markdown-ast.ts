/**
 * Markdown 结构解析的共享入口。
 *
 * 这里只暴露 Lezer AST 中稳定、可复用的最小能力，不让渲染层直接依赖
 * 具体节点遍历细节。Bun 仍负责行内 Markdown 的 ANSI 排版；Lezer 负责
 * 判断“这是不是一个代码块/表格”，替代容易漏边界的正则扫描。
 */

import type { SyntaxNode, Tree } from "@lezer/common";
import { GFM, parser, type MarkdownParser } from "@lezer/markdown";

/** GFM 配置只构建一次，流式边界跟踪与一次性渲染共用。 */
export const markdownParser: MarkdownParser = parser.configure(GFM);

export function parseMarkdownTree(text: string): Tree {
  return markdownParser.parse(text);
}

export interface FencedCodeParts {
  language: string;
  code: string;
}

export type MarkdownTableAlignment = "left" | "center" | "right";

export interface MarkdownTableRow {
  header: boolean;
  cells: readonly string[];
}

export interface MarkdownTableModel {
  alignments: readonly MarkdownTableAlignment[];
  rows: readonly MarkdownTableRow[];
}

function readTableAlignment(cell: string): MarkdownTableAlignment {
  const value = cell.trim();
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

function readTableAlignments(source: string): MarkdownTableAlignment[] {
  let row = source.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map(readTableAlignment);
}

function readTableCells(row: SyntaxNode, source: string): string[] {
  const cells: string[] = [];
  for (let child = row.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "TableCell") cells.push(source.slice(child.from, child.to));
  }
  return cells;
}

/** 把 GFM `Table` 节点读成与渲染器解耦的行列模型。 */
export function readTableModel(
  node: SyntaxNode,
  source: string,
): MarkdownTableModel | undefined {
  if (node.name !== "Table") return undefined;

  const rows: MarkdownTableRow[] = [];
  let alignments: MarkdownTableAlignment[] = [];

  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "TableHeader" || child.name === "TableRow") {
      rows.push({
        header: child.name === "TableHeader",
        cells: readTableCells(child, source),
      });
      continue;
    }
    if (child.name === "TableDelimiter" && alignments.length === 0) {
      alignments = readTableAlignments(source.slice(child.from, child.to));
    }
  }

  if (rows.length === 0) return undefined;
  const columns = Math.max(...rows.map((row) => row.cells.length));
  return {
    alignments: Array.from(
      { length: columns },
      (_, index) => alignments[index] ?? "left",
    ),
    rows,
  };
}

/**
 * 读取一个已经闭合的 fenced code block。
 *
 * Lezer 会把未闭合围栏也解析成 `FencedCode`，所以这里必须检查首尾两个
 * `CodeMark`，不能只凭节点名就认定代码块完整。
 */
export function readClosedFencedCode(
  node: SyntaxNode,
  source: string,
): FencedCodeParts | undefined {
  if (node.name !== "FencedCode") return undefined;

  const opening = node.firstChild;
  const closing = node.lastChild;
  if (
    opening?.name !== "CodeMark" ||
    closing?.name !== "CodeMark" ||
    closing.from <= opening.from
  ) {
    return undefined;
  }

  const info = opening.nextSibling?.name === "CodeInfo" ? opening.nextSibling : undefined;
  const rawLanguage = info === undefined ? "" : source.slice(info.from, info.to);
  const language = rawLanguage.trim().split(/\s+/, 1)[0] ?? "";

  const firstNewline = source.indexOf("\n", opening.to);
  const codeStart = firstNewline < 0 ? opening.to : firstNewline + 1;
  let code = source.slice(codeStart, closing.from);
  if (code.endsWith("\r\n")) code = code.slice(0, -2);
  else if (code.endsWith("\n")) code = code.slice(0, -1);

  return { language, code };
}
