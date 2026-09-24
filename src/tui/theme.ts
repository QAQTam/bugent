/**
 * TUI 配色。集中一处，方便以后做主题。
 */

export const COLOR = {
  prompt: "#22d3ee",
  user: "#7dd3fc",
  tool: "#fbbf24",
  toolOk: "#94a3b8",
  error: "#f87171",
  busy: "#fbbf24",
  warn: "#fbbf24",
  ok: "#4ade80",

  /** 输入面板的"阴影"底色。 */
  inputBg: "#1e2430",
  inputEdge: "#22d3ee",
  inputText: "#e2e8f0",

  /** 弹窗底色：比输入面板略亮，形成独立层级。 */
  dialogBg: "#283142",
  dialogBorder: "#fbbf24",

  // 待办三态
  todoPending: "#64748b",
  todoActive: "#fbbf24",
  todoShimmer: "#fff7d6",
  todoDone: "#4ade80",

  // 思考链路
  reasoning: "#c8a96b",
  reasoningSpinner: "#22d3ee",
  reasoningSpinnerDim: "#0891b2",

  // diff
  diffAdd: "#4ade80",
  diffRemove: "#f87171",

  // bash 输出语义层
  bashStdout: "#cbd5e1",
  bashStderr: "#fca5a5",
  bashMeta: "#94a3b8",
  bashWarn: "#fcd34d",
  bashSuccess: "#86efac",
  bashPath: "#93c5fd",
  bashUrl: "#67e8f9",

  // 按钮交互
  buttonNeutralBg: "#334155",
  buttonNeutralFg: "#e2e8f0",
  buttonOkBg: "#166534",
  buttonOkFg: "#dcfce7",
  buttonWarnBg: "#92400e",
  buttonWarnFg: "#fef3c7",
  buttonErrorBg: "#991b1b",
  buttonErrorFg: "#fee2e2",
  buttonHoverBg: "#1e3a5f",
  buttonHoverFg: "#e0f2fe",
  buttonPressedBg: "#2563eb",
  buttonPressedFg: "#ffffff",
} as const;
