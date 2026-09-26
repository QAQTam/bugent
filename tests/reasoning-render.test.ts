import { describe, expect, test } from "bun:test";
import { formatReasoningDuration, renderReasoningItem } from "../src/tui/render-reasoning.ts";
import type { DisplayItem } from "../src/tui/transcript.ts";

type ReasoningItem = Extract<DisplayItem, { kind: "reasoning" }>;

function item(overrides: Partial<ReasoningItem> = {}): ReasoningItem {
  return {
    kind: "reasoning",
    id: "reasoning-1",
    text: "完整思考内容",
    done: false,
    expanded: false,
    ...overrides,
  };
}

describe("Reasoning 渲染", () => {
  test("live 只占一行，不渲染完整正文", () => {
    const lines = renderReasoningItem(item(), 80);
    expect(lines).toHaveLength(1);
    expect(Bun.stripANSI(lines[0]!)).toBe("✻ Thinking…");
    expect(Bun.stripANSI(lines.join("\n"))).not.toContain("完整思考内容");
  });

  test("完成态默认折叠，显示 Thought、耗时和点击引导", () => {
    const lines = renderReasoningItem(
      item({ done: true, durationMs: 12_400, tokens: 1842, sequence: 1 }),
      80,
    );
    expect(lines).toHaveLength(1);
    const plain = Bun.stripANSI(lines[0]!);
    expect(plain).toContain("✦ Thought 1");
    expect(plain).toContain("12.4s");
    expect(plain).toContain("1.8k tok");
    expect(plain).toContain("（点击展开）");
    expect(plain).not.toContain("完整思考内容");
  });

  test("只有 expanded=true 才渲染完整 Markdown 正文", () => {
    const lines = renderReasoningItem(
      item({ done: true, expanded: true, durationMs: 1000, sequence: 1 }),
      80,
    );
    const plain = Bun.stripANSI(lines.join("\n"));
    expect(plain).toContain("− Thought 1");
    expect(plain).toContain("（点击折叠）");
    expect(plain).toContain("完整思考内容");
    expect(lines.length).toBeGreaterThan(1);
  });

  test("恢复会话没有 duration 时不伪造耗时", () => {
    const plain = Bun.stripANSI(
      renderReasoningItem(item({ done: true, sequence: 2 }), 80)[0]!,
    );
    expect(plain).toContain("✦ Thought 2");
    expect(plain).not.toContain("undefined");
    expect(plain).not.toContain("ms");
  });

  test("耗时格式覆盖毫秒、秒和分钟", () => {
    expect(formatReasoningDuration(420)).toBe("420ms");
    expect(formatReasoningDuration(12_400)).toBe("12.4s");
    expect(formatReasoningDuration(62_000)).toBe("1m 02s");
  });
});
