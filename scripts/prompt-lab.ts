#!/usr/bin/env bun
/**
 * prompt-lab —— 用真实模型量化「提示词变体」对推理风格的影响。
 *
 * 为什么要有这个东西：改提示词最容易变成玄学 —— 换两句措辞、看两条输出，
 * 就得出"这样更好"的结论。这里把它变成可复现的对照实验：
 *
 *   - 每个变体跑 N 次同一道题，统计 reasoning 里 `we need` / `let me` 的出现率
 *   - 变体之间只改**一个**变量（工具 schema / system prompt / 角色位置 / 工具数量）
 *   - 原始 reasoning 全量落盘，结论可复查，不是只看摘要
 *   - 小样本用 Wilson 区间 + Fisher 精确检验，不拿 3/10 vs 5/10 当结论
 *
 * 变体里的工具集与 system prompt 都从 **snapshot 文件**读（`.prompt-lab/snapshots/`），
 * 不从仓库实时读 —— 否则"改完再测"就没法跟改动前对照了。
 *
 * 用法：
 *   bun run scripts/prompt-lab.ts --trials 24
 *   bun run scripts/prompt-lab.ts --trials 40 --variants baseline-zh,tools-en-short
 *   bun run scripts/prompt-lab.ts --task explore --trials 20
 *
 * 环境变量：
 *   PROMPT_LAB_BASE_URL  默认 http://127.0.0.1:8787/v1（本地 workbuddy 网关）
 *   PROMPT_LAB_MODEL     默认 deepseek-v4.1-flash
 *   PROMPT_LAB_EFFORT    默认 high
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createOpenAIChatClient } from "../src/provider/adapters/openai-chat.ts";
import type { ChatMessage, ToolSchema, Usage } from "../src/provider/types.ts";
import { textMessage } from "../src/provider/types.ts";

/* ------------------------------------------------------------------ */
/* 任务                                                                */
/* ------------------------------------------------------------------ */

/** 严格 debug：study 里最稳的 `We need` 触发条件，作为主对照任务。 */
const DEBUG_TASK = `这个函数返回 null 时会崩，帮我定位根因。不要运行命令，不要修改文件。

只输出：
1. 根因
2. 最小修复
3. 回归测试
4. 边界情况
5. 风险

不要追问，也不要提供后续帮助。

代码：
\`\`\`ts
export function pick(xs: string[]): string {
  return xs.find((x) => x.startsWith("a"))!.toUpperCase();
}
\`\`\``;

/** 开放式探索：study 里最容易混入 `Let me` 的任务类型。 */
const EXPLORE_TASK = `请探索并分析这个项目。只读，不要修改文件。

按以下结构输出：
1. 架构与模块边界
2. 主要数据流
3. 依赖关系
4. 风险与薄弱点
5. 未知项
6. 验证计划
7. 下一步需要授权：<具体动作>`;

/** 第二道难题（读写竞争），用来验证结论不是只对 study 那道题成立。 */
const HARD2_TASK = `这段代码在并发下会偶发丢更新，帮我定位根因、给最小修复和回归测试。不要运行命令，不要修改文件。

\`\`\`ts
let count = 0;

async function bump(): Promise<void> {
  const current = await load();
  await save(current + 1);
}
\`\`\``;

/** 简答题：专门用来验证"回答要简练"这条约束有没有被破坏。 */
const BRIEF_TASK = "`xs.find((x) => x.startsWith(\"a\"))!.toUpperCase()` 在什么情况下会抛错？直接给结论，不要展开。";

const TASKS = {
  debug: DEBUG_TASK,
  explore: EXPLORE_TASK,
  brief: BRIEF_TASK,
  hard2: HARD2_TASK,
  study: "",
} as const;
type TaskName = keyof typeof TASKS;

