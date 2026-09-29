import { memo, useState } from 'react';
import { Check, ChevronDown, Circle, Loader2 } from 'lucide-react';
import type { TodoVM } from '../../store/sessions';
import { zh } from '../../i18n/zh';

/** Todo 面板（主 spec §5）：输入框上方托盘；没有 todo 时不渲染（0fr 收起）。
 *  默认只显示 3 条：优先"进行中"那条 + 前后相邻项；全部完成显示最后 3 条。 */

export const TodoPanel = memo(function TodoPanel({
  todos,
  expanded,
  onToggle,
}: {
  todos: TodoVM[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === 'done').length;
  const visible = expanded ? todos : pickCollapsed(todos);
  const rest = todos.length - visible.length;
  return (
    <div className="todo-panel" data-visible="true">
      <div>
        <div className="todo-list-wrap todo-scroll" data-open="true">
          <div>
            <button className="todo-head" onClick={onToggle} aria-expanded={expanded}>
              <span>{zh.todoTitle}</span>
              <span className="progress">{zh.todoProgress(done, todos.length)}</span>
              {rest > 0 && <span className="progress">{zh.todoMore(rest)}</span>}
              <ChevronDown size={13} style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform var(--dur-expand) var(--ease-out)' }} />
            </button>
            <div className="todo-list" data-expanded={expanded}>
              {visible.map((t) => (
                <div key={t.id} className="todo-item" data-status={t.status}>
                  <span className="mark">
                    {t.status === 'done' ? (
                      <Check size={13} />
                    ) : t.status === 'in_progress' ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      <Circle size={11} />
                    )}
                  </span>
                  <span className="label">{t.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

/** 折叠时显示哪 3 条：进行中的那条 + 前后相邻；全部完成取最后 3 条。 */
function pickCollapsed(todos: TodoVM[]): TodoVM[] {
  const idx = todos.findIndex((t) => t.status === 'in_progress');
  if (idx === -1) return todos.slice(-3);
  const allDone = todos.every((t) => t.status === 'done');
  if (allDone) return todos.slice(-3);
  const start = Math.max(0, idx - 1);
  const slice = todos.slice(start, start + 3);
  if (slice.length < 3 && start > 0) slice.unshift(todos[start - 1]!);
  return slice;
}
