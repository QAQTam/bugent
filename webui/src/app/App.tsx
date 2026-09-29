import { useEffect, useRef } from 'react';
import { useSessions, flushNow } from '../store/sessions';
import { TabBar } from '../components/tabs/TabBar';
import { MessageList } from '../components/messages/MessageList';
import { TodoPanel } from '../components/todo/TodoPanel';
import { Composer } from '../components/composer/Composer';
import { FpsPanel } from '../dev/FpsPanel';
import { zh } from '../i18n/zh';
import type { AgentTransport } from '../transport/types';

let seq = 0;
function nextSessionId(): string {
  seq += 1;
  return `s-local-${seq}`;
}

/** 全局布局（主 spec §1.2）：标签栏 / 消息区 / Todo+输入框。无左侧 session 列表。 */
export function App({ transport }: { transport: AgentTransport }) {
  const order = useSessions((s) => s.order);
  const sessions = useSessions((s) => s.sessions);
  const activeId = useSessions((s) => s.activeId);
  const connected = useSessions((s) => s.connected);
  const reconnectAttempt = useSessions((s) => s.reconnectAttempt);

  const transportRef = useRef(transport);
  transportRef.current = transport;

  // 初始标签
  useEffect(() => {
    if (useSessions.getState().order.length === 0) {
      useSessions.getState().newSession(nextSessionId());
    }
  }, []);

  // transport 事件 → store；权限按钮 → transport（用 window 事件解耦，便于无头测试）
  useEffect(() => {
    const off = transportRef.current.onEvent((sessionId, e) => {
      useSessions.getState().ingest(sessionId, e);
      flushNow();
    });
    const onApprove = (ev: Event) => {
      const detail = (ev as CustomEvent<{ toolId: string; decision: 'allow' | 'deny' | 'always' }>).detail;
      transportRef.current.approveTool(detail.toolId, detail.decision);
    };
    window.addEventListener('webui:approve', onApprove);
    return () => {
      off();
      window.removeEventListener('webui:approve', onApprove);
    };
  }, []);

  // 快捷键：Ctrl/Cmd+T 新建、Ctrl/Cmd+W 关闭、Ctrl/Cmd+数字 切换、Esc 停止
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 't') {
        e.preventDefault();
        useSessions.getState().newSession(nextSessionId());
      } else if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const id = useSessions.getState().activeId;
        if (id) useSessions.getState().closeSession(id);
      } else if (mod && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        const id = useSessions.getState().order[idx];
        if (id) useSessions.getState().setActive(id);
      } else if (e.key === 'Escape') {
        const id = useSessions.getState().activeId;
        if (id) transportRef.current.stop(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const session = activeId !== null ? sessions[activeId] : undefined;
  const streaming = session?.status === 'running' || session?.status === 'waiting';

  const send = () => {
    if (!session) return;
    const text = session.draft;
    if (text.trim() === '') return;
    const st = useSessions.getState();
    st.setDraft(session.id, '');
    // 本地乐观标记运行中（协议侧由 turn.started/turn.done 同步）；
    // 用户消息由 transport 回发（mock 的 message_start / 协议的 user.message），本地不重复渲染
    st.ingest(session.id, { type: 'turn_running' });
    transportRef.current.send(session.id, text);
  };

  return (
    <div className="app">
      <div className="main">
        <TabBar />
        {connected ? null : (
          <div className="conn-bar" role="status" aria-live="polite">
            {zh.reconnecting(reconnectAttempt + 1)}
          </div>
        )}
        {session && (
          <MessageList key={session.id} session={session} />
        )}
        {session?.errorMsg && (
          <div className="notice" data-kind="error" role="alert">
            {session.errorMsg}
          </div>
        )}
        <div className="bottom-dock">
          <div className="dock-inner">
            {session && (
              <TodoPanel
                todos={session.todos}
                expanded={session.todoExpanded}
                onToggle={() => useSessions.getState().toggleTodo(session.id)}
              />
            )}
            {session && (
              <Composer
                draft={session.draft}
                streaming={Boolean(streaming)}
                onChange={(v) => useSessions.getState().setDraft(session.id, v)}
                onSend={send}
                onStop={() => transportRef.current.stop(session.id)}
              />
            )}
          </div>
        </div>
      </div>
      <FpsPanel />
    </div>
  );
}
