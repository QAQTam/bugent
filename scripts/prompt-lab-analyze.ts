#!/usr/bin/env bun
/**
 * 读 prompt-lab 的 results.jsonl 重算统计 —— 统计口径改了就重跑分析，不用重跑模型。
 *
 * 用法：bun run scripts/prompt-lab-analyze.ts <results.jsonl> [--baseline <variant-id>]
 */

import { readFileSync } from "node:fs";

interface Trial {
  variant: string;
  trial: number;
  ms: number;
  reasoning: string;
  content: string;
  error?: string;
}

const file = Bun.argv[2];
if (file === undefined) throw new Error("用法：bun run scripts/prompt-lab-analyze.ts <results.jsonl>");

const baselineIndex = Bun.argv.indexOf("--baseline");
const baselineId = baselineIndex >= 0 ? Bun.argv[baselineIndex + 1]! : undefined;

const rows = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Trial);

const WE_NEED = /\bwe need\b/i;
const LET_ME = /\blet me\b/i;
const I_NEED = /\bi need\b/i;
const WE_SHOULD = /\bwe should\b/i;
const ZH_WE = /我们(要|需要)/;

function statsOf(trials: Trial[]) {
  const ok = trials.filter((trial) => trial.error === undefined);
  const rate = (re: RegExp): number => ok.filter((trial) => re.test(trial.reasoning)).length;
  return {
    n: ok.length,
    errors: trials.length - ok.length,
    weNeed: rate(WE_NEED),
    letMe: rate(LET_ME),
    iNeed: rate(I_NEED),
    weShould: rate(WE_SHOULD),
    zhWe: rate(ZH_WE),
    meanMs: ok.length > 0 ? Math.round(ok.reduce((sum, t) => sum + t.ms, 0) / ok.length) : 0,
    meanChars: ok.length > 0 ? Math.round(ok.reduce((sum, t) => sum + t.reasoning.length, 0) / ok.length) : 0,
  };
}

function wilson(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 1];
  const z = 1.959964;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (center - spread) / denom), Math.min(1, (center + spread) / denom)];
}

function lgamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) ser += cof[j]! / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

const logFactorial = (n: number): number => lgamma(n + 1);

/** Fisher 精确检验（双侧）。 */
function fisher(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const logP = (x: number): number =>
    logFactorial(row1) +
    logFactorial(row2) +
    logFactorial(col1) +
    logFactorial(n - col1) -
    logFactorial(n) -
    logFactorial(x) -
    logFactorial(row1 - x) -
    logFactorial(col1 - x) -
    logFactorial(row2 - (col1 - x));
  const observed = Math.exp(logP(a));
  let total = 0;
  for (let x = Math.max(0, col1 - row2); x <= Math.min(row1, col1); x += 1) {
    const p = Math.exp(logP(x));
    if (p <= observed * (1 + 1e-9)) total += p;
  }
  return Math.min(1, total);
}

const byVariant = new Map<string, Trial[]>();
for (const row of rows) {
  const list = byVariant.get(row.variant) ?? [];
  list.push(row);
  byVariant.set(row.variant, list);
}

const baseTrials = baselineId === undefined ? [] : (byVariant.get(baselineId) ?? []);
const baseStats = statsOf(baseTrials);

console.log(
  `${"variant".padEnd(20)} n   we-need        let-me  i-need  we-should  中文“我们要”  mean ms  reasoning chars`,
);
for (const [variant, trials] of byVariant) {
  const s = statsOf(trials);
  const [lo, hi] = wilson(s.weNeed, s.n);
  const p =
    baselineId === undefined || variant === baselineId || s.n === 0 || baseStats.n === 0
      ? undefined
      : fisher(s.weNeed, s.n - s.weNeed, baseStats.weNeed, baseStats.n - baseStats.weNeed);
  console.log(
    `${variant.padEnd(20)} ${String(s.n).padStart(2)}  ` +
      `${String(s.weNeed).padStart(2)}/${s.n} ${((s.weNeed / Math.max(1, s.n)) * 100)
        .toFixed(0)
        .padStart(3)}% [${String(Math.round(lo * 100)).padStart(2)}-${String(Math.round(hi * 100)).padStart(2)}]  ` +
      `${String(s.letMe).padStart(2)}/${s.n}   ${String(s.iNeed).padStart(2)}/${s.n}    ` +
      `${String(s.weShould).padStart(2)}/${s.n}      ${String(s.zhWe).padStart(2)}/${s.n}       ` +
      `${String(s.meanMs).padStart(5)}   ${String(s.meanChars).padStart(5)}` +
      (p !== undefined ? `   p=${p.toFixed(4)}` : ""),
  );
}
