import { describe, expect, test } from "bun:test";
import { maxScrollOffset, reachableLines, TranscriptLayout } from "../src/tui/transcript-layout.ts";

interface Item {
  id: string;
  text: string;
  version: number;
}

function renderItem(item: Item): string[] {
  return item.text.split("\n");
}

describe("TranscriptLayout", () => {
  test("未变化的 block 复用缓存，只重渲染变化项", () => {
    const layout = new TranscriptLayout<Item>();
    const items: Item[] = [
      { id: "a", text: "a1\na2", version: 0 },
      { id: "b", text: "b1", version: 0 },
    ];
    const calls = new Map<string, number>();
    const render = (item: Item): string[] => {
      calls.set(item.id, (calls.get(item.id) ?? 0) + 1);
      return renderItem(item);
    };

    layout.update(items, 20, (item) => item.version, render, { globalVersion: 1 });
    layout.update(items, 20, (item) => item.version, render, { globalVersion: 1 });
    expect(calls).toEqual(new Map([["a", 1], ["b", 1]]));

    items[1]!.text = "b2\nb3";
    items[1]!.version += 1;
    layout.update(items, 20, (item) => item.version, render, { globalVersion: 2 });

    expect(calls).toEqual(new Map([["a", 1], ["b", 2]]));
    expect(layout.totalLines).toBe(6); // a 两行 + 空行 + b 两行 + 空行

    // 全局 revision 变了，但没有 item 内容变化：仍然复用每个 block 的缓存。
    layout.update(items, 20, (item) => item.version, render, { globalVersion: 3 });
    expect(calls).toEqual(new Map([["a", 1], ["b", 2]]));
  });

  test("窗口钉底、回看和吸顶", () => {
    const layout = new TranscriptLayout<Item>();
    const items: Item[] = [
      { id: "a", text: "a1\na2", version: 0 },
      { id: "b", text: "b1", version: 0 },
    ];
    layout.update(items, 20, (item) => item.version, renderItem);

    expect(layout.window(2, 0).lines).toEqual(["b1", ""]);
    expect(layout.window(2, 1).lines).toEqual(["", "b1"]);

    const sticky = layout.window(2, 2);
    expect(sticky.start).toBe(1);
    expect(sticky.lines[0]).toBe("a1"); // 窗口落在 a 内部，头部吸顶
  });

  test("callId 只暴露在工具 block 上，contentEnd 不含分隔空行", () => {
    const layout = new TranscriptLayout<Item>();
    const items: Item[] = [{ id: "tool", text: "header\nbody", version: 0 }];
    layout.update(items, 20, (item) => item.version, renderItem, {
      callIdOf: (item) => item.id,
    });

    expect(layout.blocks[0]?.start).toBe(0);
    expect(layout.blocks[0]?.contentEnd).toBe(1);
    expect(layout.blocks[0]?.end).toBe(3);
    expect(layout.blocks[0]?.callId).toBe("tool");
  });

  test("globalVersion 与 items 引用未变时直接复用 block 索引", () => {
    const layout = new TranscriptLayout<Item>();
    const items: Item[] = [{ id: "a", text: "a", version: 0 }];
    let calls = 0;
    const render = (item: Item): string[] => {
      calls += 1;
      return renderItem(item);
    };

    layout.update(items, 20, (item) => item.version, render, { globalVersion: 1 });
    const blocks = layout.blocks;
    layout.update(items, 20, (item) => item.version, render, { globalVersion: 1 });

    expect(calls).toBe(1);
    expect(layout.blocks).toBe(blocks);
  });
});

describe("历史窗口上限", () => {
  test("窗口取「三屏」与「绝对下限」的较大者", () => {
    // 10 行正文：三屏 30 < 下限 100，所以窗口是 100 行 → 回看 90
    expect(maxScrollOffset(200, 10)).toBe(90);
    // 53 行正文：三屏 159 > 下限 100，按三屏走 → 回看 106
    expect(maxScrollOffset(400, 53)).toBe(106);
  });

  test("内容不超过窗口时能一路滚到顶", () => {
    expect(maxScrollOffset(100, 10)).toBe(90);
    expect(maxScrollOffset(20, 10)).toBe(10);
    expect(maxScrollOffset(5, 10)).toBe(0);
    expect(maxScrollOffset(100, 0)).toBe(0);
  });

  test("短终端不再退化成十几行 —— 至少能回看 100 行内容", () => {
    // 12 行终端正文只有 5 行，老实现三屏 = 15 行，69 行内容里 54 行够不着
    expect(reachableLines(200, 5)).toBe(100);
    expect(reachableLines(69, 5)).toBe(69); // 内容本身就不到 100 行 → 全够得着
  });

  test("reachableLines 不会超过总行数", () => {
    expect(reachableLines(5, 10)).toBe(5);
    expect(reachableLines(0, 10)).toBe(0);
  });
});
