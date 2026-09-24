/**
 * TUI 配色。
 *
 * `darkTheme` 是唯一的完整配色；浅色变体还没做，因为那些值只有在浅色终端上
 * 看才知道对不对（近白色的正文、`dialogBg` 这类深底都要重新推导）。
 *
 * 结构已经就位：`COLOR` 是**当前生效**的主题，启动时由 `applyTheme()` 选定，
 * 所以各渲染模块照旧写 `COLOR.xxx`，不需要感知主题切换。
 */

import type { TerminalBackground } from "./background.ts";

export interface Theme {
  prompt: string;
  user: string;
  tool: string;
  toolOk: string;
  error: string;
  busy: string;
  warn: string;
  ok: string;

  /** 输入框边框；也是滚动条 thumb 的强调色。 */
  inputEdge: string;
  inputText: string;
  /** 空输入时的占位提示。 */
  inputPlaceholder: string;

  /** 弹窗底色：比正文略亮，形成独立层级。 */
  dialogBg: string;
  dialogBorder: string;

  /** 吸顶的本轮用户消息：整行铺底，和正文区分开。 */
  userBandBg: string;
  userBandFg: string;

  // 待办三态
  todoPending: string;
  todoActive: string;
  todoShimmer: string;
  todoDone: string;

  // 思考链路
  reasoning: string;
  reasoningSpinner: string;
  reasoningSpinnerDim: string;
  /** 空闲时静止的菊花：只求"在场"，不抢注意力。 */
  spinnerIdle: string;

  // diff
  diffAdd: string;
  diffRemove: string;

  // bash 输出语义层
  bashStdout: string;
  bashStderr: string;
  bashMeta: string;
  bashWarn: string;
  bashSuccess: string;
  bashPath: string;
  bashUrl: string;

  // 按钮交互
  buttonNeutralBg: string;
  buttonNeutralFg: string;
  buttonOkBg: string;
  buttonOkFg: string;
  buttonWarnBg: string;
  buttonWarnFg: string;
  buttonErrorBg: string;
  buttonErrorFg: string;
  buttonHoverBg: string;
  buttonHoverFg: string;
  buttonPressedBg: string;
  buttonPressedFg: string;
}

/**
 * 深色终端配色。
 *
 * diff 两色刻意压低饱和度（69% / 91% → 28% / 51%）：一屏几十行 diff 连续
 * 看，报警器级别的鲜艳很累眼。语义不靠颜色单独承载 —— 每行有 `+`/`-`
 * 前缀，头部还有 `+N -M` 徽标。
 *
 * 注意 `fg()` 默认量化到 256 色，所以这两个值实际落到索引 144 / 173。
 */
export const darkTheme: Theme = {
  prompt: "#22d3ee",
  user: "#7dd3fc",
  tool: "#fbbf24",
  toolOk: "#94a3b8",
  error: "#f87171",
  busy: "#fbbf24",
  warn: "#fbbf24",
  ok: "#4ade80",

  inputEdge: "#22d3ee",
  inputText: "#e2e8f0",
  inputPlaceholder: "#64748b",

  dialogBg: "#283142",
  dialogBorder: "#fbbf24",

  userBandBg: "#1e293b",
  userBandFg: "#7dd3fc",

  todoPending: "#64748b",
  todoActive: "#fbbf24",
  todoShimmer: "#fff7d6",
  todoDone: "#4ade80",

  reasoning: "#c8a96b",
  reasoningSpinner: "#22d3ee",
  reasoningSpinnerDim: "#0891b2",
  spinnerIdle: "#64748b",

  diffAdd: "#a3be8c",
  diffRemove: "#d08770",

  bashStdout: "#cbd5e1",
  bashStderr: "#fca5a5",
  bashMeta: "#94a3b8",
  bashWarn: "#fcd34d",
  bashSuccess: "#86efac",
  bashPath: "#93c5fd",
  bashUrl: "#67e8f9",

  buttonNeutralBg: "#334155",
  buttonNeutralFg: "#e2e8f0",
  buttonOkBg: "#166534",
  buttonOkFg: "#dcfce7",
  buttonWarnBg: "#92400e",
  buttonWarnFg: "#fef3c7",
  buttonErrorBg: "#991b1b",
  buttonErrorFg: "#fee2e2",
  // 悬停/按下底色刻意取得比上面四种按钮底色都亮（见 button.ts 的说明）
  buttonHoverBg: "#64748b",
  buttonHoverFg: "#f8fafc",
  buttonPressedBg: "#2563eb",
  buttonPressedFg: "#ffffff",
};

/** 当前生效的主题。渲染模块直接读它。 */
export let COLOR: Theme = darkTheme;

let background: TerminalBackground = "dark";

/**
 * 记录终端底色并选定配色。
 *
 * 浅色配色还没落地，所以两档现在都选 `darkTheme`；底色仍然要记下来，
 * 因为 markdown 渲染要据此决定行内代码的底色。浅色主题做好之后，
 * 这里按 `background` 换成 `lightTheme` 即可。
 */
export function applyTheme(next: TerminalBackground): void {
  background = next;
  COLOR = darkTheme;
}

export function currentBackground(): TerminalBackground {
  return background;
}
