/**
 * 流式文本显示队列。
 *
 * 模型/网关并不保证 token 均匀到达：一次网络 read 可能带回 5~10 条 SSE，
 * 如果这些 delta 直接进 Transcript，下一帧就会整块跳出来。FrameScheduler
 * 只能限制“多久画一次”，不能把已经合进状态里的文本重新摊开。
 *
 * StreamPacer 把“到达”和“显示”解耦：
 *   - 到达的 delta 立即入队，不直接改可见文本；
 *   - 每帧按 token 预算揭示一小段；
 *   - 队列延迟过大时有限加速，避免为了平滑无限落后模型。
 *
 * 小 delta 保持原子性，避免把现有“一字符一 chunk”的流拆坏；只有估算超过
 * 一个 token 的较大 delta 才按约 1 token 切成显示单元。
 */

import { estimateTokens } from "../util/tokenizer.ts";

export interface StreamPacerOptions {
  /** 正常揭示速度，单位是估算 token/s。默认 120。 */
  targetTokensPerSecond?: number;
  /** 最老单元超过该延迟后开始有限追帧。默认 100ms。 */
  catchUpAfterMs?: number;
  /** 追帧时把显示成本降低的倍数。默认 2。 */
  catchUpMultiplier?: number;
  /** 正常帧最多揭示几个显示单元。默认 4。 */
  maxUnitsPerFrame?: number;
  /** 追帧帧最多揭示几个显示单元。默认 8。 */
  maxCatchUpUnitsPerFrame?: number;
  /** 时钟注入点，测试用。 */
  now?: () => number;
  /** token 估算注入点，测试用。 */
  estimate?: (text: string) => number;
}

interface RevealUnit {
  text: string;
  weight: number;
  arrivedAt: number;
}

const GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

function graphemes(text: string): string[] {
  if (GRAPHEME_SEGMENTER === undefined) return Array.from(text);
  return [...GRAPHEME_SEGMENTER.segment(text)].map((part) => part.segment);
}

function isCjk(segment: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(segment);
}

/**
 * 把大 delta 切成约 1 token 的显示单元。
 *
 * 小 delta 原样保留很重要：mock/真实网关都可能逐字符发送，若这里强行按
 * 固定字数合并，会把本来均匀的字符流变成两大块。
 */
export function splitRevealUnits(
  text: string,
  estimate: (text: string) => number = estimateTokens,
): string[] {
  if (text.length === 0) return [];
  const total = estimate(text);
  if (total <= 2.5 || text.length <= 16) return [text];

  const out: string[] = [];
  let current = "";
  let currentWeight = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    out.push(current);
    current = "";
    currentWeight = 0;
  };

  for (const segment of graphemes(text)) {
    // CJK 单字通常就是一个 token；空白作为边界，避免下一单元以空格开头。
    if (isCjk(segment) || /\s/u.test(segment)) {
      flush();
      out.push(segment);
      continue;
    }

    current += segment;
    currentWeight += estimate(segment);
    if (currentWeight >= 1) flush();
  }
  flush();
  return out;
}

export class StreamPacer {
  #queue: RevealUnit[] = [];
  #head = 0;
  #targetTokensPerSecond: number;
  #catchUpAfterMs: number;
  #catchUpMultiplier: number;
  #maxUnitsPerFrame: number;
  #maxCatchUpUnitsPerFrame: number;
  #now: () => number;
  #estimate: (text: string) => number;

  #credit = 1;
  #lastDrainAt: number | undefined;
  #lastRevealAt: number | undefined;

