import { memo, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { zh } from '../../i18n/zh';

/** 输入框（主 spec §6）：多行自适应、Enter 发送、IME 组合输入不误发、流式期间变停止。 */

export const Composer = memo(function Composer({
  draft,
  streaming,
  onChange,
  onSend,
  onStop,
}: {
  draft: string;
  streaming: boolean;
  onChange(value: string): void;
  onSend(): void;
  onStop(): void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [composing, setComposing] = useState(false);

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 176)}px`;
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        placeholder=""
        onChange={(e) => {
          onChange(e.currentTarget.value);
          resize();
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(e) => {
          // IME 组合期间 Enter 不发送（主 spec §6 硬性要求）
          if (e.key === 'Enter' && !e.shiftKey && !composing && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!streaming && draft.trim() !== '') onSend();
          }
        }}
      />
      <button
        className="send-btn"
        aria-label={streaming ? zh.stop : zh.send}
        disabled={!streaming && draft.trim() === ''}
        onClick={() => (streaming ? onStop() : onSend())}
      >
        {streaming ? <Square size={13} /> : <ArrowUp size={16} />}
      </button>
    </div>
  );
});
