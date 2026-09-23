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
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      { kind: "-", text: `(原内容 ${a.length} 行，超过 ${MAX_DIFF_LINES} 行不做逐行 diff)` },
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
      out.push({ kind: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "-", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "+", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: "-", text: a[i]! });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: "+", text: b[j]! });
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

/** 渲染成带 +/- 前缀的文本（给模型看，也给 TUI 折叠）。 */
export function formatDiff(lines: readonly DiffLine[], header?: string): string {
  const stat = diffStat(lines);
  const head = header ?? `+${stat.added} -${stat.removed}`;
  const body = lines.map((line) => `${line.kind}${line.text}`).join("\n");
  return body.length > 0 ? `${head}\n${body}` : head;
}
