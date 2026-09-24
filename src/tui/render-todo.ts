/**
 * todo_write 的自定义外观。
 *
 * 标记一律用**纯 ASCII**，且三个标记等宽（都是 3 格）：
 *
 *   [ ] 待办      [>] 正在办      [x] 办成
 *
 * 为什么不用 ☐ ◐ ☑：这类字符属于 Unicode "East Asian Ambiguous"，
 * 宽度随终端 locale 变化 —— 有的终端渲染成 1 格，有的渲染成 2 格，
 * 还有的直接显示成替代字符。实测用户的终端就把 ☐ 显示成了连字符。
 * ASCII 没有这个问题，而且三态等宽能保证内容左对齐不跳。
 */

import { BOLD, DIM, RESET, fg } from "./markdown.ts";
import { truncateAnsi, visibleWidth } from "./ansi.ts";
import { COLOR } from "./theme.ts";
import type { ToolItem } from "./renderers.ts";
import { countTodos, tryParseTodos, type Todo, type TodoStatus } from "../tools/todo.ts";

export const TODO_MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

/**
 * 折叠态面板占几行（含标题与展开按钮）。
 *
 * 待办动辄十几条，全铺开会把消息区挤没；折叠态只留"标题 + 当前在做的那一项
 * + 展开按钮"，看计划的全貌靠点一下。
 */
export const TODO_COLLAPSED_LINES = 3;

const STATUS_COLOR: Record<TodoStatus, string> = {
  pending: COLOR.todoPending,
  in_progress: COLOR.todoActive,
  completed: COLOR.todoDone,
};

/** 纯文本按可见宽度截断，避免把 ANSI 当成 shimmer 的字符输入。 */
function truncatePlain(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  const ellipsis = "…";
  const budget = Math.max(0, maxWidth - visibleWidth(ellipsis));
  let out = "";
  let width = 0;
  for (const char of Array.from(text)) {
    const charWidth = visibleWidth(char);
    if (width + charWidth > budget) break;
    out += char;
    width += charWidth;
  }
  return `${out}${ellipsis}`;
}

/**
 * 让一段高亮在文本上从右向左流动。
 *
 * phase 是 0..1 的循环相位；窗口宽度随文本长度变化，但至少 4 列。
 * 这里逐字符上色，todo 行很短，不会成为性能瓶颈。
 */
function shimmerText(text: string, phase: number, base: string, highlight: string): string {
  const chars = Array.from(text);
  const total = visibleWidth(text);
  const window = Math.max(4, Math.min(10, Math.ceil(total / 3)));
  const position = phase * (total + window) - window;
  let out = "";
  let cursor = 0;

  for (const char of chars) {
    const charWidth = visibleWidth(char);
    const active = cursor + charWidth > position && cursor < position + window;
    out += `${fg(active ? highlight : base)}${char}`;
    cursor += charWidth;
  }

  return `${out}${RESET}`;
}

export interface TodoLineOptions {
  /** in_progress 的 shimmer 相位；0..1。 */
  shimmer?: number;
}

/** 单条待办的一行。sticky 面板与 transcript 共用同一套外观。 */
export function renderTodoLine(todo: Todo, width: number, options: TodoLineOptions = {}): string {
  const marker = TODO_MARKERS[todo.status];
  const color = STATUS_COLOR[todo.status];
  const baseText =
    todo.status === "in_progress" && todo.activeForm !== undefined ? todo.activeForm : todo.content;
  const completion =
    todo.completion ??
    (todo.completionEvidence !== undefined && todo.completionEvidence.length > 0
      ? todo.completionEvidence.join("; ")
      : undefined);
  const text =
    todo.status === "completed" && completion !== undefined
      ? `${baseText} — ${completion}`
      : baseText;
  const available = Math.max(1, width - 4);

  if (todo.status === "in_progress" && options.shimmer !== undefined) {
    const clipped = truncatePlain(text, available);
    return `${fg(color)}${marker}${RESET} ${BOLD}${shimmerText(
      clipped,
      options.shimmer,
      color,
      COLOR.todoShimmer,
    )}`;
  }

  const decoration = todo.status === "completed" ? DIM : todo.status === "in_progress" ? BOLD : "";
  return `${fg(color)}${marker}${RESET} ${decoration}${truncateAnsi(text, available)}${RESET}`;
}

