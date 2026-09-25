/**
 * 流式 Markdown 的 stable prefix + mutable tail 缓存。
 *
 * 目标：每帧只重渲染最后一个未确认安全的 Markdown 块，而不是从回答开头
 * 重新解析整段文本。
 *
 * 这里不尝试实现完整 Markdown AST。边界扫描器采取保守策略：
 *   - 已闭合的代码围栏可以立即冻结；
 *   - 顶层空行只有在前后都不是列表、引用、缩进代码或表格时才冻结；
 *   - 出现引用式链接定义时直接关闭冻结，保证不会改写早期链接语义。
 *
 * 因此无法确认安全的文本会留在 tail；最坏情况退化为原来的全量重渲染，
 * 正确性优先。
 */

import { visibleWidth } from "./ansi.ts";
import type { MarkdownBoundaryTracker } from "./lezer-markdown-boundary.ts";

export type MarkdownRenderer = (text: string, width: number) => string[];

export interface StreamingMarkdownCacheOptions {
  /**
   * 可选 block 边界跟踪器。
   *
   * 不传时使用内建的行级保守扫描器；传 Lezer tracker 时会按顶层 block
   * 冻结，边界更准确，也能复用增量语法树。
   */
  boundaryTracker?: MarkdownBoundaryTracker;
}

interface Fence {
  char: "`" | "~";
  length: number;
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+/;
const BLOCKQUOTE = /^\s*>\s?/;
const INDENTED_CODE = /^(?: {4,}|\t)/;
const REFERENCE_DEFINITION = /^\s*\[[^\]]+\]:\s+/m;