/** study 里真正跑的那道严格 debug 题（原文照抄，用于对照结论是否还成立）。 */
const STUDY_TASK = `调试下面这个 Python 内存任务队列。不要运行命令，不要修改文件。请定位根因，给出最小修复，并设计一个回归测试。

\`\`\`python
import collections
import threading


class TaskQueue:
    def __init__(self, workers=4):
        self.q = collections.deque()
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.running = True

    def submit(self, fn):
        with self.cond:
            self.q.append(fn)
            self.cond.notify()

    def worker(self):
        while self.running:
            with self.cond:
                while not self.q and self.running:
                    self.cond.wait()
                if not self.running:
                    return
                fn = self.q.popleft()
            fn()

    def shutdown(self):
        self.running = False
\`\`\``;

TASKS.study = STUDY_TASK;

/* ------------------------------------------------------------------ */
/* 变体                                                                */
/* ------------------------------------------------------------------ */

type ToolSetName = "zh-baseline" | "en-short" | "core" | "placeholder" | "none";
type SystemName = "baseline" | "new" | "pe" | "pe-forced" | "pe-forced2";

interface VariantSpec {
  readonly id: string;
  readonly label: string;
  readonly tools: ToolSetName;
  readonly system: SystemName;
  /** 把 system prompt 的 `## ...` 之后部分改挂到 developer 角色（study 里最强的角色变量）。 */
  readonly splitRoles?: boolean;
  /** 额外附加在 system 末尾的一段话（用于消融 / 上界对照）。 */
  readonly systemSuffix?: string;
  /** 完全不发 system 消息（study 的"只保留用户 prompt"条件）。 */
  readonly omitSystem?: boolean;
  /** 用这段字面量当 system prompt，替代 snapshot。 */
  readonly systemText?: string;
  /** 去掉 "Be concise and direct." 那句（逐句消融用）。 */
  readonly dropConcise?: boolean;
  /** 覆盖请求体里的字段（reasoning_effort / reasoning_summary 等 API 级开关）。 */
  readonly extraBody?: Record<string, unknown>;
  /** 用另一道题（study 的原始题）替换当前 task。 */
  readonly taskOverride?: "study";
}

const CORE_TOOLS = ["bash", "read_file", "edit_file", "apply_patch"];

/** 上界对照：直接要求用 `We need ...` 的句式思考。 */
const SEED_WE_NEED = [
  'Reasoning style: state each step of your reasoning in the form "We need to ...".',
  'Start every reasoning paragraph with "We need".',
].join("\n");

