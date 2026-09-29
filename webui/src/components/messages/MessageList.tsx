import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import type { MessageVM, SessionVM } from '../../store/sessions';
import { useSessions } from '../../store/sessions';
import { AssistantMessage, UserMessage } from '../tools/ToolBlock';
import { zh } from '../../i18n/zh';

/** 消息区（主 spec §3）：虚拟列表 + 底部跟随（rAF 合并），上滑不打扰。 */

const BOTTOM_THRESHOLD = 80;

export const MessageList = memo(function MessageList({ session }: { session: SessionVM }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const pendingScroll = useRef(false);

  const virtualizer = useVirtualizer({
    count: session.messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    getItemKey: (i) => session.messages[i]!.id,
    overscan: 8,
  });
  const vItems = virtualizer.getVirtualItems();
  // 零尺寸容器（headless/SSR/首帧）测不出可视窗口时退化为全量渲染
  const renderAll = vItems.length === 0 && session.messages.length > 0;

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    pendingScroll.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  // 新内容到来：在底部附近才自动跟随；否则不打扰（主 spec §3.3）
  const lastLen = useRef(0);
  useEffect(() => {
    if (session.messages.length === lastLen.current) return;
    const added = session.messages.length - lastLen.current;
    lastLen.current = session.messages.length;
    if (atBottom) {
      const raf = requestAnimationFrame(() => scrollToBottom(false));
      return () => cancelAnimationFrame(raf);
    }
    void added;
  }, [session.messages.length, atBottom, scrollToBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (pendingScroll.current) {
      pendingScroll.current = false;
      setAtBottom(true);
      useSessions.getState().saveScroll(session.id, el.scrollTop);
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
    setAtBottom(nearBottom);
    useSessions.getState().saveScroll(session.id, el.scrollTop);
  };

  return (
    <div className="scroller" ref={scrollRef} onScroll={onScroll}>
      <div className="content" style={{ position: 'relative' }}>
        {session.messages.length === 0 && (
          <div className="hint" role="note">
            {zh.emptyHint}
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), width: '100%' }}>
          {renderAll
            ? session.messages.map((m, i) => (
                <div key={m.id} data-index={i} className="vitem" style={{ position: 'relative', width: '100%' }}>
                  <MessageView message={m} />
                </div>
              ))
            : vItems.map((item) => (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="vitem"
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                >
                  <MessageView message={session.messages[item.index]!} />
                </div>
              ))}
        </div>
      </div>
      {!atBottom && session.newCount > 0 && (
        <button
          className="to-bottom"
          onClick={() => {
            useSessions.getState().clearUnread(session.id);
            scrollToBottom(true);
          }}
        >
          <ArrowDown size={13} />
          <span>{zh.toBottom}</span>
          <span className="count">{session.newCount}</span>
        </button>
      )}
    </div>
  );
});

const MessageView = memo(function MessageView({ message }: { message: MessageVM }) {
  if (message.role === 'user') {
    const text = message.blocks
      .filter((b): b is Extract<typeof b, { kind: 'text' }> => b.kind === 'text')
      .map((b) => b.text)
      .join('');
    return <UserMessage text={text} />;
  }
  return <AssistantMessage message={message} />;
});
