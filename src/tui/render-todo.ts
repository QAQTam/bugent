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
import { truncateAnsi } from "./ansi.ts";
import { COLOR } from "./theme.ts";
import type { ToolItem } from "./renderers.ts";
import { countTodos, tryParseTodos, type Todo, type TodoStatus } from "../tools/todo.ts";

export const TODO_MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

const STATUS_COLOR: Record<TodoStatus, string> = {
  pending: COLOR.todoPending,
  in_progress: COLOR.todoActive,
  completed: COLOR.todoDone,
};

/** 单条待办的一行。sticky 面板与 transcript 共用同一套外观。 */
export function renderTodoLine(todo: Todo, width: number): string {
  const marker = TODO_MARKERS[todo.status];
  const color = STATUS_COLOR[todo.status];
  const text =
    todo.status === "in_progress" && todo.activeForm !== undefined ? todo.activeForm : todo.content;

  const decoration = todo.status === "completed" ? DIM : todo.status === "in_progress" ? BOLD : "";
  return `${fg(color)}${marker}${RESET} ${decoration}${truncateAnsi(text, Math.max(1, width - 4))}${RESET}`;
}

export interface TodoPanelOptions {
  /** 面板最多占几行（含标题）。 */
  maxLines?: number;
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
  const header = `${BOLD}待办${RESET} ${DIM}${counts.completed}/${todos.length}${
    counts.in_progress > 0 ? ` · 进行中 1` : ""
  }${RESET}`;

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
  for (const todo of shown) {
    lines.push(`  ${renderTodoLine(todo, Math.max(1, width - 2))}`);
  }
  if (hidden > 0) {
    lines.push(`${DIM}  … 还有 ${hidden} 项${RESET}`);
  }
  return lines;
}

/**
 * transcript 里的 todo_write 只留一行摘要。
 * 完整列表交给 sticky 面板 —— 同一份清单出现两次只会让人分心。
 */
export function renderTodoTool(item: ToolItem, _width: number): string[] {
  const raw = (item.args as { todos?: unknown } | null)?.todos;
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

  return [
    `${fg(COLOR.tool)}⏺${RESET} ${BOLD}todo_write${RESET} ${DIM}共 ${todos.length} 项${
      parts.length > 0 ? ` · ${parts.join(" · ")}` : ""
    }${RESET}`,
  ];
}
