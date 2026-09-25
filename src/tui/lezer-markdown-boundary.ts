/**
 * Lezer 增量 Markdown block 边界跟踪器。
 *
 * 只负责回答一个问题：当前文本里，哪些顶层 block 已经稳定到可以冻结？
 * 不负责渲染、不替换 Bun.markdown.ansi，也不参与代码/表格样式。
 *
 * 设计取舍：
 *   - 始终把最后一个顶层 block 留作 mutable tail，因为流式输入可能改变它；
 *   - 前面的顶层 block 用 from/to 表示，交给现有 stable/tail cache；
 *   - 出现 LinkReference 时禁用冻结，因为 Lezer 为增量解析不校验引用定义。
 */

import { TreeFragment, type Tree } from "@lezer/common";
import { markdownParser } from "./markdown-ast.ts";

export interface MarkdownBoundaryTracker {
  findBoundary(text: string): number;
  reset(): void;
}

export class LezerMarkdownBoundaryTracker implements MarkdownBoundaryTracker {
  #parser = markdownParser;
  #tree: Tree | undefined;
  #text = "";
  #boundary = 0;
  #hasLinkReference = false;

  reset(): void {
    this.#tree = undefined;
    this.#text = "";
    this.#boundary = 0;
    this.#hasLinkReference = false;
  }

  findBoundary(text: string): number {
    if (text === this.#text) return this.#boundary;
    if (text.length < this.#text.length) this.reset();

    if (this.#tree === undefined) {
      this.#tree = this.#parser.parse(text);
      this.#hasLinkReference = this.#containsLinkReference(this.#tree);
    } else {
      const fragments = TreeFragment.addTree(this.#tree);
      this.#tree = this.#parser.parse(text, fragments);
      if (this.#tree.topNode.lastChild?.name === "LinkReference") {
        this.#hasLinkReference = true;
      }
    }

    this.#text = text;
    if (this.#hasLinkReference) {
      this.#boundary = 0;
      return this.#boundary;
    }

    // 最后一个顶层 block 始终可变；冻结到它的起点，把两个 block 之间的
    // 空行也纳入 stable 前缀，保证 stable/tail 分开渲染时不会多插空行。
    const last = this.#tree.topNode.lastChild;
    const previous = last?.prevSibling;
    this.#boundary = previous === undefined || last === null ? 0 : last.from;
    return this.#boundary;
  }

  #containsLinkReference(tree: Tree): boolean {
    let child = tree.topNode.firstChild;
    while (child !== null) {
      if (child.name === "LinkReference") return true;
      child = child.nextSibling;
    }
    return false;
  }
}