const VARIANTS: readonly VariantSpec[] = [
  {
    id: "baseline-zh",
    label: "改动前：中文工具描述 + 旧 system.md",
    tools: "zh-baseline",
    system: "baseline",
  },
  {
    id: "tools-en-short",
    label: "只换工具 schema：短 + 纯英文",
    tools: "en-short",
    system: "baseline",
  },
  {
    id: "system-new",
    label: "只换 system prompt（纪律搬进来）",
    tools: "zh-baseline",
    system: "new",
  },
  {
    id: "both",
    label: "短英文工具 + 新 system prompt",
    tools: "en-short",
    system: "new",
  },
  {
    id: "split-roles",
    label: "both + 纪律改挂 developer 角色",
    tools: "en-short",
    system: "new",
    splitRoles: true,
  },
  {
    id: "few-tools",
    label: "both + 只留 4 个核心工具",
    tools: "core",
    system: "new",
  },
  {
    id: "placeholder-tools",
    label: "长度对照：24 个空壳工具 + 新 system",
    tools: "placeholder",
    system: "new",
  },
  {
    id: "no-tools",
    label: "上界：无工具",
    tools: "none",
    system: "new",
  },
  {
    id: "seed-we-need",
    label: "上界：显式要求 We need 句式",
    tools: "en-short",
    system: "new",
    systemSuffix: SEED_WE_NEED,
  },

  /* --- 定位"到底是谁把 We need 压没了"的消融臂 --- */
  {
    id: "user-only",
    label: "无 system 消息 + 无工具（study 的 100% 条件）",
    tools: "none",
    system: "baseline",
    omitSystem: true,
  },
  {
    id: "user-only-tools",
    label: "无 system 消息 + 短英文工具",
    tools: "en-short",
    system: "baseline",
    omitSystem: true,
  },
  {
    id: "system-minimal",
    label: "system 只有一句身份",
    tools: "en-short",
    system: "baseline",
    systemText: "You are a coding agent.",
  },
  {
    id: "identity-only",
    label: "system 只留 bugent 身份那两行",
    tools: "en-short",
    system: "baseline",
    systemText: "You are bugent, a terminal-native coding agent.\n\nBe concise and direct. Prefer acting over explaining. Answer in the language the user writes in.",
  },
  {
    id: "no-concise",
    label: "新 system 去掉 “Be concise and direct.”",
    tools: "en-short",
    system: "new",
    dropConcise: true,
  },

  /* --- API 级开关：reasoning summary / effort 才是真正的上游变量 --- */
  {
    id: "summary-concise",
    label: "both + reasoning_summary=concise",
    tools: "en-short",
    system: "new",
    extraBody: { reasoning_summary: "concise" },
  },
  {
    id: "summary-detailed",
    label: "both + reasoning_summary=detailed",
    tools: "en-short",
    system: "new",
    extraBody: { reasoning_summary: "detailed" },
  },
  {
    id: "effort-medium",
    label: "both + reasoning_effort=medium",
    tools: "en-short",
    system: "new",
    extraBody: { reasoning_effort: "medium" },
  },
  {
    id: "study-template",
    label: "study 的严格 debug 模板原文 + 新 system",
    tools: "en-short",
    system: "new",
    taskOverride: "study",
  },

  /* --- 想稳定拿到 We need：几种措辞的强度对比 --- */
  {
    id: "seed-we",
    label: "软措辞：陈述需求时用 “We need to ...”",
    tools: "en-short",
    system: "new",
    taskOverride: "study",
    systemSuffix: 'When stating what the work requires, use the form "We need to ...".',
  },
  /* --- 提示词工程：先立"思考 / 回答"分工，再加强制思考风格 --- */
  {
    id: "pe",
    label: "PE：补 Reasoning / Answer 两节（软措辞）",
    tools: "en-short",
    system: "pe",
  },
  {
    id: "pe-forced",
    label: "PE + 强制 We need 句式",
    tools: "en-short",
    system: "pe-forced",
  },
  {
    id: "pe-forced2",
    label: "PE + 强制句式（更硬：Start every reasoning paragraph）",
    tools: "en-short",
    system: "pe-forced2",
  },
  {
    id: "pe-forced-debug",
    label: "PE + 强制句式（简单题，看回答是否还短）",
    tools: "en-short",
    system: "pe-forced",
  },
  {
    id: "seed-soft",
    label: "更软：先说要做什么再决定怎么做",
    tools: "en-short",
    system: "new",
    taskOverride: "study",
    systemSuffix:
      "Before deciding how to proceed, state what the task requires and what evidence is missing.",
  },
];

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

const SNAPSHOT_DIR = join(process.cwd(), ".prompt-lab", "snapshots");

const snapshotPath = (name: string): string => join(SNAPSHOT_DIR, name);

function loadToolSet(name: ToolSetName): ToolSchema[] {
  if (name === "none") return [];
  const file = snapshotPath(
    name === "zh-baseline" ? "tools-zh-baseline.json" : "tools-en-short.json",
  );
  if (!existsSync(file)) throw new Error(`缺少 snapshot：${file}（先跑 scripts/dump-tools.ts）`);
  const tools = JSON.parse(readFileSync(file, "utf8")) as ToolSchema[];
  if (name === "core") return tools.filter((tool) => CORE_TOOLS.includes(tool.name));
  if (name === "placeholder") {
    // 长度对照：同样的工具名与数量，但描述 / schema 清空（study 第 5 节的做法）
    return tools.map((tool) => ({
      name: tool.name,
      description: "Placeholder tool.",
      parameters: { type: "object", properties: {} },
    }));
  }
  return tools;
}

