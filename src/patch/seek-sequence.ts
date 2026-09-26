import type { ApplyPatchFileUpdateMode } from "./types.ts";

function normaliseLine(line: string): string {
  return [...line.trim()]
    .map((char) => {
      if (["\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212"].includes(char)) {
        return "-";
      }
      if (["\u2018", "\u2019", "\u201a", "\u201b"].includes(char)) return "'";
      if (["\u201c", "\u201d", "\u201e", "\u201f"].includes(char)) return '"';
      if (
        [
          "\u00a0",
          "\u2002",
          "\u2003",
          "\u2004",
          "\u2005",
          "\u2006",
          "\u2007",
          "\u2008",
          "\u2009",
          "\u200a",
          "\u202f",
          "\u205f",
          "\u3000",
        ].includes(char)
      ) {
        return " ";
      }
      return char;
    })
    .join("");
}

export function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  eof: boolean,
  mode: ApplyPatchFileUpdateMode = "normalize-lf",
): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;

  /*
   * EOF 标记允许"从行尾锚定"，但**不能越过本次的行游标**：之前
   * normalize-lf 分支直接丢弃 start，EOF chunk 可以匹配到游标之前的区域，
   * 与前序 chunk 的替换区间重叠 —— 反向 splice 用过期下标互相覆盖，文件
   * 被静默改坏。两种模式统一用 max(start, 末尾锚点)。
   */
  const searchStart =
    eof && lines.length >= pattern.length ? Math.max(start, lines.length - pattern.length) : start;

  const lastStart = lines.length - pattern.length;
  if (searchStart > lastStart) return undefined;

  // 第一轮：字节级完全一致，取游标后第一处（精确匹配不要求唯一 ——
  // 相同行重复出现时取第一处是 patch 格式的既定语义）。
  for (let i = searchStart; i <= lastStart; i += 1) {
    if (pattern.every((line, index) => lines[i + index] === line)) return i;
  }

  /*
   * BUG-011：模糊升级（trimEnd → trim → unicode 归一）**必须在文件内唯一命中**
   * 才允许落点。之前取第一处命中 —— 缩进写错时补丁会静默改到另一段"恰好
   * 去掉空白后相同"的代码上，无任何报错。多义即拒绝，让模型补上下文。
   */
  const fuzzyPasses: ((line: string) => string)[] = [
    (line) => line.trimEnd(),
    (line) => line.trim(),
    normaliseLine,
  ];
  for (const normalise of fuzzyPasses) {
    const matches: number[] = [];
    for (let i = searchStart; i <= lastStart; i += 1) {
      if (pattern.every((line, index) => normalise(lines[i + index]!) === normalise(line))) {
        matches.push(i);
      }
    }
    if (matches.length === 1) return matches[0]!;
  }
  return undefined;
}
