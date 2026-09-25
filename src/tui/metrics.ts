/**
 * 右上角状态栏的三项指标 —— 上下文占用 / 会话缓存命中率 / 瞬时输出速度。
 *
 * 数据来源分两类，**能拿到服务端数字就不自己猜**：
 *
 *   1. 服务端 usage（每次请求结束时回传一次）
 *      - `input`  = prompt_tokens，即这次请求发出去的完整上下文
 *      - `output` = completion_tokens（含思考 token）
 *      - `cached` = 命中前缀缓存的输入 token（OpenAI `prompt_tokens_details.cached_tokens`、
 *        DeepSeek `prompt_cache_hit_tokens`，adapter 已归一化）
 *      它给的是**整段请求的精确值**，但只在一段结束时到，所以：
 *      - 上下文占用：取最近一次请求的 input + output（那就是此刻压在窗口里的量）
 *      - 缓存命中率：整段会话累加（cached / input）
 *      - 瞬时速度：用它做校准锚点
 *
 *   2. 流式增量（text / reasoning / tool_call args）
 *      usage 在流式过程中不会来，所以"这一刻吐了多少 token"只能自己量：
 *      按滑动时间窗口统计窗口内经过的 token 数，再除以窗口跨度。
 *      计数优先用真 tokenizer（`src/util/tokenizer.ts`），拿不到就启发式估算，
 *      并用 usage 的 output 反过来校准估算系数。
 *
 * 速度刻意把**思考、工具调用参数、最终作答**三段都算进去 —— 用户关心的是
 * "模型此刻的产出速度"，而不是最终答复那一小段。
 */

import type { Usage } from "../provider/types.ts";
import type { TokenCounter } from "../util/tokenizer.ts";
import { HeuristicCounter } from "../util/tokenizer.ts";
import { fg, RESET } from "./markdown.ts";
import { COLOR } from "./theme.ts";

/** 滑动窗口长度：太短读数跳，太长反应迟钝。3s 是"一眼能看出快慢"的折中。 */
export const SPEED_WINDOW_MS = 3000;

/** 窗口内样本跨度不足时的除数下限，避免第一个增量算出天文数字。 */
const MIN_SPAN_MS = 250;

/** 速度低于该值时直接显示 0，免得安静时还挂着一个 0.3 抖动。 */
const SPEED_EPSILON = 0.05;

export interface StreamMeterOptions {
  windowMs?: number;
  now?: () => number;
  counter?: TokenCounter;
}

/**
 * 流式输出速度计。
 *
 * 只留窗口内的样本（数组 + 每次读取时裁掉过期的），内存与流长度无关。
 */
export class StreamMeter {
  #samples: { at: number; tokens: number }[] = [];
  #windowMs: number;
  #now: () => number;
  #counter: TokenCounter;
  /** 自上次 usage 以来累计的估算 token，用于校准启发式系数。 */
  #estimateSinceUsage = 0;
  #calibration = 1;
  #calibrated = false;

  constructor(options: StreamMeterOptions = {}) {
    this.#windowMs = options.windowMs ?? SPEED_WINDOW_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#counter = options.counter ?? new HeuristicCounter();
  }

