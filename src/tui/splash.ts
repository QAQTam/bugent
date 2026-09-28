/**
 * 开屏动画（splash）。
 *
 * 只在"交互式启动且会话还是空的"时候出现：一块会流动的字标 + 一行就绪状态 +
 * 一句提示。用户敲下第一个字符它就自己退场 —— 不需要额外按键，也没有"跳过"。
 *
 * 三条硬约束，都是被现有布局逼出来的：
 *
 *   1. **只占正文区**。状态栏、思考区、输入框的几何一格都不许动。输入框的屏幕
 *      行号同时是硬件光标（IME 候选窗）的锚点，PTY 用例把它钉死了。
 *   2. **行数严格等于正文高度**。多一行会顶掉输入框，少一行会让正文跳一下。
 *   3. **按可用高度降级**。终端越矮，先丢目录信息、再丢标语、最后换小字标 ——
 *      而不是让内容溢出被裁掉半截。
 *
 * 整个模块是**纯函数**：动画进度由外部的 `elapsedMs` / `exit` 驱动，帧调度留在
 * TuiApp 里。所以动画逻辑可以脱离真终端单独跑测试。
 *
 * 视觉上叠了三层：
 *   - 横向流动的极光渐变（青 → 蓝 → 靛 → 紫 → 品红），色相随时间整体平移；
 *   - 一道周期性横扫的白色高光带（三角波衰减）；
 *   - 首帧的"逐列擦入"打字机揭示，行与行错开半格，扫过去是斜的。
 * 外加两个随机闪点，让画面"活着"。
 */

import { centerAnsi, visibleWidth } from "./ansi.ts";
import { BOLD, DIM, RESET, fg } from "./markdown.ts";
import { COLOR } from "./theme.ts";

/** 退场动画时长（毫秒）。敲字后从中间向外擦掉，比硬切自然。 */
export const SPLASH_EXIT_MS = 260;
/** 开屏动画的帧间隔。20fps 对渐变足够，又不至于空转烧 CPU。 */
export const SPLASH_FRAME_MS = 45;

/** 打字机揭示的时长。 */
const REVEAL_MS = 640;
/** 高光带扫过一轮的周期。 */
const SHINE_PERIOD_MS = 2600;
/** 极光渐变整体平移一轮的周期。 */
const FLOW_PERIOD_MS = 4200;

/** 极光色带：青 → 天蓝 → 靛 → 紫 → 品红。 */
const AURORA = ["#22d3ee", "#38bdf8", "#818cf8", "#c084fc", "#f472b6"] as const;
/** 高光/闪点打到白色。 */
const FLASH = "#f8fafc";

/** 通道量化步长。相邻列色差本来就看不出，量化后同色连续段能合并成一次转义。 */
const CHANNEL_STEP = 16;

/* ------------------------------- 字标 ------------------------------- */

/** 六行大字标（ANSI Shadow 风格）。每行由字模横向拼出来，改字模不用数空格。 */
const GLYPHS_FULL: Record<string, readonly string[]> = {
  B: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██████╔╝", "╚═════╝ "],
  U: ["██╗   ██╗", "██║   ██║", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
};

/** 三行半块字标，给中等高度的终端。 */
const GLYPHS_COMPACT: Record<string, readonly string[]> = {
  B: ["▄▄▄", "█▄█", "▀▀▀"],
  U: ["▄ ▄", "█ █", "▀▀▀"],
  G: ["▄▄▄", "█ ▄", "▀▀▀"],
  E: ["▄▄▄", "█▄ ", "▀▀▀"],
  N: ["▄ ▄", "█▄█", "▀ ▀"],
  T: ["▄▄▄", " █ ", " ▀ "],
};

/** 单行字标，给矮终端。 */
const WORDMARK_MINI = ["▐ BUGENT ▌"] as const;

export type SplashWordmark = "full" | "compact" | "mini";

const WORDMARK_TIERS: readonly SplashWordmark[] = ["full", "compact", "mini"];

/** 可选块的组合，按信息量从多到少枚举（`[标语, 目录信息]`）。 */
const COMBO_ORDER: readonly (readonly [boolean, boolean])[] = [
  [true, true],
  [true, false],
  [false, true],
  [false, false],
];

function buildWordmark(glyphs: Record<string, readonly string[]>, word: string): string[] {
  const rows = glyphs[word[0]!]?.length ?? 0;
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    lines.push([...word].map((char) => glyphs[char]?.[row] ?? "").join(" "));
  }
  return lines;
}

