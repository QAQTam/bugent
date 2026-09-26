/**
 * 轻量行级 diff。
 *
 * 用途：write_file / edit_file 之后给出一份变更视图 ——
 * 既让模型能自我核对，也让用户在 TUI 里看清改了什么。
 *
 * 实现是朴素的 LCS 动态规划，所以有行数上限保护：
 * 超大文件直接退化成"行数摘要"，绝不为了好看把内存打爆。
 */

/** 超过这个行数就不做逐行 diff（DP 表是 O(n*m) 的）。 */
export const MAX_DIFF_LINES = 800;

/** 变更点上下保留的上下文行数。 */
export const DIFF_CONTEXT = 3;

export interface DiffLine {
  kind: " " | "-" | "+";
  text: string;
  /**
   * 1-based：这一行在**改动前**文件里的行号（`+` 行没有）。
   *
   * 行号必须在 `diffLines` 里就绑到行上，不能等渲染时按下标算 —— `compactDiff`
   * 会把远处上下文整段裁掉并插省略标记，渲染列表的下标和文件行号早就不一致了。
   */
  before?: number;
  /** 1-based：这一行在**改动后**文件里的行号（`-` 行没有）。 */
  after?: number;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    // 退化摘要没有对应的真实行，两边行号都留空
    return [
      { kind: "-", text: `(original has ${a.length} lines; over ${MAX_DIFF_LINES}, so no line-by-line diff)` },
      { kind: "+", text: `(新内容 ${b.length} 行)` },
    ];
  }

  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i]!, before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "-", text: a[i]!, before: i + 1 });
      i += 1;
    } else {
      out.push({ kind: "+", text: b[j]!, after: j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: "-", text: a[i]!, before: i + 1 });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: "+", text: b[j]!, after: j + 1 });
    j += 1;
  }

  return out;
}

/** 统计增删行数。 */
export function diffStat(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "+") added += 1;
    else if (line.kind === "-") removed += 1;
  }
  return { added, removed };
}

/**
 * 裁掉远离变更点的上下文，并在断开处插入 `⋯` 标记。
 *
 * 这样 2000 行的文件改 1 行，diff 也只有几行 ——
 * 直接给模型看很有用，TUI 里也不会糊满屏幕。
 *
 * 保留的行**原样透传**（含 `before` / `after` 行号）：省略掉的是行，不是行号，
 * 裁剪后剩下的行号仍然指向真实文件行。省略标记自己没有任何行号。
 */
export function compactDiff(lines: readonly DiffLine[], context = DIFF_CONTEXT): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.kind === " ") continue;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k += 1) {
      keep[k] = true;
    }
  }

  if (!keep.some(Boolean)) return []; // 完全没变

  const out: DiffLine[] = [];
  let skipped = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (keep[i] === true) {
      if (skipped > 0) {
        out.push({ kind: " ", text: `⋯ 省略 ${skipped} 行未变更内容` });
        skipped = 0;
      }
      out.push(lines[i]!);
    } else {
      skipped += 1;
    }
  }
  if (skipped > 0) out.push({ kind: " ", text: `⋯ 省略 ${skipped} 行未变更内容` });

  return out;
}

/** 渲染成 `<旧行号> <新行号> +/- 正文` 的文本（给模型看，也给 TUI 折叠）。 */
export function formatDiff(lines: readonly DiffLine[], header?: string): string {
  const stat = diffStat(lines);
  const head = header ?? `+${stat.added} -${stat.removed}`;
  const width = gutterWidth(lines);
  const startsAt = new Map(hunkRanges(lines).map((range) => [range.start, range]));

  const body: string[] = [];
  for (const [index, line] of lines.entries()) {
    const range = startsAt.get(index);
    if (range !== undefined) body.push(hunkHeader(lines, range));
    body.push(`${formatGutter(line, width)}${line.kind}${line.text}`);
  }
  return body.length > 0 ? `${head}\n${body.join("\n")}` : head;
}

/** 一个 hunk 在 `lines` 里的范围（左闭右开）。 */
interface HunkRange {
  start: number;
  end: number;
}

/**
 * 把 diff 切成 hunk：**连续带行号**的行算一段，`⋯ 省略 N 行` 那种没有行号的
 * 行是分界。只保留含增删的段 —— 全是上下文的一段不是 hunk，给它加 `@@` 头
 * 会让人以为那里改了东西。
 *
 * 用"有没有行号"而不是"文本像不像省略标记"来分界：前者是结构，后者是文案。
 */
function hunkRanges(lines: readonly DiffLine[]): HunkRange[] {
  const ranges: HunkRange[] = [];
  let start = -1;
  let changed = false;

  const flush = (end: number): void => {
    if (start >= 0 && changed) ranges.push({ start, end });
    start = -1;
    changed = false;
  };

  for (const [index, line] of lines.entries()) {
    if (line.before === undefined && line.after === undefined) {
      flush(index);
      continue;
    }
    if (start < 0) start = index;
    if (line.kind !== " ") changed = true;
  }
  flush(lines.length);
  return ranges;
}

/**
 * `@@ -3,7 +3,8 @@`：这个 hunk 在改动前/后文件里各占哪一段。
 *
 * 起止取自 hunk 内第一条带行号的行；纯新增（没有任何旧行号）时旧侧退化成
 * `-0,0`，与 git 对新文件的写法一致。
 */
