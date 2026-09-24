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

  const searchStart =
    eof && lines.length >= pattern.length
      ? mode === "preserve-line-endings"
        ? Math.max(start, lines.length - pattern.length)
        : lines.length - pattern.length
      : start;

  const lastStart = lines.length - pattern.length;
  if (searchStart > lastStart) return undefined;

  for (let i = searchStart; i <= lastStart; i += 1) {
    if (pattern.every((line, index) => lines[i + index] === line)) return i;
  }
  for (let i = searchStart; i <= lastStart; i += 1) {
    if (pattern.every((line, index) => lines[i + index]!.trimEnd() === line.trimEnd())) return i;
  }
  for (let i = searchStart; i <= lastStart; i += 1) {
    if (pattern.every((line, index) => lines[i + index]!.trim() === line.trim())) return i;
  }
  for (let i = searchStart; i <= lastStart; i += 1) {
    if (pattern.every((line, index) => normaliseLine(lines[i + index]!) === normaliseLine(line))) {
      return i;
    }
  }
  return undefined;
}
