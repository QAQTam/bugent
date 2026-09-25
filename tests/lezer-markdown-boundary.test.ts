import { describe, expect, test } from "bun:test";
import { LezerMarkdownBoundaryTracker } from "../src/tui/lezer-markdown-boundary.ts";

describe("LezerMarkdownBoundaryTracker", () => {
  test("只冻结最后一个顶层 block 之前的 block", () => {
    const tracker = new LezerMarkdownBoundaryTracker();
    expect(tracker.findBoundary("# A")).toBe(0);
    expect(tracker.findBoundary("# A\n\n# B")).toBe(5);
    expect(tracker.findBoundary("# A\n\n# B\n\nparagraph")).toBe(10);
  });

  test("未闭合代码围栏不冻结，闭合且出现后续 block 后冻结", () => {
    const tracker = new LezerMarkdownBoundaryTracker();
    expect(tracker.findBoundary("```bash\necho hi")).toBe(0);
    const closed = "```bash\necho hi\n```";
    expect(tracker.findBoundary(closed)).toBe(0);
    const next = `${closed}\n\nnext`;
    expect(tracker.findBoundary(next)).toBe(closed.length + 2);
  });

  test("表格作为最后一个 block 时留在 tail，后面出现 block 后才冻结", () => {
    const tracker = new LezerMarkdownBoundaryTracker();
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    expect(tracker.findBoundary(table)).toBe(0);
    expect(tracker.findBoundary(`${table}\n\nnext`)).toBe(table.length + 2);
  });

  test("LinkReference 出现后禁用冻结", () => {
    const tracker = new LezerMarkdownBoundaryTracker();
    tracker.findBoundary("[ref]: https://example.com");
    expect(tracker.findBoundary("[ref]: https://example.com\n\nSee [ref].")).toBe(0);
  });
});