  constructor(options: StreamPacerOptions = {}) {
    this.#targetTokensPerSecond = Math.max(1, options.targetTokensPerSecond ?? 120);
    this.#catchUpAfterMs = Math.max(0, options.catchUpAfterMs ?? 100);
    this.#catchUpMultiplier = Math.max(1, options.catchUpMultiplier ?? 2);
    this.#maxUnitsPerFrame = Math.max(1, options.maxUnitsPerFrame ?? 4);
    this.#maxCatchUpUnitsPerFrame = Math.max(
      this.#maxUnitsPerFrame,
      options.maxCatchUpUnitsPerFrame ?? 8,
    );
    this.#now = options.now ?? (() => performance.now());
    this.#estimate = options.estimate ?? estimateTokens;
  }

  /** 摊销压缩已经消费的前缀，避免每帧 shift 造成 O(n²)。 */
  #compactQueue(): void {
    if (this.#head === 0) return;
    if (this.#head < 64 || this.#head * 2 < this.#queue.length) return;
    this.#queue = this.#queue.slice(this.#head);
    this.#head = 0;
  }

  /** 是否有待揭示内容。 */
  get pending(): boolean {
    return this.#head < this.#queue.length;
  }

  /** 队列里的估算 token 数，用于诊断和追帧判断。 */
  get queuedTokens(): number {
    let total = 0;
    for (let index = this.#head; index < this.#queue.length; index += 1) {
      total += this.#queue[index]!.weight;
    }
    return total;
  }

  /** 最老显示单元的排队时长；队列为空时为 undefined。 */
  get oldestAgeMs(): number | undefined {
    const oldest = this.#queue[this.#head];
    if (oldest === undefined) return undefined;
    return Math.max(0, this.#now() - oldest.arrivedAt);
  }

  /** 最近一次实际揭示文本的时刻；没有揭示过时为 undefined。 */
  get lastRevealAt(): number | undefined {
    return this.#lastRevealAt;
  }

  /** 把一段到达文本加入显示队列。 */
  push(delta: string, now = this.#now()): void {
    if (delta.length === 0) return;
    if (this.#lastDrainAt === undefined) this.#lastDrainAt = now;
    for (const text of splitRevealUnits(delta, this.#estimate)) {
      this.#queue.push({
        text,
        weight: Math.max(0.05, this.#estimate(text)),
        arrivedAt: now,
      });
    }
  }

  /**
   * 按当前时间揭示一小段文本。
   *
   * 用真实 elapsed 计算 credit，而不是假设调用方永远精确按 120fps 调；
   * 这样 50/60/120Hz 以及偶发晚帧都能保持接近目标速度。
   */
  drain(now = this.#now()): string {
    if (!this.pending) {
      this.#queue = [];
      this.#head = 0;
      this.#lastDrainAt = now;
      return "";
    }

    const last = this.#lastDrainAt ?? now;
    const elapsedMs = Math.max(0, Math.min(250, now - last));
    this.#lastDrainAt = now;
    this.#credit += (this.#targetTokensPerSecond * elapsedMs) / 1000;

    const oldest = this.#queue[this.#head];
    const catchUp =
      oldest !== undefined && now - oldest.arrivedAt >= this.#catchUpAfterMs;
    const maxUnits = catchUp ? this.#maxCatchUpUnitsPerFrame : this.#maxUnitsPerFrame;

    let out = "";
    let revealed = 0;
    while (revealed < maxUnits) {
      const unit = this.#queue[this.#head];
      if (unit === undefined) break;

      const lagMs = now - unit.arrivedAt;
      const cost =
        lagMs >= this.#catchUpAfterMs
          ? unit.weight / this.#catchUpMultiplier
          : unit.weight;
      if (cost > this.#credit && revealed > 0) break;
      if (cost > this.#credit && !catchUp) break;

      this.#credit = Math.max(0, this.#credit - cost);
      this.#head += 1;
      out += unit.text;
      revealed += 1;
    }

    this.#compactQueue();
    if (out.length > 0) this.#lastRevealAt = now;
    return out;
  }

  /** 立即取出全部待显示文本，用于消息边界、工具调用和退出。 */
  flush(): string {
    if (!this.pending) return "";
    const out = this.#queue
      .slice(this.#head)
      .map((unit) => unit.text)
      .join("");
    this.#queue = [];
    this.#head = 0;
    this.#credit = 1;
    this.#lastDrainAt = this.#now();
    return out;
  }

  /** 丢弃队列并重置节奏。 */
  reset(): void {
    this.#queue = [];
    this.#head = 0;
    this.#credit = 1;
    this.#lastDrainAt = undefined;
    this.#lastRevealAt = undefined;
  }
}
