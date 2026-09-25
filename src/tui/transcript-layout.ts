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

/**
 * 主视图**至少**能回看到的行数。
 *
 * 三屏是按比例定的，短终端上退化得离谱：12 行终端正文只有 5 行，三屏 = 15 行 ——
 * 稍长一点的一轮对话就整块掉进"早期消息"，主视图根本读不到。实测 69 行内容里
 * 有 54 行（78%）一进来就够不着。
 *
 * 所以再压一个绝对下限：主视图至少覆盖 100 行，更早的才交给历史抽屉。
 * 两个取大 —— 大终端仍按三屏走，小终端被这条兜住。
 */
export const HISTORY_MIN_LINES = 100;

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
 * 窗口大小取 `三屏` 与 `HISTORY_MIN_LINES` 的**较大者**：大终端上三屏就够宽，
 * 短终端上三屏会窄到没法用，由绝对下限兜住。滑到上限后，更早的内容仍在内存/
 * 数据库里，只是不在主视窗里渲染 —— 那才是"早期消息"，走历史抽屉看。
 */
export function maxScrollOffset(
  totalLines: number,
  height: number,
  multiplier = HISTORY_WINDOW_MULTIPLIER,
): number {
  const safeHeight = Math.max(0, Math.floor(height));
  if (safeHeight === 0) return 0;
  const total = Math.max(0, Math.floor(totalLines));
  const windowLines = Math.max(safeHeight * Math.max(1, multiplier), HISTORY_MIN_LINES);
  const historyLines = Math.min(total, windowLines);
  return Math.max(0, historyLines - safeHeight);
}

/** 主视图能覆盖到的行数（回看上限 + 一屏），不会超过总行数。 */
export function reachableLines(totalLines: number, height: number): number {
  const safeHeight = Math.max(0, Math.floor(height));
  const total = Math.max(0, Math.floor(totalLines));
  return Math.min(total, maxScrollOffset(total, safeHeight) + safeHeight);
}

/* ------------------------------------------------------------------ */
/* 长回答保护                                                           */
/* ------------------------------------------------------------------ */
/*
 * 为什么**没有**"折叠更早的工具卡片"这条策略。
 *
 * 它看起来天经地义（工具卡片是过程、作答是结果），但数学上是恒等变换：
 * 窗口钉底，显示 [T-H, T)；作答占 [s, e]；完整可见的判据是 s >= T-H。
 * 把上方某张卡片折叠掉 k 行后 s' = s-k、T' = T-k，判据变成
 *   s-k >= (T-k)-H  ⟺  s >= T-H
 * —— 一模一样。上方内容折叠多少都不影响作答可见性。
 *
 * 真正决定成败的只有一件事：**作答自己的行数 vs 视口高度**。放不下就是放不下，
 * 只能靠 assistantAnchorOffset 把视口挪到作答开头。

/**
 * 长回答保护只需要这些信息 —— 与具体条目类型无关，所以这里刻意不依赖泛型 T。
 */
export interface FoldableBlock {
  /** 条目种类；只有 "assistant" 会被当成保护目标。 */
  readonly kind: string;
  /** 在完整行空间里的起始下标。 */
  readonly start: number;
  /** 内容最后一行的下标，inclusive。 */
  readonly contentEnd: number;
}

/** 把布局 block 投影成决策需要的形状。 */
export function toFoldableBlocks(
  blocks: readonly { item: { kind: string }; start: number; contentEnd: number }[],
): FoldableBlock[] {
  return blocks.map((block) => ({
    kind: block.item.kind,
    start: block.start,
    contentEnd: block.contentEnd,
  }));
}

/** 最后一条 assistant 在 blocks 里的下标；没有则 undefined。 */
export function lastAssistantIndex(blocks: readonly FoldableBlock[]): number | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]!.kind === "assistant") return index;
  }
  return undefined;
}

/**
 * 视口要不要钉在最后一条 assistant 的开头。
 *
 * 返回 `window()` 用的偏移；0 表示照常钉底。只在用户处于"跟随最新"
 * （`scrollOffset === 0`）时生效 —— 用户自己滚上去看历史时不该被拽回来。
 *
 * 折叠腾够了的话块开头本来就可见，这里返回 0，两者自然不冲突。
 */
export function assistantAnchorOffset(
  blocks: readonly FoldableBlock[],
  totalLines: number,
  viewportHeight: number,
  scrollOffset: number,
): number {
  if (scrollOffset !== 0) return 0;

  const index = lastAssistantIndex(blocks);
  if (index === undefined) return 0;

  const block = blocks[index]!;
  if (block.start >= totalLines - viewportHeight) return 0;
  return Math.max(0, totalLines - block.start - viewportHeight);
}

/**
 * 主视图为了"能读到最后一条作答的开头"，至少必须允许回看到哪里。
 *
 * 三屏上限（`HISTORY_WINDOW_MULTIPLIER`）是产品约束，但它和"必须能读完整条作答"
 * 会冲突：一条比视口高得多的作答，它的开头可能落在三屏之外。这里给出的下限
 * 会被 `maxScrollOffset` 取大，所以作答的开头永远够得着。
 *
 * 作答本来就放得下时返回 0，上限保持原样。
 */
export function assistantScrollFloor(
  blocks: readonly FoldableBlock[],
  totalLines: number,
  viewportHeight: number,
): number {
  return assistantAnchorOffset(blocks, totalLines, viewportHeight, 0);
}
