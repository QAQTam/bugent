import { describe, expect, test } from "bun:test";
import {
  clearMarkdownRenderCaches,
  getMarkdownCacheStats,
  renderMarkdown,
  resetMarkdownCacheStats,
  splitMarkdown,
} from "../src/tui/markdown.ts";

describe("Markdown 表格渲染", () => {
  test("每个物理行都保留竖线，不因超宽丢边框", () => {
    const text = [
      "| 项目名称 | 非常长的状态描述 | 备注 |",
      "|---|---|---|",
      "| 一个很长的中文项目名称 | 正在执行一个非常长的状态说明 | 一些备注 |",
      "| 另一个项目 | 完成 | ok |",
    ].join("\n");

    const lines = renderMarkdown(text, 30);
    const plain = lines.map((line) => Bun.stripANSI(line));
    expect(plain.filter((line) => line.includes("│")).length).toBeGreaterThanOrEqual(8);
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(30);
  });

  test("窄到放不下表格框时退回原始表格行，不丢列分隔", () => {
    const text = "| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |";
    const lines = renderMarkdown(text, 8).map((line) => Bun.stripANSI(line));
    expect(lines.some((line) => line.includes("|"))).toBe(true);
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(8);
  });

  test("表格会被切成独立 segment，不混进普通 prose", () => {
    const segments = splitMarkdown("intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nend");
    expect(segments.map((segment) => segment.kind)).toEqual([
      "prose",
      "table",
      "prose",
    ]);
  });

  test("表格单元格的行内渲染缓存不会串掉超链接开关", () => {
    const source = "| [docs](https://example.com) |\n|---|\n| plain |";

    const linked = renderMarkdown(source, 80, { hyperlinks: true }).join("\n");
    expect(linked).toContain("\x1b]8;;https://example.com");

    const plain = renderMarkdown(source, 80, { hyperlinks: false }).join("\n");
    expect(plain).not.toContain("\x1b]8;;");
  });

  test("千行表格追加一行只重排新行且结果与全量一致", () => {
    const width = 120;
    const body = Array.from(
      { length: 1000 },
      (_, index) =>
        `| row-${String(index).padStart(4, "0")} | value-${String(index).padStart(4, "0")} | ${index % 2} |`,
    );
    const source = ["| name | value | flag |", "|---|---|---|", ...body].join("\n");
    const appended = `${source}\n| row-1000 | value-1000 | 0 |`;

    clearMarkdownRenderCaches();
    const expected = renderMarkdown(appended, width);

    clearMarkdownRenderCaches();
    renderMarkdown(source, width);
    resetMarkdownCacheStats();
    const actual = renderMarkdown(appended, width);
    const stats = getMarkdownCacheStats();

    expect(actual).toEqual(expected);
    expect(stats.tableStateHits).toBe(1);
    expect(stats.tableRowRenders).toBe(1);
    expect(stats.tableRowReuses).toBe(1001);
  });

  test("新行改变列宽时整表重排，避免复用旧边框", () => {
    const width = 120;
    const source = "| a | b |\n|---|---|\n| 1 | 2 |";
    const wider = `${source}\n| much-wider-value | 3 |`;

    clearMarkdownRenderCaches();
    const expected = renderMarkdown(wider, width);

    clearMarkdownRenderCaches();
    renderMarkdown(source, width);
    resetMarkdownCacheStats();
    const actual = renderMarkdown(wider, width);
    const stats = getMarkdownCacheStats();

    expect(actual).toEqual(expected);
    expect(stats.tableStateHits).toBe(1);
    expect(stats.tableRowReuses).toBe(0);
    expect(stats.tableRowRenders).toBe(3);
  });

  test("GFM 允许的单横线 delimiter 也由 Lezer 识别", () => {
    const segments = splitMarkdown("| a | b |\n|-|-|\n| 1 | 2 |");
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: "table",
      lines: ["| a | b |", "|-|-|", "| 1 | 2 |"],
      model: {
        alignments: ["left", "left"],
        rows: [
          { header: true, cells: ["a", "b"] },
          { header: false, cells: ["1", "2"] },
        ],
      },
    });
  });
});