function hunkHeader(lines: readonly DiffLine[], range: HunkRange): string {
  let oldStart = 0;
  let oldCount = 0;
  let newStart = 0;
  let newCount = 0;

  for (let index = range.start; index < range.end; index += 1) {
    const line = lines[index]!;
    if (line.before !== undefined) {
      if (oldCount === 0) oldStart = line.before;
      oldCount += 1;
    }
    if (line.after !== undefined) {
      if (newCount === 0) newStart = line.after;
      newCount += 1;
    }
  }

  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

/**
 * 行号列宽。
 *
 * 没有任何行号时返回 0（不画行号列）—— 超大文件的退化摘要、以及调用方手工
 * 拼的 DiffLine 都是这种，它们保持老格式，读的人不会看到一列空格。
 */
function gutterWidth(lines: readonly DiffLine[]): number {
  let max = 0;
  for (const line of lines) {
    if (line.before !== undefined) max = Math.max(max, line.before);
    if (line.after !== undefined) max = Math.max(max, line.after);
  }
  return max === 0 ? 0 : Math.max(2, String(max).length);
}

/**
 * `旧 新 ` 两列（各自右对齐）。
 *
 * 为什么是两列而不是一列：替换时 `-` / `+` 是**同一个位置**，只给一列会让人
 * 以为动了两行。某侧没有行号时留空 —— 列宽固定，行号才对得齐。
 */
function formatGutter(line: DiffLine, width: number): string {
  if (width === 0) return "";
  const before = line.before === undefined ? "" : String(line.before);
  const after = line.after === undefined ? "" : String(line.after);
  return `${before.padStart(width)} ${after.padStart(width)} `;
}

/* ------------------------------------------------------------------ */
/* 从已渲染的文本反解                                                   */
/* ------------------------------------------------------------------ */

/** 反解出来的一行：行号列（原样保留，供渲染层复用） + 标记 + 正文。 */
export interface DiffBodyLine {
  kind: " " | "-" | "+";
  text: string;
  /** 行号列的原始文本（含尾随空格）；没有行号列时 undefined。 */
  gutter?: string;
  before?: number;
  after?: number;
}

/**
 * diff 正文行的规范形式：`[旧行号] [新行号] <标记><正文>`。
 *
 * 行号列是**可选**的：改这个格式之前落库的输出（`+foo` / ` foo`）没有它，
 * `--resume` 之后仍然要能读。判定只看左侧 —— 吃掉「只由数字和空格组成、
 * 至少含一个数字、以空格结尾」的前缀，剩下的第一个字符就是标记。
 *
 * 已知边界：正文本身以 `<数字> <数字> …` 开头时会被当成行号列（上下文行
 * ` 42 43 items` 就是）。代价只是那一行的行号列错位，**标记永远判对**，
 * 所以 `parseDiffStat` 与徽标不受影响；`⋯ 省略 N 行` 这类以 `⋯` 开头的行
 * 根本不匹配，直接返回 undefined。
 */
const DIFF_BODY = /^(?:([ \d]*\d[ \d]*) )?([ +-])(.*)$/;

export function parseDiffLine(line: string): DiffBodyLine | undefined {
  const match = DIFF_BODY.exec(line);
  if (match === null) return undefined;
  const kind = match[2] as " " | "-" | "+";
  const text = match[3] ?? "";
  const gutter = match[1];
  if (gutter === undefined) return { kind, text };

  const columns = gutter.split(/\s+/).filter((part) => part.length > 0);
  const oldText = columns.length > 1 ? columns[0] : kind === "-" ? columns[0] : undefined;
  const newText = columns.length > 1 ? columns[1] : kind === "-" ? undefined : columns[0];
  return {
    kind,
    text,
    gutter: `${gutter} `,
    ...(oldText !== undefined ? { before: Number(oldText) } : {}),
    ...(newText !== undefined ? { after: Number(newText) } : {}),
  };
}

export interface DiffStat {
  added: number;
  removed: number;
}

/**
 * 从 `formatDiff` 产出的文本里数出 +N / -M。
 *
 * 为什么可以"反解"而不是额外传字段：
 *   - `compactDiff` 只裁掉**未变更**的上下文行，`+`/`-` 一行都不会少，
 *     所以数出来的就是真实增删数；
 *   - 工具输出本来就是 diff 的规范文本，没必要再造一个字段
 *     让 UI 和模型看到两份可能不一致的数据。
 *
 * 首行是摘要（如"已编辑 a.ts（替换 1 处）"），从第二行开始数。
 * 没有实际变更（只有摘要）时返回 undefined。
 *
 * 标记的判定与渲染层共用 `parseDiffLine` —— 行号列加进来时，两边一起跟着走，
 * 不会出现"渲染认、计数不认"导致徽标静默变 0。
 */
export function parseDiffStat(text: string): DiffStat | undefined {
  const lines = text.split("\n");
  if (lines.length < 2) return undefined;

  let added = 0;
  let removed = 0;

  for (let i = 1; i < lines.length; i += 1) {
    const parsed = parseDiffLine(lines[i]!);
    if (parsed === undefined) continue;
    if (parsed.kind === "+") added += 1;
    else if (parsed.kind === "-") removed += 1;
  }

  return added === 0 && removed === 0 ? undefined : { added, removed };
}

/** 渲染成 `+12 -3` 这样的徽标文本（不含颜色，宽度可算）。 */
export function formatDiffStat(stat: DiffStat): string {
  const parts: string[] = [];
  if (stat.added > 0) parts.push(`+${stat.added}`);
  if (stat.removed > 0) parts.push(`-${stat.removed}`);
  return parts.join(" ");
}