function openingFence(line: string): Fence | undefined {
  const match = FENCE_OPEN.exec(line);
  if (match === null) return undefined;
  const marker = match[1]!;
  return { char: marker[0] as "`" | "~", length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.trim();
  if (trimmed.length < fence.length) return false;
  for (const char of trimmed) {
    if (char !== fence.char) return false;
  }
  return true;
}

function isMathFence(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "$$" || trimmed === "\\[";
}

function isMathClose(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "$$" || trimmed === "\\]";
}

function endsWithClosedBlock(chunk: string): boolean {
  const lines = chunk.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    const trimmed = line.trim();
    return (
      /^(`{3,}|~{3,})$/.test(trimmed) ||
      trimmed === "$$" ||
      trimmed === "\\]" ||
      trimmed.includes("|") ||
      line.endsWith("  ") ||
      line.endsWith("\\")
    );
  }
  return false;
}

function stripTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && visibleWidth(lines[end - 1] ?? "") === 0) end -= 1;
  return lines.slice(0, end);
}

function endsWithHardBreak(chunk: string): boolean {
  const lines = chunk.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line.length === 0) continue;
    return line.endsWith("  ") || line.endsWith("\\");
  }
  return false;
}

function stripTrailingReset(line: string): string {
  return line.replace(/\x1b\[0m$/, "");
}

function unsafeBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.includes("|") ||
    LIST_ITEM.test(line) ||
    BLOCKQUOTE.test(line) ||
    INDENTED_CODE.test(line)
  );
}

/**
 * 找到当前文本中最后一个可以冻结的源码边界。
 *
 * 返回值一定落在换行之后，避免把尚未完成的最后一行冻进 stable prefix。
 */
export function findStableMarkdownBoundary(text: string, from: number): number {
  let cursor = Math.max(0, Math.min(from, text.length));
  let fence: Fence | undefined;
  let mathOpen = false;
  let pendingBlank: number | undefined;
  let previousNonEmpty = "";
  let candidate = cursor;

  while (cursor < text.length) {
    const newline = text.indexOf("\n", cursor);
    if (newline < 0) break;
    const line = text.slice(cursor, newline);
    const next = newline + 1;
    const trimmed = line.trim();

    if (fence !== undefined) {
      if (closesFence(line, fence)) {
        fence = undefined;
        candidate = next;
      }
      cursor = next;
      continue;
    }

    const open = openingFence(line);
    if (open !== undefined) {
      fence = open;
      pendingBlank = undefined;
      cursor = next;
      continue;
    }

    if (mathOpen) {
      if (isMathClose(line)) {
        mathOpen = false;
        candidate = next;
      }
      cursor = next;
      continue;
    }
    if (isMathFence(line)) {
      mathOpen = true;
      pendingBlank = undefined;
      cursor = next;
      continue;
    }

    // Markdown 硬换行是明确的安全边界：行尾两个空格或反斜杠会让当前行
    // 独立结束，后续文本不会回头改变这一行的排版。
    if (!unsafeBoundaryLine(line) && (line.endsWith("  ") || line.endsWith("\\"))) {
      candidate = next;
      previousNonEmpty = line;
      cursor = next;
      continue;
    }

    if (trimmed.length === 0) {
      pendingBlank = next;
      cursor = next;
      continue;
    }

    if (pendingBlank !== undefined) {
      if (!unsafeBoundaryLine(previousNonEmpty) && !unsafeBoundaryLine(line)) {
        candidate = pendingBlank;
      }
      pendingBlank = undefined;
    }
    previousNonEmpty = line;
    cursor = next;
  }

  // 文本可能停在最后一个尚未换行的半行。这个半行不能冻结，但可以用来确认
  // 前面那个空行确实是“段落分隔”，从而冻结空行之前的完整内容。
  if (pendingBlank !== undefined && text.length > 0 && text.at(-1) !== "\n") {
    const lastNewline = text.lastIndexOf("\n");
    const lastLine = text.slice(lastNewline + 1);
    if (
      lastLine.trim().length > 0 &&
      !unsafeBoundaryLine(previousNonEmpty) &&
      !unsafeBoundaryLine(lastLine)
    ) {
      candidate = pendingBlank;
    }
  }

  return candidate;
}

export class StreamingMarkdownCache {
  #render: MarkdownRenderer;
  #boundaryTracker: MarkdownBoundaryTracker | undefined;
  #width = -1;
  #sourceLength = 0;
  #prefix = "";
  #stableLength = 0;
  #stableLines: string[] = [];
  #tailSource = "";
  #tailLines: string[] = [];
  #freezeDisabled = false;

  /** 观测用：最近一次 render 的 stable/tail 源码长度。 */
  #lastStableLength = 0;
  #lastTailLength = 0;
  /** 观测用：render 调用次数，测试验证增量行为。 */
  #renderCalls = 0;

  constructor(render: MarkdownRenderer, options: StreamingMarkdownCacheOptions = {}) {
    this.#render = render;
    this.#boundaryTracker = options.boundaryTracker;
  }

  get stableChars(): number {
    return this.#lastStableLength;
  }

  get tailChars(): number {
    return this.#lastTailLength;
  }

  get renderCalls(): number {
    return this.#renderCalls;
  }

  reset(): void {
    this.#boundaryTracker?.reset();
    this.#width = -1;
    this.#sourceLength = 0;
    this.#prefix = "";
    this.#stableLength = 0;
    this.#stableLines = [];
    this.#tailSource = "";
    this.#tailLines = [];
    this.#freezeDisabled = false;
    this.#lastStableLength = 0;
    this.#lastTailLength = 0;
    this.#renderCalls = 0;
  }

  render(text: string, width: number): string[] {
    const prefix = text.slice(0, 32);
    // 只有双方都达到固定探测长度后才比较前缀；短文本在流式增长过程中，
    // prefix 本身会随长度变化，不能据此误判成“内容被替换”。
    const prefixChanged =
      this.#prefix.length === 32 && text.length >= 32 && prefix !== this.#prefix;
    if (
      width !== this.#width ||
      text.length < this.#sourceLength ||
      prefixChanged
    ) {
      this.reset();
    }

    this.#width = width;
    this.#sourceLength = text.length;
    this.#prefix = prefix;

    if (!this.#freezeDisabled && REFERENCE_DEFINITION.test(text.slice(this.#stableLength))) {
      this.#freezeDisabled = true;
    }

    if (!this.#freezeDisabled) {
      const tracked = this.#boundaryTracker?.findBoundary(text);
      const boundary =
        tracked === undefined
          ? findStableMarkdownBoundary(text, this.#stableLength)
          : Math.max(this.#stableLength, Math.min(text.length, tracked));
      if (boundary > this.#stableLength) {
        const stableChunk = text.slice(this.#stableLength, boundary);
        const rendered = this.#render(stableChunk, width);
        const normalized = endsWithClosedBlock(stableChunk)
          ? stripTrailingBlankLines(rendered)
          : rendered;
        if (endsWithHardBreak(stableChunk) && normalized.length > 0) {
          const last = normalized.length - 1;
          normalized[last] = stripTrailingReset(normalized[last]!);
        }
        this.#stableLines.push(...normalized);
        this.#stableLength = boundary;
        this.#renderCalls += 1;
      }
    }

    const tailSource = text.slice(this.#stableLength);
    if (tailSource !== this.#tailSource) {
      this.#tailSource = tailSource;
      this.#tailLines = this.#render(tailSource, width);
      this.#renderCalls += 1;
    }

    this.#lastStableLength = this.#stableLength;
    this.#lastTailLength = this.#tailSource.length;
    const combined = [...this.#stableLines, ...this.#tailLines];
    // stable 与 tail 分开渲染时，段落边界可能各产生一个空行。这里只消掉
    // 边界处重复的一个空行；正文中的空行语义不受影响。
    if (
      this.#stableLines.length > 0 &&
      this.#tailLines.length > 0 &&
      visibleWidth(this.#stableLines.at(-1) ?? "") === 0 &&
      visibleWidth(this.#tailLines[0] ?? "") === 0
    ) {
      combined.splice(this.#stableLines.length, 1);
    }
    return combined;
  }
}
