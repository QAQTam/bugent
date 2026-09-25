import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/tui/markdown.ts";
import { LezerMarkdownBoundaryTracker } from "../src/tui/lezer-markdown-boundary.ts";
import {
  findStableMarkdownBoundary,
  StreamingMarkdownCache,
} from "../src/tui/streaming-markdown.ts";

describe("StreamingMarkdownCache", () => {
  test("顶层段落边界会被冻结，后续只重渲染 tail", () => {
    let calls = 0;
    const cache = new StreamingMarkdownCache((text) => {
      calls += 1;
      return text.split("\n");
    });

    const first = cache.render("first\n\nsecond", 40);
    expect(first.join("\n")).toContain("first");
    expect(cache.stableChars).toBe(7); // "first\n\n"
    expect(cache.tailChars).toBe("second".length);
    const callsAfterFirst = calls;

    cache.render("first\n\nsecond continued", 40);
    expect(cache.stableChars).toBe(7);
    expect(calls).toBe(callsAfterFirst + 1);
  });

  test("已闭合代码围栏可以冻结，未闭合期间不冻结", () => {
    expect(findStableMarkdownBoundary("```ts\nconst x = 1;\n```\nnext", 0)).toBe(23);
    expect(findStableMarkdownBoundary("```ts\nconst x = 1;\n", 0)).toBe(0);
  });

  test("Markdown 硬换行可以冻结，软换行不可以", () => {
    expect(findStableMarkdownBoundary("hello  \nworld", 0)).toBe(8);
    expect(findStableMarkdownBoundary("hello\\\nworld", 0)).toBe(7);
    expect(findStableMarkdownBoundary("hello\nworld", 0)).toBe(0);
  });

  test("列表和引用后的空行不会被误判为顶层边界", () => {
    expect(findStableMarkdownBoundary("- item\n\nnext", 0)).toBe(0);
    expect(findStableMarkdownBoundary("> quote\n\nnext", 0)).toBe(0);
  });

  test("引用式链接定义出现后关闭冻结", () => {
    let calls = 0;
    const cache = new StreamingMarkdownCache((text) => {
      calls += 1;
      return text.split("\n");
    });
    const text = "paragraph\n\n[id]: https://example.com\n\nnext";
    cache.render(text, 40);
    expect(cache.stableChars).toBe(0);
    expect(calls).toBe(1);
  });

  test("硬换行 soft freeze 与全量输出一致", () => {
    const cache = new StreamingMarkdownCache((text, width) => renderMarkdown(text, width));
    const width = 48;
    let text = "第一行  ";
    for (const delta of ["\n第二行  ", "\n第三行"]) {
      text += delta;
      expect(cache.render(text, width)).toEqual(renderMarkdown(text, width));
    }
  });

  test("Lezer block 边界下仍与全量 renderMarkdown 输出一致", () => {
    const cache = new StreamingMarkdownCache(
      (text, width) => renderMarkdown(text, width),
      { boundaryTracker: new LezerMarkdownBoundaryTracker() },
    );
    const width = 48;
    let text = "# 标题";
    for (const delta of [
      "\n\n第一段",
      "继续写。",
      "\n\n```bash\necho hi\n```",
      "\n\n| a | b |\n|---|---|\n| 1 | 2 |",
      "\n\n结尾。",
    ]) {
      text += delta;
      expect(cache.render(text, width)).toEqual(renderMarkdown(text, width));
    }
  });

  test("与全量 renderMarkdown 输出保持一致", () => {
    const cache = new StreamingMarkdownCache((text, width) => renderMarkdown(text, width));
    const width = 48;
    let text = "# 标题\n\n第一段";
    for (const delta of [
      "继续写第一段。",
      "\n\n第二段开始。",
      "\n\n```ts\nconst x = 1;\n```\n\n第三段。",
    ]) {
      text += delta;
      expect(cache.render(text, width)).toEqual(renderMarkdown(text, width));
    }
  });
});
