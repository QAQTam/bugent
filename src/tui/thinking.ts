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
 */

import { BOLD, RESET, fg } from "./markdown.ts";
import { COLOR } from "./theme.ts";

/**
 * 思考区预留的行数。
 *
 * 3 行 = 消息区底部空 1 行 + 思考 1 行 + 输入框上方空 1 行。
 * 之前用 5 行太占地方了 —— 思考是"瞟一眼"的信息，不需要那么大的留白。
 */
export const THINKING_BLOCK_ROWS = 3;

/** 思考渲染在预留区的第几行（0-based）。1 = 中间。 */
export const THINKING_LINE_INDEX = 1;

/** Claude Code 风格的菊花闪烁帧。 */
export const THINKING_FRAMES = ["✻", "✽", "✶", "✳", "✢"] as const;

export type AgentActivity =
  | { state: "idle" }
  | { state: "waiting"; detail?: string }
  | { state: "thinking"; detail?: string }
  | { state: "responding"; detail?: string }
  | { state: "tool"; detail?: string }
  | { state: "goal_init"; detail?: string }
  | { state: "goal_plan"; detail?: string }
  | { state: "goal_checkpoint"; detail?: string }
  | { state: "goal_review"; detail?: string }
  | { state: "goal_handoff"; detail?: string }
  | { state: "goal_audit"; detail?: string }
  | { state: "waiting_user"; detail?: string }
  | { state: "retrying"; detail?: string }
   | { state: "disconnected"; detail?: string }
   | { state: "aborted"; detail?: string };

export function isSpinningActivity(activity: AgentActivity): boolean {
  return (
    activity.state === "waiting" ||
    activity.state === "thinking" ||
    activity.state === "responding" ||
    activity.state === "tool" ||
    activity.state === "goal_init" ||
    activity.state === "goal_plan" ||
    activity.state === "goal_checkpoint" ||
    activity.state === "goal_review" ||
    activity.state === "goal_handoff" ||
    activity.state === "goal_audit" ||
    activity.state === "waiting_user" ||
    activity.state === "retrying"
  );
}

export class ThinkingBuffer {
  #current = "";
  #active = false;

  /** 收到思考增量。 */
  push(delta: string): void {
    if (delta.length === 0) return;
    this.#active = true;

    for (const char of delta) {
      if (char === "\n") {
        // 换行 = 上一行直接销毁，不保留任何历史
        this.#current = "";
        continue;
      }
      this.#current += char;
    }
  }

  /** 是否处于思考态（决定这一行显不显示内容）。 */
  get active(): boolean {
    return this.#active;
  }

  get current(): string {
    return this.#current;
  }

  /** 一轮结束时调用：清空并退出思考态。 */
  reset(): void {
    this.#current = "";
    this.#active = false;
  }
}

/**
 * 从尾部往前取，直到宽度用满 —— 保证右侧永远是最新字符。
 * 返回是否发生了截断。
 */
export function tailToWidth(text: string, width: number): { text: string; truncated: boolean } {
  if (width <= 0) return { text: "", truncated: text.length > 0 };
  if (Bun.stringWidth(text) <= width) return { text, truncated: false };

  const chars = [...text];
  let used = 0;
  let start = chars.length;

  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const charWidth = Bun.stringWidth(chars[i]!);
    if (used + charWidth > width) break;
    used += charWidth;
    start = i;
  }

  return { text: chars.slice(start).join(""), truncated: start > 0 };
}

/**
 * 生成预留区。默认保持原有 reasoning-only 行为；传入 activity 后，菊花代表
 * agent 是否仍在工作，即使没有 reasoning 或正在跑工具也不会消失。
 */
