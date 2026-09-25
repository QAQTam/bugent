/**
 * Token 计数 —— 只做「数 token」，不做 encode / decode。
 *
 * 为什么需要它：TUI 要显示**瞬时输出速度**（tok/s），而服务端只在一次请求
 * 结束时回传 usage。流式过程中"这一刻吐了多少 token"只能自己量，于是要么
 * 拿一个真 tokenizer，要么用启发式估算。
 *
 * 这里实现的是 **DeepSeek 系 tokenizer**（`deepseek-ai/DeepSeek-V3` 的
 * tokenizer.json，可从 ModelScope 取，见 `scripts/fetch-tokenizer.ts`）：
 *   - 三段 Split 预切分（数字 1~3 位一组、CJK 连续段、GPT-2 风格词边界）
 *   - ByteLevel（字节 → unicode 字符）
 *   - 字节级 BPE（`merges` 里的 rank 决定合并顺序）
 *
 * 刻意不依赖任何 tokenizer 库：我们只要一个数字，为此拖进 wasm / 原生绑定
 * 不划算。代价是**只支持验证过的结构** —— 加载时结构对不上就直接抛错，
 * 由调用方退回启发式估算，绝不静默算错。
 *
 * 拿不到 tokenizer 文件时用 `HeuristicCounter`：按 CJK / 其它字符分别加权，
 * 再由上层用服务端 usage 做**自校准**（见 `src/tui/metrics.ts`）。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TokenCounter {
  /** 计数来源，用于诊断与测试。 */
  readonly kind: "deepseek-bpe" | "heuristic";
  /** 估算文本里的 token 数；启发式实现可能返回小数。 */
  count(text: string): number;
}

/* ------------------------------------------------------------------ */
/* 字节级字母表                                                        */
/* ------------------------------------------------------------------ */

/** GPT-2 / ByteLevel 的「字节 → unicode 字符」映射（与 HF 实现一致）。 */
function buildByteAlphabet(): Map<number, string> {
  const direct: number[] = [];
  for (let i = 33; i <= 126; i += 1) direct.push(i);
  for (let i = 161; i <= 172; i += 1) direct.push(i);
  for (let i = 174; i <= 255; i += 1) direct.push(i);

  const codes = [...direct];
  let extra = 0;
  const seen = new Set(direct);
  for (let byte = 0; byte < 256; byte += 1) {
    if (seen.has(byte)) continue;
    direct.push(byte);
    codes.push(256 + extra);
    extra += 1;
  }

  const map = new Map<number, string>();
  for (let i = 0; i < direct.length; i += 1) map.set(direct[i]!, String.fromCodePoint(codes[i]!));
  return map;
}

const BYTE_ALPHABET = buildByteAlphabet();
const BYTE_ENCODER = new TextEncoder();

function toByteLevel(text: string): string {
  let out = "";
  for (const byte of BYTE_ENCODER.encode(text)) out += BYTE_ALPHABET.get(byte)!;
  return out;
}

/* ------------------------------------------------------------------ */
/* 预切分                                                              */
/* ------------------------------------------------------------------ */

/**
 * 三段 Split 预切分，**逐字对应** tokenizer.json 里的 `pre_tokenizer`。
 *
 * 顺序有意义（HF 的 Sequence 是依次施加），改顺序会算错。
 */