const SYSTEM_FILES: Record<SystemName, string> = {
  baseline: "system-baseline.md",
  new: "system-new.md",
  pe: "system-pe.md",
  "pe-forced": "system-pe-forced.md",
  "pe-forced2": "system-pe-forced2.md",
};

async function loadSystem(name: SystemName): Promise<string> {
  const file = snapshotPath(SYSTEM_FILES[name]);
  if (!existsSync(file)) throw new Error(`缺少 snapshot：${file}`);
  return (await readFile(file, "utf8")).trimEnd();
}

/** 把 system prompt 按第一个 `## ` 切成「身份」+「纪律」两段。 */
function splitSystem(text: string): { head: string; tail: string } {
  const index = text.indexOf("\n## ");
  if (index < 0) return { head: text, tail: "" };
  return { head: text.slice(0, index).trim(), tail: text.slice(index).trim() };
}

/* ------------------------------------------------------------------ */
/* 运行                                                                */
/* ------------------------------------------------------------------ */

interface Trial {
  variant: string;
  task: TaskName;
  trial: number;
  ms: number;
  reasoning: string;
  content: string;
  usage: Usage | undefined;
  error?: string;
}

interface Stats {
  trials: number;
  errors: number;
  weNeed: number;
  letMe: number;
  englishReasoning: number;
  meanMs: number;
  meanReasoningChars: number;
  /** 最终回答的长度 —— "思考可以长、回答必须短"这条约束要靠它验证。 */
  meanAnswerChars: number;
  /** 推理里的逐字重复率（死循环代理指标）。 */
  meanRepetition: number;
}

/**
 * 逐字重复率 —— "思考死循环"的可观测代理指标。
 *
 * 取 60 字符窗口、步长 30 滑过推理文本，统计有多少个窗口在之前出现过。
 * 正常的推理几乎不重复整句；绕圈子的推理会反复回到同一段措辞。
 */
function repetitionRate(text: string): number {
  const window = 60;
  const step = 30;
  if (text.length < window * 2) return 0;
  const seen = new Set<string>();
  let duplicates = 0;
  let total = 0;
  for (let i = 0; i + window <= text.length; i += step) {
    const shingle = text.slice(i, i + window);
    total += 1;
    if (seen.has(shingle)) duplicates += 1;
    else seen.add(shingle);
  }
  return total === 0 ? 0 : duplicates / total;
}

const WE_NEED = /\bwe need\b/i;
const LET_ME = /\blet me\b/i;

/** 推理语言：CJK 占比 > 15% 视为中文推理。 */
function cjkRatio(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
  }
  return cjk / [...text].length;
}

function summarize(trials: readonly Trial[]): Stats {
  const ok = trials.filter((trial) => trial.error === undefined);
  const stats: Stats = {
    trials: trials.length,
    errors: trials.length - ok.length,
    weNeed: 0,
    letMe: 0,
    englishReasoning: 0,
    meanMs: 0,
    meanReasoningChars: 0,
    meanAnswerChars: 0,
    meanRepetition: 0,
  };
  if (ok.length === 0) return stats;
  for (const trial of ok) {
    if (WE_NEED.test(trial.reasoning)) stats.weNeed += 1;
    if (LET_ME.test(trial.reasoning)) stats.letMe += 1;
    if (cjkRatio(trial.reasoning) <= 0.15) stats.englishReasoning += 1;
    stats.meanMs += trial.ms;
    stats.meanReasoningChars += trial.reasoning.length;
    stats.meanAnswerChars += trial.content.length;
    stats.meanRepetition += repetitionRate(trial.reasoning);
  }
  stats.meanMs /= ok.length;
  stats.meanReasoningChars /= ok.length;
  stats.meanAnswerChars /= ok.length;
  stats.meanRepetition /= ok.length;
  return stats;
}

/** Wilson 95% 区间 —— 小样本下比正态近似靠谱。 */
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

