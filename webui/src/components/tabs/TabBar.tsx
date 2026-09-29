import { memo, useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useSessions, type SessionStatus } from '../../store/sessions';
import { zh } from '../../i18n/zh';
import { GlassSurface } from '../GlassSurface';

/** 顶部标签栏（主 spec §2）。每个标签 = 一个会话；选中态是滑动玻璃块（A 档）。 */

interface TabInfo {
  id: string;
  title: string;
  status: SessionStatus;
  unread: boolean;
}

function dotStatus(t: TabInfo): string {
  if (t.status === 'waiting') return 'waiting';
  if (t.status === 'error') return 'error';
  if (t.status === 'running') return 'running';
  if (t.unread) return 'unread';
  return 'idle';
}

export const TabBar = memo(function TabBar() {
  const order = useSessions((s) => s.order);
  const sessions = useSessions((s) => s.sessions);
  const activeId = useSessions((s) => s.activeId);
  const setActive = useSessions((s) => s.setActive);
  const closeSession = useSessions((s) => s.closeSession);
  const newSession = useSessions((s) => s.newSession);

  const tabs: TabInfo[] = order.map((id) => sessions[id]!);
  const [editing, setEditing] = useState<string | null>(null);

  // 选中玻璃块的平移（白名单：平移 200ms，折射参数不变）
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list || !activeId) return;
    const el = list.querySelector<HTMLElement>(`[data-tab="${CSS.escape(activeId)}"]`);
    if (!el) {
      setIndicator(null);
      return;
    }
    setIndicator({ x: el.offsetLeft, w: el.offsetWidth });
  }, [activeId, order.length]);

  const commitRename = (id: string, value: string) => {
    const t = value.trim();
    if (t) useSessions.getState().rename(id, t);
    setEditing(null);
  };

  return (
    <GlassSurface tier="B" className="tabbar" radius="sm">
      <div className="tabs" ref={listRef} role="tablist" aria-label={zh.tabNew}>
        {indicator !== null && (
          <GlassSurface
            tier="A"
            radius="sm"
            style={{
              position: 'absolute',
              left: 0,
              top: 6,
              height: 30,
              width: indicator.w,
              transform: `translateX(${indicator.x}px)`,
              transition: 'transform 200ms var(--ease-out)',
              pointerEvents: 'none',
            }}
          />
        )}
        {tabs.map((t) => (
          <div
            key={t.id}
            data-tab={t.id}
            role="tab"
            aria-selected={t.id === activeId}
            data-selected={t.id === activeId}
            className="tab"
            onDoubleClick={() => setEditing(t.id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeSession(t.id);
              }
            }}
            onClick={() => setActive(t.id)}
          >
            <span className="dot" data-status={dotStatus(t)} />
            {editing === t.id ? (
              <input
                autoFocus
                defaultValue={t.title}
                onBlur={(e) => commitRename(t.id, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(t.id, e.currentTarget.value);
                  if (e.key === 'Escape') setEditing(null);
                }}
                style={{ width: 90, font: 'inherit', border: 'none', background: 'transparent', outline: 'none' }}
              />
            ) : (
              <span className="title">{t.title || ' '}</span>
            )}
            <button
              className="close"
              aria-label={zh.tabClose}
              onClick={(e) => {
                e.stopPropagation();
                closeSession(t.id);
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button className="tab-new" aria-label={zh.tabNew} onClick={() => newSession(`s-${genSessionId()}`)}>
          <Plus size={16} />
        </button>
      </div>
    </GlassSurface>
  );
});

let seq = 0;
function genSessionId(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}