const SPLIT_PATTERNS = [
  // 1. 数字按 1~3 位一组切开
  /\p{N}{1,3}/gu,
  // 2. CJK（汉字 / 平假名 / 片假名）连续段整体切开
  /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+/gu,
  // 3. GPT-2 风格词边界
  /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~][A-Za-z]+|[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+| ?[\p{P}\p{S}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu,
] as const;

/** 与 tokenizer.json 里 `pre_tokenizer` 的 Regex 逐字比对，防止拿错文件。 */
export const EXPECTED_PATTERN_SOURCE = [
  "\\p{N}{1,3}",
  "[一-龥぀-ゟ゠-ヿ]+",
  "[!\"#$%&'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~][A-Za-z]+|[^\\r\\n\\p{L}\\p{P}\\p{S}]?[\\p{L}\\p{M}]+| ?[\\p{P}\\p{S}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+",
] as const;

/** 「Isolated」切分：命中段单独成片，未命中的部分按原顺序保留。 */
function splitIsolated(text: string, pattern: RegExp): string[] {
  const out: string[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (match[0].length === 0) continue;
    if (start > cursor) out.push(text.slice(cursor, start));
    out.push(match[0]);
    cursor = start + match[0].length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function preTokenize(text: string): string[] {
  let pieces: string[] = [text];
  for (const pattern of SPLIT_PATTERNS) {
    const next: string[] = [];
    for (const piece of pieces) {
      if (piece.length === 0) continue;
      for (const split of splitIsolated(piece, pattern)) next.push(split);
    }
    pieces = next;
  }
  return pieces.map(toByteLevel).filter((piece) => piece.length > 0);
}

/* ------------------------------------------------------------------ */
/* BPE                                                                 */
/* ------------------------------------------------------------------ */

/** merges 的 key：字节级字符里不会出现 `\u0000`，用它当分隔符不会有歧义。 */
function pairKey(left: string, right: string): string {
  return `${left}\u0000${right}`;
}

export class DeepSeekBpeCounter implements TokenCounter {
  readonly kind = "deepseek-bpe" as const;
  #ranks: Map<string, number>;
  #vocab: Set<string>;
  #byteFallback: boolean;
  /** 片 → token 数缓存。流式文本里空白、标点、常见词高度重复，命中率很高。 */
  #cache = new Map<string, number>();

  constructor(options: { merges: Iterable<unknown>; vocab: Iterable<string>; byteFallback?: boolean }) {
    this.#ranks = new Map();
    let rank = 0;
    for (const merge of options.merges) {
      const pair = typeof merge === "string" ? merge.split(" ") : (merge as string[]);
      if (pair.length !== 2 || pair[0] === undefined || pair[1] === undefined) continue;
      this.#ranks.set(pairKey(pair[0], pair[1]), rank);
      rank += 1;
    }
    this.#vocab = new Set(options.vocab);
    this.#byteFallback = options.byteFallback ?? true;
  }

  get vocabSize(): number {
    return this.#vocab.size;
  }

  /** 一个预切分片段（已转成字节级字符）里的 token 数。 */
  #countPiece(piece: string): number {
    const cached = this.#cache.get(piece);
    if (cached !== undefined) return cached;

    let symbols: string[] = [...piece];
    for (;;) {
      if (symbols.length < 2) break;
      let bestRank = Number.POSITIVE_INFINITY;
      let bestIndex = -1;
      for (let i = 0; i < symbols.length - 1; i += 1) {
        const candidate = this.#ranks.get(pairKey(symbols[i]!, symbols[i + 1]!));
        if (candidate !== undefined && candidate < bestRank) {
          bestRank = candidate;
          bestIndex = i;
        }
      }
      if (bestIndex < 0) break;
      symbols = [
        ...symbols.slice(0, bestIndex),
        symbols[bestIndex]! + symbols[bestIndex + 1]!,
        ...symbols.slice(bestIndex + 2),
      ];
    }

    let total = 0;
    for (const symbol of symbols) {
      if (this.#vocab.has(symbol)) {
        total += 1;
        continue;
      }
      // 字节回退：词表里没有的片段按字节拆成 `<0xXX>` 这样的单字节 token。
      if (this.#byteFallback) total += [...symbol].length;
      else total += 1;
    }

    if (this.#cache.size < 8192) this.#cache.set(piece, total);
    return total;
  }

  count(text: string): number {
    if (text.length === 0) return 0;
    let total = 0;
    for (const piece of preTokenize(text)) total += this.#countPiece(piece);
    return total;
  }
}

/* ------------------------------------------------------------------ */
/* 加载                                                                */
/* ------------------------------------------------------------------ */

interface TokenizerJson {
  model?: {
    type?: string;
    byte_fallback?: boolean;
    vocab?: Record<string, number>;
    merges?: unknown[];
  };
  pre_tokenizer?: unknown;
}

/** 校验 pre_tokenizer 就是我们支持的那套；对不上宁可抛错也不要算错。 */
function assertSupportedPreTokenizer(preTokenizer: unknown): void {
  const sequence = (preTokenizer as { type?: string; pretokenizers?: unknown[] } | undefined)
    ?.pretokenizers;
  if (!Array.isArray(sequence) || sequence.length !== 4) {
    throw new Error("tokenizer.json 的 pre_tokenizer 结构不是已验证的 DeepSeek 布局");
  }
  const [digits, cjk, words, byteLevel] = sequence as {
    type?: string;
    pattern?: { Regex?: string };
    add_prefix_space?: boolean;
    use_regex?: boolean;
  }[];
  // 上游文件里 `\r\n` 是**真实控制字符**（不是转义文本），语义与 `\r\n` 等价，
  // 比对前先归一化成转义写法，免得把等价的正则判成不匹配。
  const normalize = (source: string | undefined): string | undefined =>
    source?.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  const sources = [
    normalize(digits?.pattern?.Regex),
    normalize(cjk?.pattern?.Regex),
    normalize(words?.pattern?.Regex),
  ];
  for (let i = 0; i < sources.length; i += 1) {
    if (sources[i] !== EXPECTED_PATTERN_SOURCE[i]) {
      throw new Error(`tokenizer.json 第 ${i + 1} 段 Split 与已验证的 DeepSeek 正则不一致`);
    }
  }
  if (byteLevel?.type !== "ByteLevel" || byteLevel.add_prefix_space !== false) {
    throw new Error("tokenizer.json 的 ByteLevel 配置与已验证的 DeepSeek 布局不一致");
  }
}

export function parseDeepSeekTokenizer(json: unknown): DeepSeekBpeCounter {
  const parsed = json as TokenizerJson;
  if (parsed.model?.type !== "BPE" || !Array.isArray(parsed.model.merges)) {
    throw new Error("tokenizer.json 不是字节级 BPE（缺 model.merges）");
  }
  const vocab = parsed.model.vocab;
  if (vocab === null || typeof vocab !== "object") {
    throw new Error("tokenizer.json 缺少 model.vocab");
  }
  assertSupportedPreTokenizer(parsed.pre_tokenizer);
  return new DeepSeekBpeCounter({
    merges: parsed.model.merges,
    vocab: Object.keys(vocab),
    byteFallback: parsed.model.byte_fallback ?? true,
  });
}

/**
 * 找 tokenizer 文件。
 *
 * 顺序：`BUGENT_TOKENIZER` 显式指定 → 用户级缓存（`bun run tokenizer:fetch` 落这里）。
 */
export function resolveTokenizerPath(env: Record<string, string | undefined> = Bun.env): string | undefined {
  const explicit = env.BUGENT_TOKENIZER;
  if (explicit !== undefined && explicit.length > 0) return existsSync(explicit) ? explicit : undefined;
  const cached = join(homedir(), ".bugent", "tokenizers", "deepseek-v3", "tokenizer.json");
  return existsSync(cached) ? cached : undefined;
}

/** 读文件并构造计数器；失败时抛错，由调用方决定是否退回启发式。 */
export function loadTokenizer(path: string): DeepSeekBpeCounter {
  return parseDeepSeekTokenizer(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/* ------------------------------------------------------------------ */
/* 启发式兜底                                                          */
/* ------------------------------------------------------------------ */

function isCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/**
 * 无 tokenizer 时的粗估：CJK 约 0.6 token/字，其它字符约 1/3.6 token。
 *
 * 系数是按 DeepSeek-V3 真 tokenizer 实测标定的（见 tests/tokenizer.test.ts 的
 * 对照用例），误差个位数百分比；上层还会用服务端 usage 再校准一次。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isCjk(code)) cjk += 1;
    else other += 1;
  }
  return cjk * 0.6 + other / 3.6;
}

export class HeuristicCounter implements TokenCounter {
  readonly kind = "heuristic" as const;
  count(text: string): number {
    return estimateTokens(text);
  }
}
