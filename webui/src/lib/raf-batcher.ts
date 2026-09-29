/** 流式 token 批处理：收到增量先进缓冲区，requestAnimationFrame 每帧最多刷新一次
 *  （主 spec §7.2 第 3 条）。无 rAF 环境（测试/headless）退化为立即刷新。 */
export function createRafBatcher(flush: () => void): {
  schedule(): void;
  flushNow(): void;
} {
  let scheduled = false;
  const raf: ((cb: () => void) => unknown) | undefined =
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined;
  return {
    schedule() {
      if (scheduled) return;
      scheduled = true;
      if (raf) {
        raf(() => {
          scheduled = false;
          flush();
        });
      } else {
        scheduled = false;
        flush();
      }
    },
    flushNow() {
      scheduled = false;
      flush();
    },
  };
}
