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

  // 待办三态
  todoPending: "#64748b",
  todoActive: "#fbbf24",
  todoShimmer: "#fff7d6",
  todoDone: "#4ade80",

  // 思考链路
  reasoning: "#8b5cf6",

  // diff
  diffAdd: "#4ade80",
  diffRemove: "#f87171",
} as const;