  /** 换成真 tokenizer（异步加载完成后调用）；已计数的样本保持原样。 */
  setCounter(counter: TokenCounter): void {
    if (counter.kind === this.#counter.kind) return;
    this.#counter = counter;
    this.#calibration = 1;
    this.#calibrated = false;
    this.#estimateSinceUsage = 0;
  }

  get counterKind(): TokenCounter["kind"] {
    return this.#counter.kind;
  }

  /** 是否用服务端 usage 校准过估算系数（诊断 / 测试用）。 */
  get calibrated(): boolean {
    return this.#calibrated;
  }

  /** 喂一段流式增量（正文 / 思考 / 工具参数都走这里）。 */
  noteDelta(text: string): void {
    if (text.length === 0) return;
    const estimated = this.#counter.count(text);
    if (!(estimated > 0)) return;
    const tokens = this.#calibrated ? estimated * this.#calibration : estimated;
    this.#estimateSinceUsage += estimated;
    this.#samples.push({ at: this.#now(), tokens });
  }

  /**
   * 一段请求结束：用服务端 output 校准启发式系数。
   *
   * 真 tokenizer 不需要校准（本来就准），只清掉累计值。
   */
  noteUsage(usage: Usage): void {
    const estimated = this.#estimateSinceUsage;
    this.#estimateSinceUsage = 0;
    if (this.#counter.kind !== "heuristic") return;
    if (!(estimated > 0) || !(usage.output > 0)) return;
    const factor = usage.output / estimated;
    if (!Number.isFinite(factor) || factor <= 0) return;
    const clamped = Math.min(4, Math.max(0.25, factor));
    this.#calibration = this.#calibrated ? this.#calibration * 0.7 + clamped * 0.3 : clamped;
    this.#calibrated = true;
  }

  #prune(at: number): void {
    const cutoff = at - this.#windowMs;
    let drop = 0;
    while (drop < this.#samples.length && this.#samples[drop]!.at <= cutoff) drop += 1;
    if (drop > 0) this.#samples.splice(0, drop);
  }

  /** 窗口内还有样本 = 还在输出，UI 需要继续刷新（读数会随时间衰减）。 */
  active(at: number = this.#now()): boolean {
    this.#prune(at);
    return this.#samples.length > 0;
  }

  /** 瞬时速度（tok/s）；窗口内没有样本时为 0。 */
  rate(at: number = this.#now()): number {
    this.#prune(at);
    if (this.#samples.length === 0) return 0;
    let tokens = 0;
    for (const sample of this.#samples) tokens += sample.tokens;
    const span = Math.min(this.#windowMs, Math.max(at - this.#samples[0]!.at, MIN_SPAN_MS));
    const value = tokens / (span / 1000);
    return value < SPEED_EPSILON ? 0 : value;
  }

  /** 窗口里最早样本过期的时间点；没有样本时返回 undefined。UI 用它安排下一帧。 */
  nextExpiry(at: number = this.#now()): number | undefined {
    this.#prune(at);
    const first = this.#samples[0];
    return first === undefined ? undefined : first.at + this.#windowMs + 1;
  }

  reset(): void {
    this.#samples = [];
    this.#estimateSinceUsage = 0;
    this.#calibration = 1;
    this.#calibrated = false;
  }
}

/* ------------------------------------------------------------------ */
/* 会话累计量                                                          */
/* ------------------------------------------------------------------ */

/** 会话累计缓存命中率；provider 没回传 cached 时为 undefined。 */
export function cacheHitRate(usage: Usage): number | undefined {
  if (usage.cached === undefined || usage.input <= 0) return undefined;
  return Math.min(1, Math.max(0, usage.cached / usage.input));
}

export interface ContextOccupancy {
  /** 最近一次请求占用的 token 数（input + output）。 */
  used: number;
  /** 模型上下文窗口；未知时为 undefined（此时只显示绝对量，不编百分比）。 */
  window?: number;
  ratio?: number;
}

/**
 * 上下文占用 = 最近一次请求的 input + output。
 *
 * 为什么不是"整段会话累加"：每轮请求都会把完整历史重新发一遍，input 本身就是
 * 当前上下文大小；累加只会得到一个与窗口无关的天文数字。
 */
export function contextOccupancy(last: Usage | undefined, window?: number): ContextOccupancy | undefined {
  if (last === undefined) return undefined;
  const used = last.input + last.output;
  if (used <= 0) return undefined;
  if (window === undefined || window <= 0) return { used };
  return { used, window, ratio: Math.min(1, used / window) };
}

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

/** 1234 → "1.2k"，24100 → "24.1k"，128000 → "128k"，1200000 → "1.2M"。 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) {
    const value = tokens / 1000;
    return `${value < 100 ? value.toFixed(1) : Math.round(value)}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** 速度：<100 保留一位小数，≥100 取整（读数别抖）。 */
export function formatSpeed(tokensPerSecond: number): string {
  if (tokensPerSecond >= 100) return String(Math.round(tokensPerSecond));
  return tokensPerSecond.toFixed(1);
}

/**
 * 百分比：<10% 保留一位小数。
 *
 * 1M 窗口下刚开始对话时占用常常不到 1%，取整会显示成 "0%" —— 那读起来像
 * "什么都没用"，而 0.3% 才是实情。
 */
export function formatPercent(ratio: number): string {
  const percent = ratio * 100;
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

export interface MetricsView {
  context?: ContextOccupancy | undefined;
  cacheRate?: number | undefined;
  tokensPerSecond: number;
  /** 计数来源，用于把"估算值"标出来。 */
  estimated?: boolean | undefined;
}

export type MetricsStyle = "full" | "compact" | "minimal";

function contextColor(ratio: number | undefined): string {
  if (ratio === undefined) return COLOR.tool;
  if (ratio >= 0.9) return COLOR.error;
  if (ratio >= 0.7) return COLOR.warn;
  return COLOR.ok;
}

/**
 * 组装右上角指标文本。
 *
 * 三档宽度递减，由调用方按可用宽度挑第一个放得下的：
 *   full     `ctx 24.1k/128k 19% · cache 87% · 42.3 tok/s`
 *   compact  `ctx 19% · cache 87% · 42.3 tok/s`
 *   minimal  `19% · 87% · 42.3/s`
 */
export function formatMetrics(view: MetricsView, style: MetricsStyle = "full"): string {
  const parts: string[] = [];
  const dim = (text: string): string => `${fg(COLOR.toolOk)}${text}${RESET}`;
  const estimatedMark = view.estimated === true ? "~" : "";

  const context = view.context;
  if (context !== undefined) {
    const color = contextColor(context.ratio);
    const percent = context.ratio !== undefined ? formatPercent(context.ratio) : undefined;
    if (style === "minimal") {
      parts.push(`${fg(color)}${percent ?? formatTokenCount(context.used)}${RESET}`);
    } else if (style === "compact") {
      // 中档只留百分比：标签还在，读得懂；绝对值是最占宽度的那一段。
      parts.push(`${dim("ctx ")}${fg(color)}${percent ?? formatTokenCount(context.used)}${RESET}`);
    } else {
      const used = formatTokenCount(context.used);
      const window = context.window !== undefined ? `/${formatTokenCount(context.window)}` : "";
      const ratio = percent !== undefined ? ` ${percent}` : "";
      parts.push(`${dim("ctx ")}${fg(color)}${used}${window}${ratio}${RESET}`);
    }
  }

  if (view.cacheRate !== undefined) {
    const label = style === "minimal" ? "" : `${dim("cache ")}`;
    const color = view.cacheRate >= 0.5 ? COLOR.ok : COLOR.warn;
    parts.push(`${label}${fg(color)}${formatPercent(view.cacheRate)}${RESET}`);
  }

  const speedColor = view.tokensPerSecond > 0 ? COLOR.reasoningSpinner : COLOR.spinnerIdle;
  const unit = style === "minimal" ? "/s" : " tok/s";
  parts.push(
    `${fg(speedColor)}${estimatedMark}${formatSpeed(view.tokensPerSecond)}${unit}${RESET}`,
  );

  return parts.join(dim(" · "));
}