const WORDMARK_FULL = buildWordmark(GLYPHS_FULL, "BUGENT");
const WORDMARK_COMPACT = buildWordmark(GLYPHS_COMPACT, "BUGENT");

/** 字标的可见宽度；降级判断与渐变分母都用它。 */
export function wordmarkWidth(tier: SplashWordmark): number {
  const lines = wordmarkLines(tier);
  return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}

function wordmarkLines(tier: SplashWordmark): readonly string[] {
  if (tier === "full") return WORDMARK_FULL;
  if (tier === "compact") return WORDMARK_COMPACT;
  return WORDMARK_MINI;
}

/* ------------------------------- 颜色 ------------------------------- */

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function quantize(channel: number): number {
  const clamped = Math.max(0, Math.min(255, Math.round(channel)));
  // 先量化再夹一次：255 会量化到 256，直接拼进十六进制就是三位数。
  return Math.min(255, Math.round(clamped / CHANNEL_STEP) * CHANNEL_STEP);
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => quantize(channel).toString(16).padStart(2, "0")).join("")}`;
}

/** 两个十六进制颜色按 `t` 线性混合；结果已量化。 */
export function mixHex(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const ratio = clamp01(t);
  return toHex([
    a[0] + (b[0] - a[0]) * ratio,
    a[1] + (b[1] - a[1]) * ratio,
    a[2] + (b[2] - a[2]) * ratio,
  ]);
}

/** 极光色带上 `t`（0..1，可回绕）处的颜色。 */
function auroraAt(t: number): string {
  const wrapped = ((t % 1) + 1) % 1;
  const scaled = wrapped * (AURORA.length - 1);
  const index = Math.min(AURORA.length - 2, Math.floor(scaled));
  return mixHex(AURORA[index]!, AURORA[index + 1]!, scaled - index);
}

/** `Bun.color` 的缓存；同一帧里同色值反复出现，没必要反复过一遍原生解析。 */
const SGR_CACHE = new Map<string, string>();

function truecolor(color: string): string {
  const cached = SGR_CACHE.get(color);
  if (cached !== undefined) return cached;
  const sequence = fg(color, "ansi-16m");
  SGR_CACHE.set(color, sequence);
  return sequence;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function easeOutCubic(t: number): number {
  const inverse = 1 - clamp01(t);
  return 1 - inverse * inverse * inverse;
}

/* ------------------------------ 内容块 ------------------------------ */

export interface SplashInfo {
  version: string;
  /** `provider/model`，和状态栏用的是同一个 id。 */
  clientId: string;
  mode: string;
  cwd: string;
  sessionId: string;
}

export interface SplashInput {
  width: number;
  /** 正文区可用行数。输出恰好这么多行。 */
  rows: number;
  /** 开屏出现至今的毫秒数。 */
  elapsedMs: number;
  /** 退场进度 0..1；0 表示还没开始退场。 */
  exit: number;
  info: SplashInfo;
}

/** 转起来的小点；和思考区的菊花刻意不同，开屏是独立的视觉层。 */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/**
 * 从宽到窄挑第一个放得下的变体。
 *
 * 每行都有几个长短版本：终端窄的时候宁可少说点，也不能让 `Screen` 把
 * 关键信息（"已就绪"、怎么开始）从右边裁掉。
 */
function fitVariant(variants: readonly string[], width: number): string {
  for (const variant of variants) {
    if (visibleWidth(variant) <= width) return variant;
  }
  return variants.at(-1) ?? "";
}

function composeStatusLine(info: SplashInfo, width: number): string {
  const ready = `${fg(COLOR.ok)}已就绪${RESET}`;
  const brand = `${BOLD}${fg(COLOR.prompt)}bugent${RESET}`;
  const version = `${DIM}v${info.version}${RESET}`;
  const dot = `${DIM}·${RESET}`;
  const client = `${fg(COLOR.user)}${info.clientId}${RESET}`;
  return fitVariant(
    [
      `${brand} ${version} ${dot} ${ready} ${dot} ${client}`,
      `${brand} ${dot} ${ready} ${dot} ${client}`,
      `${brand} ${dot} ${ready}`,
      ready,
    ],
    width,
  );
}

function composeTaglineLine(elapsedMs: number, width: number): string {
  const frame = SPINNER[Math.floor(elapsedMs / 90) % SPINNER.length]!;
  const spinner = `${fg(COLOR.reasoningSpinner)}${frame}${RESET}`;
  return fitVariant(
    [
      `${spinner} ${DIM}终端原生编码智能体${RESET}`,
      `${spinner} ${DIM}编码智能体${RESET}`,
      spinner,
    ],
    width,
  );
}

function composeMetaLine(info: SplashInfo, width: number): string {
  const modeColor = info.mode === "no-sandbox" ? COLOR.warn : COLOR.ok;
  const mode = `${fg(modeColor)}${info.mode}${RESET}`;
  const dot = `${DIM}·${RESET}`;
  return fitVariant(
    [
      `${mode} ${dot} ${DIM}${info.cwd}${RESET} ${dot} ${DIM}${info.sessionId}${RESET}`,
      `${mode} ${dot} ${DIM}${info.cwd}${RESET}`,
      mode,
    ],
    width,
  );
}

function composeHintLine(elapsedMs: number, width: number): string {
  const on = Math.floor(elapsedMs / 520) % 2 === 0;
  const caret = on ? `${fg(COLOR.prompt)}▌${RESET}` : `${DIM}▌${RESET}`;
  return fitVariant(
    [
      `${caret} ${fg(COLOR.inputPlaceholder)}直接输入开始对话${RESET} ${DIM}· / 查看命令 · Ctrl+C 退出${RESET}`,
      `${caret} ${fg(COLOR.inputPlaceholder)}直接输入开始对话${RESET}`,
      caret,
    ],
    width,
  );
}

/**
 * 字标上色。
 *
 * 逐字符算色，但只在色值**变化**时写一次转义 —— 量化之后一行大约只发十几次
 * SGR，而不是每个字符一次。
 */
export function paintWordmark(lines: readonly string[], elapsedMs: number): string[] {
  const height = lines.length;
  const width = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
  if (height === 0 || width === 0) return [];

  // 打字机：擦入前沿从左往右推，行与行错开半格 → 斜着扫过去。
  const reveal = easeOutCubic(elapsedMs / REVEAL_MS) * (width + 6) - 3;
  // 高光：三角波，扫出画面后从另一侧进来。
  const phase = (elapsedMs % SHINE_PERIOD_MS) / SHINE_PERIOD_MS;
  const shine = phase * (width + 48) - 24;
  // 两个闪点，位置按相位跳；只落在已经画出来的字符上。
  const sparks = [0, 1].map((index) => {
    const seed = (Math.floor(elapsedMs / 110) + index * 31) * 2654435761;
    return { row: Math.abs(seed) % height, column: Math.abs(seed >> 8) % width };
  });
  const flow = (elapsedMs / FLOW_PERIOD_MS) % 1;

  return lines.map((line, row) => {
    let out = "";
    let column = 0;
    let current = "";

    for (const char of line) {
      const charWidth = visibleWidth(char);
      if (char === " " || charWidth === 0) {
        out += char;
        column += charWidth;
        continue;
      }

      if (column > reveal - row * 1.6) {
        // 还没被揭示：留白，字标看起来是"长"出来的。
        out += " ".repeat(charWidth);
        column += charWidth;
        continue;
      }

      let color = auroraAt(width <= 1 ? flow : column / (width - 1) + flow);
      const distance = Math.abs(column - shine);
      if (distance < 22) {
        const glow = (1 - distance / 22) ** 2;
        color = mixHex(color, FLASH, glow * 0.9);
      }
      if (sparks.some((spark) => spark.row === row && spark.column === column)) {
        color = FLASH;
      }

      if (color !== current) {
        out += truecolor(color);
        current = color;
      }
      out += char;
      column += charWidth;
    }

    return current === "" ? out : `${out}${RESET}`;
  });
}

/* ------------------------------ 组装 ------------------------------ */

/** 一个内容块：`gap` 是它前面愿意留的空行数（空行不够时会被砍掉）。 */
interface SplashBlock {
  lines: string[];
  gap: number;
}

/**
 * 把内容块拼进 `rows` 行：内容优先，剩下的行才拿来当间隔。
 *
 * 间隔从**最后一个边界**往前分配 —— 于是字标和它下面那行永远贴着，
 * 空行都落在下面几块之间，看起来是"标题 + 正文"而不是散开的几坨。
 */
function layoutBlocks(blocks: readonly SplashBlock[], rows: number): string[] | undefined {
  const content = blocks.reduce((total, block) => total + block.lines.length, 0);
  if (content > rows) return undefined;

  const boundaries = Math.max(0, blocks.length - 1);
  const gaps = new Array<number>(boundaries).fill(0);
  let spare = Math.min(boundaries, rows - content);
  for (let index = boundaries - 1; index >= 0 && spare > 0; index -= 1) {
    gaps[index] = 1;
    spare -= 1;
  }

  const out: string[] = [];
  blocks.forEach((block, index) => {
    if (index > 0) {
      for (let line = 0; line < gaps[index - 1]!; line += 1) out.push("");
    }
    out.push(...block.lines);
  });
  return out;
}

/**
 * 逐档试装：字标从大到小，**取第一个装得下的档位**；档位内部再挑得分最高的
 * 可选块组合。
 *
 * 档位是主序、组合是次序：先保证字标尽可能大，再谈多显示几行信息。反过来
 * （按总分挑）会让矮终端为了多留空行而换成单行字标 —— 那正是最该避免的。
 *
 * 组合得分 = 信息量（标语 2 分 / 目录信息 1 分）+ 空行数 × 1.5。空行比"多一行
 * 信息"更值钱 —— 矮终端上与其把五行字塞满七行，不如少说一行、留出呼吸位。
 * 同分时保留更丰富的那个（组合按信息量从多到少枚举，严格大于才换）。
 */
function planContent(input: SplashInput): string[] {
  const { width, rows, elapsedMs, info } = input;
  const status = composeStatusLine(info, width);
  const hint = composeHintLine(elapsedMs, width);
  const tagline = composeTaglineLine(elapsedMs, width);
  const meta = composeMetaLine(info, width);

  for (const tier of WORDMARK_TIERS) {
    if (wordmarkWidth(tier) + 2 > width) continue;
    const art = paintWordmark(wordmarkLines(tier), elapsedMs);

    let best: string[] | undefined;
    let bestScore = -1;
    for (const [withTagline, withMeta] of COMBO_ORDER) {
      const blocks: SplashBlock[] = [{ lines: art, gap: 0 }];
      if (withTagline) blocks.push({ lines: [tagline], gap: 1 });
      blocks.push({ lines: [status], gap: 1 });
      if (withMeta) blocks.push({ lines: [meta], gap: 1 });
      blocks.push({ lines: [hint], gap: 1 });

      const laid = layoutBlocks(blocks, rows);
      if (laid === undefined) continue;
      const content = blocks.reduce((total, block) => total + block.lines.length, 0);
      const gaps = laid.length - content;
      const score = (withTagline ? 2 : 0) + (withMeta ? 1 : 0) + gaps * 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = laid;
      }
    }
    if (best !== undefined) return best;
  }

  // 连单行字标都放不下：只留"已就绪"和怎么开始。
  const fallback: SplashBlock[] = rows >= 3
    ? [{ lines: [status], gap: 0 }, { lines: [hint], gap: 1 }]
    : [{ lines: [status], gap: 0 }];
  return layoutBlocks(fallback, rows) ?? [];
}

/**
 * 退场：从中间向外擦掉。
 *
 * 用"保留中间一段、其余清空"而不是整体变淡 —— 差分渲染下清行是最便宜的更新，
 * 而向外收缩在视觉上就是"这个画面被收走了"。
 */
function applyExit(lines: string[], exit: number): string[] {
  const progress = clamp01(exit);
  if (progress <= 0) return lines;
  // 退干净就是空屏，不能因为"中心那行距离为 0"把它留下。
  if (progress >= 1) return lines.map(() => "");
  const center = (lines.length - 1) / 2;
  const half = (lines.length / 2) * (1 - progress);
  return lines.map((line, index) =>
    line.length > 0 && Math.abs(index - center) > half ? "" : `${DIM}${line}${RESET}`,
  );
}

/** 渲染开屏。返回**恰好 `rows` 行**，可直接替换正文区。 */
export function composeSplash(input: SplashInput): string[] {
  const { width, rows } = input;
  if (width <= 0 || rows <= 0) return [];

  const content = planContent(input);
  const out = new Array<string>(rows).fill("");
  const top = Math.max(0, Math.floor((rows - content.length) / 2));
  content.forEach((line, index) => {
    const row = top + index;
    if (row >= 0 && row < rows) out[row] = centerAnsi(line, width);
  });
  return applyExit(out, input.exit);
}
