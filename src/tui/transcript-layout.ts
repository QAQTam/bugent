/**
 * Transcript 的块级布局缓存。
 *
 * 目标不是“把行数组切片”，而是避免每次渲染都重新解析整段历史：
 *   - 每个 DisplayItem 是一个 block
 *   - block 的渲染结果按 width + itemVersion 缓存
 *   - viewport 只从 block 里抽取可见行
 *
 * 这样流式只让最后一个 block 失效，滚动只做 O(可见行 + block 查找)，
 * 不会每帧重新跑整段 Markdown。
 */

export const HISTORY_WINDOW_MULTIPLIER = 3;

export interface TranscriptLayoutBlock<T> {
  item: T;
  /** 在完整行空间里的起始下标。 */
  start: number;
  /** 结束下标，exclusive。包含 block 末尾的分隔空行。 */
  end: number;
  /** 内容最后一行的下标，inclusive；不含分隔空行。 */
  contentEnd: number;
  /** 已渲染行 + 一个分隔空行。 */
  lines: readonly string[];
  /** 吸顶用头部。 */
  header: string;
  callId?: string;
}

export interface TranscriptLayoutWindow<T> {
  lines: string[];
  /** 窗口在完整行空间里的起始下标。 */
  start: number;
  /** 与窗口相交的 block。 */
  blocks: readonly TranscriptLayoutBlock<T>[];
}

interface CacheEntry {
  version: string | number;
  width: number;
  lines: readonly string[];
  contentLineCount: number;
}

export class TranscriptLayout<T extends object> {
  #cache = new WeakMap<T, CacheEntry>();
  #blocks: TranscriptLayoutBlock<T>[] = [];
  #totalLines = 0;
  #width = -1;
  #globalVersion: string | number | undefined;
  #itemsRef: readonly T[] | undefined;

  get totalLines(): number {
    return this.#totalLines;
  }

  get blocks(): readonly TranscriptLayoutBlock<T>[] {
    return this.#blocks;
  }

  /**
   * 重建 block 索引；未变化的 item 直接复用缓存行。
   *
   * `versionOf` 必须覆盖所有会影响该 item 渲染结果的状态，例如
   * assistant 文本长度、tool progress、expanded、todo shimmer 相位。
   */
  update(
    items: readonly T[],
    width: number,
    versionOf: (item: T, index: number) => string | number,
    renderItem: (item: T, width: number) => string[],
    options: {
      globalVersion?: string | number;
      callIdOf?: (item: T) => string | undefined;
    } = {},
  ): void {
    const globalVersion = options.globalVersion;

    // 纯滚动帧没有内容变化：items 引用和全局版本都没变时直接复用 block。
    if (
      globalVersion !== undefined &&
      items === this.#itemsRef &&
      width === this.#width &&
      globalVersion === this.#globalVersion
    ) {
      return;
    }

    if (width !== this.#width) {
      this.#cache = new WeakMap();
      this.#width = width;
    }
    this.#globalVersion = globalVersion;
    this.#itemsRef = items;

    const blocks: TranscriptLayoutBlock<T>[] = [];
    let cursor = 0;

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const version = versionOf(item, index);
      let cached = this.#cache.get(item);
      if (cached === undefined || cached.version !== version || cached.width !== width) {
        const rendered = renderItem(item, width);
        cached = {
          version,
          width,
          lines: [...rendered, ""],
          contentLineCount: rendered.length,
        };
        this.#cache.set(item, cached);
      }

      const callId = options.callIdOf?.(item);
      const contentEnd =
        cached.contentLineCount > 0 ? cursor + cached.contentLineCount - 1 : cursor - 1;
      blocks.push({
        item,
        start: cursor,
        end: cursor + cached.lines.length,
        contentEnd,
        lines: cached.lines,
        header: cached.lines[0] ?? "",
        ...(callId !== undefined ? { callId } : {}),
      });
      cursor += cached.lines.length;
    }

    this.#blocks = blocks;
    this.#totalLines = cursor;
  }

  /** 按“距底部多少行”取出窗口，并把短内容补齐到 height。 */
  window(height: number, scrollOffset: number): TranscriptLayoutWindow<T> {
    const safeHeight = Math.max(0, Math.floor(height));
    if (safeHeight === 0) return { lines: [], start: 0, blocks: [] };

    const total = this.#totalLines;
    if (total <= safeHeight) {
      const lines = this.#sliceLines(0, total);
      while (lines.length < safeHeight) lines.push("");
      return { lines, start: 0, blocks: this.#blocks.slice() };
    }

    const offset = Math.max(0, Math.floor(scrollOffset));
    const end = offset === 0 ? total : Math.max(safeHeight, total - offset);
    const start = Math.max(0, end - safeHeight);
    const lines = this.#sliceLines(start, end);

    const blocks: TranscriptLayoutBlock<T>[] = [];
    let index = this.#firstBlockEndingAfter(start);
    for (; index < this.#blocks.length; index += 1) {
      const block = this.#blocks[index]!;
      if (block.start >= end) break;
      blocks.push(block);
    }

    // 吸顶：窗口起点落在某个 block 内部时，把 block 头部覆盖到第一行。
    if (start > 0 && lines.length > 0) {
      const covering = blocks.find((block) => start > block.start && start <= block.contentEnd);
      if (covering !== undefined && covering.header.length > 0) lines[0] = covering.header;
    }

    return { lines, start, blocks };
  }

  #firstBlockEndingAfter(line: number): number {
    let low = 0;
    let high = this.#blocks.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const block = this.#blocks[mid]!;
      if (block.end <= line) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  #sliceLines(start: number, end: number): string[] {
    const lines: string[] = [];
    let index = this.#firstBlockEndingAfter(start);
    for (; index < this.#blocks.length; index += 1) {
      const block = this.#blocks[index]!;
      if (block.start >= end) break;
      const from = Math.max(start, block.start) - block.start;
      const to = Math.min(end, block.end) - block.start;
      lines.push(...block.lines.slice(from, to));
    }
    return lines;
  }
}

/**
 * 主消息区允许回看的上限。
 *
 * `3 * height` 是“最多保留三屏历史”的产品约束；滑到这个上限后，
 * 更早内容仍在内存/数据库中，只是不在主视窗里渲染。
 */
export function maxScrollOffset(
  totalLines: number,
  height: number,
  multiplier = HISTORY_WINDOW_MULTIPLIER,
): number {
  const safeHeight = Math.max(0, Math.floor(height));
  if (safeHeight === 0) return 0;
  const total = Math.max(0, Math.floor(totalLines));
  const historyLines = Math.min(total, safeHeight * Math.max(1, multiplier));
  return Math.max(0, historyLines - safeHeight);
}