export function composeThinkingBlock(
  buffer: ThinkingBuffer,
  width: number,
  options: {
    rows?: number;
    lineIndex?: number;
    frame?: number;
    activity?: AgentActivity;
  } = {},
): string[] {
  const rows = Math.max(1, options.rows ?? THINKING_BLOCK_ROWS);
  const lineIndex = Math.min(options.lineIndex ?? THINKING_LINE_INDEX, rows - 1);
  const lines: string[] = Array.from({ length: rows }, () => "");
  const activity = options.activity;
  const frameIndex = Math.abs(Math.floor(options.frame ?? 0)) % THINKING_FRAMES.length;
  const frame = THINKING_FRAMES[frameIndex]!;

  if (activity === undefined) {
    if (!buffer.active) return lines;
    lines[lineIndex] = renderActivityLine({
      width,
      frame,
      frameIndex,
      label: "思考",
      text: buffer.current,
      tone: "reasoning",
    });
    return lines;
  }

  if (activity.state === "idle") return lines;

  if (activity.state === "disconnected" || activity.state === "aborted") {
    const disconnected = activity.state === "disconnected";
    lines[lineIndex] = renderActivityLine({
      width,
      frame: disconnected ? "✖" : "■",
      frameIndex: 0,
      label: disconnected ? "已断开" : "已中止",
      text: activity.detail ?? "",
      tone: disconnected ? "error" : "warn",
    });
    return lines;
  }

  const label =
    activity.state === "waiting"
      ? "等待模型"
      : activity.state === "responding"
        ? "生成回复"
        : activity.state === "tool"
          ? "执行工具"
          : activity.state === "goal_init"
            ? "初始化 Goal"
            : activity.state === "goal_plan"
              ? "规划 Goal"
              : activity.state === "goal_checkpoint"
                ? "执行 Checkpoint"
                : activity.state === "goal_review"
                  ? "审查 Checkpoint"
                  : activity.state === "goal_handoff"
                    ? "更新 Handoff"
                    : activity.state === "goal_audit"
                      ? "最终审计"
                      : activity.state === "waiting_user"
                        ? "等待用户"
                        : activity.state === "retrying"
                          ? "重试"
                          : "思考";
  const text =
    activity.state === "thinking"
      ? activity.detail ?? buffer.current
      : activity.detail ?? "";
  lines[lineIndex] = renderActivityLine({
    width,
    frame,
    frameIndex,
    label,
    text,
    tone:
      activity.state === "tool" ||
      activity.state === "goal_init" ||
      activity.state === "goal_plan" ||
      activity.state === "goal_checkpoint" ||
      activity.state === "goal_review" ||
      activity.state === "goal_handoff" ||
      activity.state === "goal_audit"
        ? "tool"
        : activity.state === "retrying" || activity.state === "waiting_user"
          ? "warn"
          : "reasoning",
  });
  return lines;
}

function renderActivityLine(options: {
  width: number;
  frame: string;
  frameIndex: number;
  label: string;
  text: string;
  tone: "reasoning" | "tool" | "warn" | "error";
}): string {
  const labelText = `${options.frame} ${options.label} `;
  const labelWidth = Bun.stringWidth(labelText);
  const budget = Math.max(1, options.width - labelWidth);
  const truncated = Bun.stringWidth(options.text) > budget;
  const available = truncated ? Math.max(1, budget - 1) : budget;
  const { text } = tailToWidth(options.text, available);
  const prefix = truncated ? "…" : "";
  const spinnerColor =
    options.tone === "error"
      ? COLOR.error
      : options.tone === "warn"
        ? COLOR.warn
        : options.tone === "tool"
          ? COLOR.tool
          : options.frameIndex % 2 === 0
            ? COLOR.reasoningSpinner
            : COLOR.reasoningSpinnerDim;
  const bodyColor =
    options.tone === "error"
      ? COLOR.error
      : options.tone === "warn"
        ? COLOR.warn
        : options.tone === "tool"
          ? COLOR.tool
          : COLOR.reasoning;
  const spinner = `${BOLD}${fg(spinnerColor)}${options.frame}${RESET}`;
  return `${spinner} ${fg(bodyColor)}${options.label} ${prefix}${text}${RESET}`;
}
