import { describe, expect, test } from "bun:test";
import {
  parseMarkdownTree,
  readClosedFencedCode,
  readTableModel,
} from "../src/tui/markdown-ast.ts";

describe("markdown AST", () => {
  test("GFM 表格由 Lezer 识别", () => {
    const tree = parseMarkdownTree("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(tree.topNode.firstChild?.name).toBe("Table");
  });

  test("表格模型保留表头、对齐和转义单元格", () => {
    const source = [
      "| left | center | right |",
      "|:---|:---:|---:|",
      "| a\\|b | **c** | `d` |",
    ].join("\n");
    const node = parseMarkdownTree(source).topNode.firstChild;
    expect(readTableModel(node!, source)).toEqual({
      alignments: ["left", "center", "right"],
      rows: [
        { header: true, cells: ["left", "center", "right"] },
        { header: false, cells: ["a\\|b", "**c**", "`d`"] },
      ],
    });
  });

  test("未闭合围栏不会当成完整代码块", () => {
    const source = "```bash\necho hi";
    const node = parseMarkdownTree(source).topNode.firstChild;
    expect(node?.name).toBe("FencedCode");
    expect(readClosedFencedCode(node!, source)).toBeUndefined();
  });

  test("读取代码语言、正文与 CRLF 行尾", () => {
    const source = "```bash title=demo\r\necho hi\r\n```";
    const node = parseMarkdownTree(source).topNode.firstChild;
    expect(readClosedFencedCode(node!, source)).toEqual({
      language: "bash",
      code: "echo hi",
    });
  });
});
