/**
 * tokenizer 计数测试。
 *
 * 两组用例：
 *   1. **合成词表**：不依赖任何外部文件，验证 byte-level + BPE 合并顺序 + 预切分
 *      这几段机械逻辑本身对不对。
 *   2. **DeepSeek 真词表**：期望值由 HuggingFace `tokenizers` 的参考实现产出
 *      （见文件末尾注释里的复现命令）。没跑过 `bun run tokenizer:fetch` 的机器上
 *      自动跳过 —— 计数只是状态栏读数，缺文件不该让测试红。
 */

import { describe, expect, test } from "bun:test";
import {
  DeepSeekBpeCounter,
  estimateTokens,
  EXPECTED_PATTERN_SOURCE,
  HeuristicCounter,
  loadTokenizer,
  parseDeepSeekTokenizer,
  resolveTokenizerPath,
} from "../src/util/tokenizer.ts";

/** 用真词表的 pre_tokenizer 布局 + 一张玩具词表，验证机械逻辑。 */
function syntheticTokenizer(vocab: Record<string, number>, merges: string[]): unknown {
  return {
    model: { type: "BPE", byte_fallback: true, vocab, merges },
    pre_tokenizer: {
      type: "Sequence",
      pretokenizers: [
        {
          type: "Split",
          pattern: { Regex: EXPECTED_PATTERN_SOURCE[0] },
          behavior: "Isolated",
          invert: false,
        },
        {
          type: "Split",
          pattern: { Regex: EXPECTED_PATTERN_SOURCE[1] },
          behavior: "Isolated",
          invert: false,
        },
        {
          type: "Split",
          pattern: { Regex: EXPECTED_PATTERN_SOURCE[2] },
          behavior: "Isolated",
          invert: false,
        },
        { type: "ByteLevel", add_prefix_space: false, trim_offsets: true, use_regex: false },
      ],
    },
  };
}

describe("DeepSeek BPE 计数", () => {
  test("按 merges 的 rank 合并到词表里的整词", () => {
    const counter = new DeepSeekBpeCounter({
      merges: ["h e", "l l", "ll o", "he llo"],
      vocab: ["h", "e", "l", "o", "he", "ll", "llo", "hello"],
    });
    expect(counter.count("hello")).toBe(1);
  });

  test("词表里没有的片段按字节回退成单字节 token", () => {
    // 玩具词表里只有这几个字符，其它一律回退成逐字节计数。
    const counter = new DeepSeekBpeCounter({
      merges: ["h e"],
      vocab: ["h", "e", "he"],
    });
    expect(counter.count("he")).toBe(1);
    expect(counter.count("xyz")).toBe(3);
  });

  test("预切分：数字按 1~3 位切开（而不是整串当一个词）", () => {
    // 词表里正好有 "123" / "456" / "789" 这三个整块，于是 token 数直接反映切法：
    // 整串当一个词的话 "1234" 会切不出 "123"。
    const counter = new DeepSeekBpeCounter({
      merges: ["1 2", "12 3", "4 5", "45 6", "7 8", "78 9"],
      vocab: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "123", "456", "789"],
    });
    // 1234 → 123 / 4 两片
    expect(counter.count("1234")).toBe(2);
    // 1234567890 → 123 / 456 / 789 / 0 四片
    expect(counter.count("1234567890")).toBe(4);
  });

  test("结构对不上时抛错，绝不静默算错", () => {
    expect(() => parseDeepSeekTokenizer({ model: { type: "BPE", merges: [] } })).toThrow();
    expect(() =>
      parseDeepSeekTokenizer({
        model: { type: "WordPiece", merges: [], vocab: {} },
        pre_tokenizer: { type: "Sequence", pretokenizers: [] },
      }),
    ).toThrow();
    // 三段 Split 的第三段被换掉 → 不认
    const tampered = syntheticTokenizer({ a: 0 }, []) as {
      pre_tokenizer: { pretokenizers: { pattern?: { Regex?: string } }[] };
    };
    tampered.pre_tokenizer.pretokenizers[2]!.pattern = { Regex: "[a-z]+" };
    expect(() => parseDeepSeekTokenizer(tampered)).toThrow(/Split/);
  });
});

describe("启发式估算（没有 tokenizer 文件时的兜底）", () => {
  test("CJK 比等长 ASCII 更贵，且量级正确", () => {
    const counter = new HeuristicCounter();
    expect(counter.kind).toBe("heuristic");
    const chinese = counter.count("这是一个测试句子。");
    const english = counter.count("The quick brown fox jumps.");
    // 真值分别是 4 / 6 token；估算允许有偏差，但不能差一个数量级
    expect(chinese).toBeGreaterThan(2);
    expect(chinese).toBeLessThan(8);
    expect(english).toBeGreaterThan(3);
    expect(english).toBeLessThan(12);
  });

  test("空串是 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

const tokenizerPath = resolveTokenizerPath();

describe.skipIf(tokenizerPath === undefined)("DeepSeek 真词表对照", () => {
  // 期望值来自 HuggingFace `tokenizers` 参考实现：
  //   pip install tokenizers
  //   python -c "from tokenizers import Tokenizer; t=Tokenizer.from_file('tokenizer.json');
  //              print(len(t.encode('你好，世界').ids))"
  const cases: readonly (readonly [string, number])[] = [
    ["", 0],
    ["hello world", 2],
    ["Hello, world!", 4],
    ["你好，世界", 3],
    ["这是一个测试句子。", 4],
    ["function add(a, b) { return a + b; }", 13],
    ["const x = 1;\nconst y = 2;\n", 12],
    ["  +  ", 3],
    ["def fib(n):\n    return n if n < 2 else fib(n-1) + fib(n-2)", 24],
    ["The quick brown fox jumps over the lazy dog.", 10],
    ["emoji 🎉 test", 6],
    ["1234567890", 4],
    ["中文English混合mixed 123", 6],
    ['{"path":"src/tui/app.ts","limit":500}', 13],
    ["   ", 1],
    ["\n\n", 1],
  ];

  test("与参考实现逐个用例一致", () => {
    const counter = loadTokenizer(tokenizerPath!);
    expect(counter.kind).toBe("deepseek-bpe");
    for (const [text, expected] of cases) {
      expect([text, counter.count(text)]).toEqual([text, expected]);
    }
  });
});
