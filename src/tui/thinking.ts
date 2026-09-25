/**
 * 思考链路的滚动显示。
 *
 * 按需求实现的形态：
 *   - 消息区与输入框之间预留 3 行
 *   - 思考内容只占**中间那一行**，上下各留 1 行呼吸空间
 *   - 没遇到 `\n` 时横向滚动，右侧永远是最新字符
 *   - 遇到 `\n` 就销毁上一行，从空开始
 *
 * 关键设计：**只保留当前行**。
 * 思考内容动辄上万字，全留在内存里既拖慢渲染又毫无价值 ——
 * 用户看的是"模型此刻在想什么"，不是思考全文。
 * 所以这里是 O(1) 内存：一行的字符数封顶，与总思考长度无关。
 *
 * reasoning 是 UI-only 数据：不写入 AgentSession、不分配 msgid、不进上下文。
 * 它由 TUI 在 assistant 消息边界和 runtime 切换时 reset，避免跨 msgid 串线。
 *
 * 状态不用文字表达，只看菊花本身：
 *
 *   ✻ 在转、青色   agent 还在干活（等模型、思考、生成回复、跑工具、重试…）
 *   ✻ 静止、灰色   空闲
 *   ✖ 红色         断线，后面跟真实报错
 *   ■ 琥珀         用户中止
 *
 * 后两个是唯一的例外：它们保留文字，因为那不是状态描述而是真实信息。
 */

import { BOLD, RESET, fg } from "./markdown.ts";
import { visibleWidth } from "./ansi.ts";
import { COLOR } from "./theme.ts";

/**
 * 思考区预留的行数。
 *
 * 3 行 = 消息区底部空 1 行 + 思考 1 行 + 输入框上方空 1 行。
 * 之前用 5 行太占地方了 —— 思考是"瞟一眼"的信息，不需要那么大的留白。
 */
export const THINKING_BLOCK_ROWS = 3;

/** 菊花（含思考尾巴）自己至少要占的行数 —— 任何情况下都不能被别的控件挤掉。 */
export const THINKING_SPINNER_ROWS = 1;

/** 思考渲染在预留区的第几行（0-based）。1 = 中间。 */
export const THINKING_LINE_INDEX = 1;

/** Claude Code 风格的菊花闪烁帧。 */
export const THINKING_FRAMES = ["✻", "✽", "✶", "✳", "✢"] as const;

/**
 * agent 活动状态。只区分"还在干活"和"空闲"，因为展示上只有这两种形态；
 * 具体在等模型还是在跑工具不影响这一行长什么样 —— 那属于消息区的内容。
 */
export type AgentActivity =
  | { state: "idle" }
  | { state: "working" }
  | { state: "disconnected"; detail?: string }
  | { state: "aborted" };

/** 菊花是否需要继续转动。 */
export function isSpinningActivity(activity: AgentActivity): boolean {
  return activity.state === "working";
}

export class ThinkingBuffer {
  #current = "";
  /** 内容变更通知；TUI 用它把"改了就重画"变成结构性保证。 */
  #onChange: (() => void) | undefined;

  set onChange(handler: (() => void) | undefined) {
    this.#onChange = handler;
  }

  /** 收到思考增量。 */
  push(delta: string): void {
    if (delta.length === 0) return;

    for (const char of delta) {
      if (char === "\n") {
        // 换行 = 上一行直接销毁，不保留任何历史
        this.#current = "";
        continue;
      }
      this.#current += char;
    }
    this.#onChange?.();
  }

  get current(): string {
    return this.#current;
  }

  /** 一轮结束时调用：清空缓冲。 */
  reset(): void {
    // 已经是空的不算变更，别为此白请求一帧。
    if (this.#current === "") return;
    this.#current = "";
    this.#onChange?.();
  }
}

/**
 * 从尾部往前取，直到宽度用满 —— 保证右侧永远是最新字符。
 * 返回是否发生了截断。
 */
export function tailToWidth(text: string, width: number): { text: string; truncated: boolean } {
  if (width <= 0) return { text: "", truncated: text.length > 0 };
  if (visibleWidth(text) <= width) return { text, truncated: false };

  const chars = [...text];
  let used = 0;
  let start = chars.length;

  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const charWidth = visibleWidth(chars[i]!);
    if (used + charWidth > width) break;
    used += charWidth;
    start = i;
  }

  return { text: chars.slice(start).join(""), truncated: start > 0 };
}

/** 菊花配色：转起来是青色，静止是灰色。 */
type SpinnerTone = "working" | "idle" | "warn" | "error";

/**
 * 生成预留区。
 *
 * 这一行只有菊花和（有思考内容时的）思考尾部 —— 没有任何状态文字。
 * 菊花在转 = 还在干活，静止且灰 = 空闲。
 */
export function composeThinkingBlock(
  buffer: ThinkingBuffer,
  width: number,
  options: {
    activity: AgentActivity;
    rows?: number;
    lineIndex?: number;
    frame?: number;
  },
): string[] {
  const rows = Math.max(1, options.rows ?? THINKING_BLOCK_ROWS);
  const lineIndex = Math.min(options.lineIndex ?? THINKING_LINE_INDEX, rows - 1);
  const lines: string[] = Array.from({ length: rows }, () => "");
  const { activity } = options;
  const frameIndex = Math.abs(Math.floor(options.frame ?? 0)) % THINKING_FRAMES.length;
  const frame = THINKING_FRAMES[frameIndex]!;

  if (activity.state === "disconnected") {
    lines[lineIndex] = renderSpinnerLine({
      width,
      frame: "✖",
      frameIndex: 0,
      text: activity.detail ?? "",
      tone: "error",
    });
    return lines;
  }

  if (activity.state === "aborted") {
    lines[lineIndex] = renderSpinnerLine({
      width,
      frame: "■",
      frameIndex: 0,
      text: "",
      tone: "warn",
    });
    return lines;
  }

  lines[lineIndex] = renderSpinnerLine({
    width,
    frame,
    frameIndex,
    text: buffer.current,
    tone: isSpinningActivity(activity) ? "working" : "idle",
  });
  return lines;
}

function renderSpinnerLine(options: {
  width: number;
  frame: string;
  frameIndex: number;
  text: string;
  tone: SpinnerTone;
}): string {
  const spinnerColor =
    options.tone === "error"
      ? COLOR.error
      : options.tone === "warn"
        ? COLOR.warn
        : options.tone === "idle"
          ? COLOR.spinnerIdle
          : options.frameIndex % 2 === 0
            ? COLOR.reasoningSpinner
            : COLOR.reasoningSpinnerDim;
  // 空闲是安静的状态：只有灰，不加粗。
  const bold = options.tone === "idle" ? "" : BOLD;
  const spinner = `${bold}${fg(spinnerColor)}${options.frame}${RESET}`;
  if (options.text.length === 0) return spinner;

  const head = `${options.frame} `;
  const budget = Math.max(1, options.width - visibleWidth(head));
  const truncated = visibleWidth(options.text) > budget;
  const available = truncated ? Math.max(1, budget - 1) : budget;
  const { text } = tailToWidth(options.text, available);
  const prefix = truncated ? "…" : "";
  const bodyColor =
    options.tone === "error"
      ? COLOR.error
      : options.tone === "warn"
        ? COLOR.warn
        : COLOR.reasoning;
  return `${spinner} ${fg(bodyColor)}${prefix}${text}${RESET}`;
}
