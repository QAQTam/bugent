/**
 * 长回答保护。
 *
 * 正文视口是**钉底**的（`scrollOffset = 0` 看最新内容），所以内容一溢出，
 * 被切掉的永远是顶部 —— 也就是长回答的前半段。
 *
 * 直觉上"折叠更早的工具卡片给作答腾地方"是对的，但它**数学上是恒等变换**：
 * 窗口显示 [T-H, T)，作答占 [s, e]，完整可见的判据是 `s >= T-H`；把上方内容
 * 折叠掉 k 行后 s' = s-k、T' = T-k，判据变成 `s-k >= (T-k)-H` ⟺ `s >= T-H`
 * —— 一模一样。所以这里没有任何折叠策略，只有把视口挪到作答开头的
 * `assistantAnchorOffset`。
 *
 * 下面第一个 describe 就是把这个结论钉住，防止后人再"顺手优化"回去。
 */

import { describe, expect, test } from "bun:test";
import {
  assistantAnchorOffset,
  lastAssistantIndex,
  toFoldableBlocks,
  type FoldableBlock,
} from "../src/tui/transcript-layout.ts";

/**
 * 把 block 按顺序铺成行空间。
 *
 * `height` 是内容行数；block 之间加一行分隔，与 `TranscriptLayout.update` 一致。
 */
function layout(spec: Array<{ kind: string; height: number }>): {
  blocks: FoldableBlock[];
  totalLines: number;
} {
  const blocks: FoldableBlock[] = [];
  let cursor = 0;
  for (const entry of spec) {
    const contentEnd = cursor + entry.height - 1;
    blocks.push({ kind: entry.kind, start: cursor, contentEnd });
    cursor += entry.height + 1;
  }
  return { blocks, totalLines: cursor };
}

const tool = (height: number) => ({ kind: "tool", height });
const assistant = (height: number) => ({ kind: "assistant", height });
const user = (height: number) => ({ kind: "user", height });

/** 钉底窗口 [T-H, T) 里，作答是否完整可见。 */
function fullyVisible(blocks: FoldableBlock[], totalLines: number, viewportHeight: number): boolean {
  const index = lastAssistantIndex(blocks);
  if (index === undefined) return true;
  return blocks[index]!.start >= totalLines - viewportHeight;
}

/**
 * 模拟"把某些 block 折叠成一行"之后重排。
 *
 * 必须重算后续 block 的起点 —— 只改 contentEnd 而不动 start 是错的，
 * 那样模拟出来的根本不是折叠后的布局。
 */
function relayout(
  spec: Array<{ kind: string; height: number }>,
  folded: ReadonlySet<number>,
): { blocks: FoldableBlock[]; totalLines: number } {
  const blocks: FoldableBlock[] = [];
  let cursor = 0;
  for (let index = 0; index < spec.length; index += 1) {
    const entry = spec[index]!;
    const height = folded.has(index) ? 1 : entry.height;
    blocks.push({ kind: entry.kind, start: cursor, contentEnd: cursor + height - 1 });
    cursor += height + 1;
  }
  return { blocks, totalLines: cursor };
}

describe("为什么不做折叠（结论钉死）", () => {
  test("折叠作答上方的任何内容，都不改变作答是否完整可见", () => {
    const viewportHeight = 8;
    const spec = [tool(6), tool(6), tool(6), assistant(20)];

    const before = relayout(spec, new Set());
    const after = relayout(spec, new Set([0, 1, 2])); // 三张卡片全折成一行

    expect(fullyVisible(before.blocks, before.totalLines, viewportHeight)).toBe(false);
    expect(fullyVisible(after.blocks, after.totalLines, viewportHeight)).toBe(false);
  });

  test("决定成败的只有一件事：作答自己的行数 vs 视口高度", () => {
    const viewportHeight = 10;
    for (const answerHeight of [4, 8, 9, 10, 11, 40]) {
      // 上方内容多寡不影响结论
      for (const prefix of [tool(3), tool(30)]) {
        const { blocks, totalLines } = layout([prefix, assistant(answerHeight)]);
        // 作答后面还跟一行分隔，所以完整可见要 answerHeight + 1 <= 视口高度
        expect(fullyVisible(blocks, totalLines, viewportHeight)).toBe(
          answerHeight + 1 <= viewportHeight,
        );
      }
    }
  });

  test("折叠上方内容对长会话同样无效", () => {
    const viewportHeight = 12;
    const spec = [user(2), assistant(4), tool(9), user(2), tool(9), tool(9), assistant(30)];
    const before = relayout(spec, new Set());
    const after = relayout(spec, new Set([2, 4, 5]));
    expect(fullyVisible(before.blocks, before.totalLines, viewportHeight)).toBe(false);
    expect(fullyVisible(after.blocks, after.totalLines, viewportHeight)).toBe(false);
  });
});

