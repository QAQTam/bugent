import { memo, useEffect, useRef, useState } from 'react';

/** 开发环境 FPS/渲染耗时面板（主 spec §7.2 + 附加件 §8：含同屏玻璃元素数）。Ctrl+Shift+P 开关。 */

export const FpsPanel = memo(function FpsPanel() {
  const [visible, setVisible] = useState(false);
  const [fps, setFps] = useState(0);
  const [longFrame, setLongFrame] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!visible) return;
    let frames = 0;
    let last = performance.now();
    let worst = 0;
    let raf = 0;
    const tick = (now: number) => {
      frames += 1;
      const delta = now - last;
      if (delta > worst) worst = delta;
      last = now;
      if (delta >= 1000) {
        setFps(Math.round((frames * 1000) / delta));
        setLongFrame(Math.round(worst));
        frames = 0;
        worst = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  if (!visible) return null;
  const glassCount = document.querySelectorAll('.glass-surface, [class*="liquid-glass"], [data-glass]').length;
  return (
    <div className="fps-panel" aria-hidden>
      <div>{fps} fps</div>
      <div>long {longFrame}ms</div>
      <div>glass {glassCount}</div>
    </div>
  );
});