export interface TodoPanelOptions {
  /** 面板最多占几行（含标题）。 */
  maxLines?: number;
  /** 整份计划的一句话摘要。 */
  summary?: string;
  /** in_progress 的 shimmer 相位；0..1。 */
  shimmer?: number;
  /**
   * 折叠态：能全部放进 {@link TODO_COLLAPSED_LINES} 就全放，放不下只留
   * "当前在做的那一项"，剩下的交给调用方的展开按钮。
   */
  collapsed?: boolean;
}

/**
 * 生成 sticky 待办面板（贴在输入框上方）。
 * 没有待办时返回空数组，调用方不需要特判。
 */
export function composeTodoPanel(
  todos: readonly Todo[],
  width: number,
  options: TodoPanelOptions = {},
): string[] {
  if (todos.length === 0) return [];

  const maxLines = Math.max(2, options.maxLines ?? 8);
  const counts = countTodos(todos);
  const progress = `${counts.completed}/${todos.length}${
    counts.in_progress > 0 ? " · 进行中 1" : ""
  }`;
  const title = options.summary !== undefined ? `待办 · ${options.summary}` : "待办";
  const titleBudget = Math.max(1, width - visibleWidth(progress) - 3);
  const header = `${BOLD}${truncatePlain(title, titleBudget)}${RESET} ${DIM}${progress}${RESET}`;

  const line = (todo: Todo): string =>
    `  ${renderTodoLine(todo, Math.max(1, width - 2), {
      ...(todo.status === "in_progress" && options.shimmer !== undefined
        ? { shimmer: options.shimmer }
        : {}),
    })}`;

  // 折叠态：放得下就全放（调用方据此不画展开按钮），放不下只留"现在在干什么"。
  if (options.collapsed === true) {
    const room = Math.max(1, TODO_COLLAPSED_LINES - 1);
    if (todos.length <= room) return [header, ...todos.map(line)];
    const active = todos.find((todo) => todo.status === "in_progress") ?? todos[0]!;
    return [header, line(active)];
  }

  const budget = maxLines - 1; // 标题占一行
  let shown: Todo[];
  let hidden: number;

  if (todos.length <= budget) {
    shown = [...todos];
    hidden = 0;
  } else {
    // 超长时：先按原顺序取窗口，但如果进行中的那项被切掉了，把它钉回第一行 ——
    // 面板看不到"现在在干什么"就失去意义了。
    const room = budget - 1; // 留一行给溢出提示
    shown = todos.slice(0, room);
    const active = todos.find((todo) => todo.status === "in_progress");
    if (active !== undefined && !shown.includes(active)) {
      shown = [active, ...todos.filter((todo) => todo !== active).slice(0, room - 1)];
    }
    hidden = todos.length - shown.length;
  }

  const lines = [header];
  for (const todo of shown) lines.push(line(todo));
  if (hidden > 0) {
    lines.push(`${DIM}  … 还有 ${hidden} 项${RESET}`);
  }
  return lines;
}

/**
 * transcript 里的 todo_write 只留一行摘要。
 * 完整列表交给 sticky 面板 —— 同一份清单出现两次只会让人分心。
 */
export function renderTodoTool(item: ToolItem, width: number): string[] {
  const args = item.args as { summary?: unknown; todos?: unknown } | null;
  const raw = args?.todos;
  const todos = tryParseTodos(raw);

  if (todos === undefined) {
    // 参数畸形或被拒绝：如实说明，不要假装成功
    const note = item.done && !item.ok ? item.output.split("\n")[0] ?? "" : "参数无效";
    return [`${fg(COLOR.error)}⏺ todo_write${RESET} ${DIM}${truncateAnsi(note, 60)}${RESET}`];
  }

  const counts = countTodos(todos);
  const parts: string[] = [];
  if (counts.in_progress > 0) parts.push(`${counts.in_progress} 进行中`);
  if (counts.completed > 0) parts.push(`${counts.completed} 已完成`);
  if (counts.pending > 0) parts.push(`${counts.pending} 待办`);
  const summary =
    typeof args?.summary === "string" && args.summary.trim().length > 0
      ? ` · ${args.summary.trim()}`
      : "";

  const line = `⏺ todo_write${summary} · 共 ${todos.length} 项${
    parts.length > 0 ? ` · ${parts.join(" · ")}` : ""
  }`;
  return [
    `${fg(COLOR.tool)}${truncateAnsi(line, Math.max(1, width))}${RESET}`,
  ];
}