describe("lastAssistantIndex", () => {
  test("取最后一条 assistant", () => {
    const { blocks } = layout([user(1), assistant(3), tool(5), assistant(2)]);
    expect(lastAssistantIndex(blocks)).toBe(3);
  });

  test("没有 assistant 时返回 undefined", () => {
    expect(lastAssistantIndex(layout([user(1), tool(5)]).blocks)).toBeUndefined();
  });
});

describe("assistantAnchorOffset", () => {
  test("用户自己滚上去看历史时不动视口", () => {
    const { blocks, totalLines } = layout([tool(4), assistant(30)]);
    expect(assistantAnchorOffset(blocks, totalLines, 10, 5)).toBe(0);
  });

  test("作答完整可见时不动", () => {
    const { blocks, totalLines } = layout([tool(4), assistant(3)]);
    expect(assistantAnchorOffset(blocks, totalLines, 20, 0)).toBe(0);
  });

  test("作答被切掉时，把它的开头钉到视口顶部", () => {
    const { blocks, totalLines } = layout([tool(4), assistant(30)]);
    const offset = assistantAnchorOffset(blocks, totalLines, 10, 0);

    // 用这个偏移取窗口，起点应当正好落在作答开头
    expect(totalLines - offset - 10).toBe(blocks[1]!.start);
  });

  test("作答正好占满视口时也钉位（首行会被切，仍要挪）", () => {
    const { blocks, totalLines } = layout([assistant(10)]);
    // 作答 10 行、视口 10 行，但末尾还有分隔行，所以起点仍差 1 行
    expect(assistantAnchorOffset(blocks, totalLines, 10, 0)).toBeGreaterThan(0);
  });

  test("偏移不为负", () => {
    const { blocks, totalLines } = layout([assistant(30)]);
    expect(assistantAnchorOffset(blocks, totalLines, 10, 0)).toBeGreaterThanOrEqual(0);
  });

  test("没有 assistant 时不动", () => {
    const { blocks, totalLines } = layout([user(3), tool(20)]);
    expect(assistantAnchorOffset(blocks, totalLines, 5, 0)).toBe(0);
  });

  test("长会话里同样成立：多轮历史 + 一条长作答", () => {
    const { blocks, totalLines } = layout([
      user(2), assistant(4), tool(6), user(2), assistant(6), tool(8),
      user(2), assistant(40),
    ]);
    const offset = assistantAnchorOffset(blocks, totalLines, 12, 0);
    expect(totalLines - offset - 12).toBe(blocks[7]!.start);
  });
});

describe("toFoldableBlocks", () => {
  test("从布局 block 投影出决策需要的字段", () => {
    const projected = toFoldableBlocks([
      { item: { kind: "user" }, start: 0, contentEnd: 0 },
      { item: { kind: "tool" }, start: 2, contentEnd: 5 },
      { item: { kind: "assistant" }, start: 7, contentEnd: 12 },
    ]);
    expect(projected).toEqual([
      { kind: "user", start: 0, contentEnd: 0 },
      { kind: "tool", start: 2, contentEnd: 5 },
      { kind: "assistant", start: 7, contentEnd: 12 },
    ]);
  });
});