/** Fisher 精确检验（双侧）—— 两个小样本率的对比。 */
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

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function argValue(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

const trialsPerVariant = Number(argValue("--trials") ?? 20);
const taskName = (argValue("--task") ?? "debug") as TaskName;
const concurrency = Number(argValue("--concurrency") ?? 3);
const variantFilter = argValue("--variants")?.split(",").map((value) => value.trim());
const outRoot = argValue("--out") ?? join(process.cwd(), ".prompt-lab", "runs");

if (!(taskName in TASKS)) throw new Error(`--task 只能是 ${Object.keys(TASKS).join(" / ")}`);

const baseUrl = Bun.env.PROMPT_LAB_BASE_URL ?? "http://127.0.0.1:8787/v1";
const model = Bun.env.PROMPT_LAB_MODEL ?? "deepseek-v4.1-flash";
const effort = Bun.env.PROMPT_LAB_EFFORT ?? "high";

/** 每个 extraBody 组合一个 client（adapter 的 extraBody 是构造期参数）。 */
const clients = new Map<string, ReturnType<typeof createOpenAIChatClient>>();
function clientFor(extraBody: Record<string, unknown>): ReturnType<typeof createOpenAIChatClient> {
  const key = JSON.stringify(extraBody);
  const cached = clients.get(key);
  if (cached !== undefined) return cached;
  const created = createOpenAIChatClient(model, { baseUrl, extraBody });
  clients.set(key, created);
  return created;
}

const systems = Object.fromEntries(
  await Promise.all(
    (["baseline", "new", "pe", "pe-forced", "pe-forced2"] as SystemName[]).map(
      async (name) => [name, await loadSystem(name)] as const,
    ),
  ),
) as Record<SystemName, string>;
const toolSets: Partial<Record<ToolSetName, ToolSchema[]>> = {};
for (const name of new Set(VARIANTS.map((variant) => variant.tools))) {
  toolSets[name] = loadToolSet(name);
}

const variants = VARIANTS.filter(
  (variant) => variantFilter === undefined || variantFilter.includes(variant.id),
);

console.log(`模型 ${model} · effort=${effort} · task=${taskName} · 每个变体 ${trialsPerVariant} 次`);
console.log(
  `system: baseline ${systems.baseline.length} chars / new ${systems.new.length} chars · ` +
    `工具集：${Object.entries(toolSets)
      .map(([name, tools]) => `${name}=${tools.length}`)
      .join(" ")}\n`,
);

function buildMessages(variant: VariantSpec): ChatMessage[] {
  const task =
    variant.taskOverride === undefined ? TASKS[taskName] : TASKS[variant.taskOverride];
  if (variant.omitSystem === true) return [textMessage("user", task)];

  let system = variant.systemText ?? systems[variant.system];
  if (variant.dropConcise === true) {
    system = system.replace("Be concise and direct. Prefer acting over explaining. ", "");
  }
  const suffix = variant.systemSuffix !== undefined ? `\n\n${variant.systemSuffix}` : "";
  if (variant.splitRoles === true) {
    const { head, tail } = splitSystem(system);
    return [textMessage("system", head + suffix), textMessage("developer", tail), textMessage("user", task)];
  }
  return [textMessage("system", system + suffix), textMessage("user", task)];
}

async function runTrial(variant: VariantSpec, trial: number): Promise<Trial> {
  const messages = buildMessages(variant);
  const tools = toolSets[variant.tools] ?? [];
  const started = Date.now();
  let reasoning = "";
  let content = "";
  let usage: Usage | undefined;
  const client = clientFor({ reasoning_effort: effort, ...(variant.extraBody ?? {}) });
  try {
    for await (const chunk of client.chat({
      model,
      messages,
      ...(tools.length > 0 ? { tools } : {}),
    })) {
      if (chunk.type === "reasoning") reasoning += chunk.delta;
      else if (chunk.type === "text") content += chunk.delta;
      else if (chunk.type === "usage") usage = chunk.usage;
    }
  } catch (error) {
    return {
      variant: variant.id,
      task: taskName,
      trial,
      ms: Date.now() - started,
      reasoning,
      content,
      usage,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    variant: variant.id,
    task: taskName,
    trial,
    ms: Date.now() - started,
    reasoning,
    content,
    usage,
  };
}

/** 小并发跑完一个变体：网关自己有 in-flight 上限，别打爆它。 */
async function runVariant(variant: VariantSpec): Promise<Trial[]> {
  const results: Trial[] = [];
  const queue = Array.from({ length: trialsPerVariant }, (_, index) => index + 1);
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const trial = queue.shift();
      if (trial === undefined) return;
      results.push(await runTrial(variant, trial));
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.trial - b.trial);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(outRoot, `${stamp}-${taskName}`);
await mkdir(outDir, { recursive: true });

const all: Trial[] = [];
for (const variant of variants) {
  process.stdout.write(`跑 ${variant.id} ...`);
  const trials = await runVariant(variant);
  all.push(...trials);
  const stats = summarize(trials);
  const ok = stats.trials - stats.errors;
  console.log(
    ` we-need ${stats.weNeed}/${ok}` +
      ` · let-me ${stats.letMe}/${ok}` +
      ` · 英文推理 ${stats.englishReasoning}/${ok}` +
      ` · 推理 ${Math.round(stats.meanReasoningChars)}字 / 回答 ${Math.round(stats.meanAnswerChars)}字` +
      ` · 重复 ${(stats.meanRepetition * 100).toFixed(1)}%` +
      ` · ${Math.round(stats.meanMs)}ms` +
      (stats.errors > 0 ? ` · 失败 ${stats.errors}` : ""),
  );
}

const baseline = all.filter((trial) => trial.variant === "baseline-zh" && trial.error === undefined);
const baselineStats = summarize(baseline);

console.log(
  `\n${"变体".padEnd(20)} we-need            let-me   英文推理   推理字   回答字   vs baseline`,
);
for (const variant of variants) {
  const stats = summarize(all.filter((trial) => trial.variant === variant.id));
  const ok = stats.trials - stats.errors;
  const [lo, hi] = wilson(stats.weNeed, ok);
  const baseOk = baselineStats.trials - baselineStats.errors;
  const p =
    variant.id === "baseline-zh" || baseOk === 0 || ok === 0
      ? 1
      : fisher(stats.weNeed, ok - stats.weNeed, baselineStats.weNeed, baseOk - baselineStats.weNeed);
  console.log(
    `${variant.id.padEnd(20)} ${String(stats.weNeed).padStart(2)}/${ok} ${(
      (stats.weNeed / Math.max(1, ok)) * 100
    )
      .toFixed(0)
      .padStart(3)}% [${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%]   ` +
      `${String(stats.letMe).padStart(2)}/${ok}    ${String(stats.englishReasoning).padStart(2)}/${ok}     ` +
      `${String(Math.round(stats.meanReasoningChars)).padStart(5)}   ${String(Math.round(stats.meanAnswerChars)).padStart(5)}   ` +
      `${(stats.meanRepetition * 100).toFixed(1).padStart(5)}%   p=${p.toFixed(4)}`,
  );
}

await writeFile(join(outDir, "results.jsonl"), all.map((trial) => JSON.stringify(trial)).join("\n"));
await writeFile(
  join(outDir, "summary.json"),
  JSON.stringify(
    {
      model,
      effort,
      task: taskName,
      trialsPerVariant,
      baseUrl,
      variants: variants.map((variant) => ({
        id: variant.id,
        label: variant.label,
        tools: variant.tools,
        system: variant.system,
        splitRoles: variant.splitRoles ?? false,
        stats: summarize(all.filter((trial) => trial.variant === variant.id)),
      })),
    },
    null,
    2,
  ),
);
console.log(`\n原始 reasoning 落盘：${outDir}`);
