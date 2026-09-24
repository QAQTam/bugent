/**
 * 终端底色探测。
 *
 * 为什么需要：`Bun.markdown.ansi` 会给行内代码挑一个底色（深色终端用
 * `48;5;236`，浅色终端用 `48;5;254`），而它判断深浅的方式是读 `COLORFGBG`
 * —— 那个变量很多终端根本不导出，而且 Bun 只在**进程启动时**读一次。
 *
 * 所以 bugent 自己判定一次，再显式把 `light` 传给 Bun。这样结果与"Bun 什么
 * 时候读的环境变量"无关，也让将来接浅色主题时有一个现成的判定入口。
 *
 * 判定顺序：
 *   1. OSC 11 查询（最准，直接问终端）
 *   2. `COLORFGBG`（老约定，rxvt/konsole 时代）
 *   3. dark（默认）
 */

export type TerminalBackground = "dark" | "light";

export type BackgroundSource = "osc11" | "colorfgbg" | "default";

export interface BackgroundDetection {
  background: TerminalBackground;
  source: BackgroundSource;
}

/** 向终端查询底色；xterm 与绝大多数现代终端都支持。 */
export const OSC11_QUERY = "\x1b]11;?\x07";

/** 16 色 ANSI 调色板，用来把 `COLORFGBG` 里的索引还原成颜色。 */
const ANSI16 = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#c0c0c0",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
] as const;

/**
 * 解析 OSC 11 的应答，形如 `ESC]11;rgb:RRRR/GGGG/BBBB`（BEL 或 ST 结尾）。
 *
 * 每个通道 1~4 个十六进制位，按自己的位宽归一化 —— xterm 发 4 位，
 * 有些终端发 2 位。解析不出来返回 undefined。
 */
export function parseOsc11Reply(text: string): string | undefined {
  const match = /\x1b\]11;rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/.exec(
    text,
  );
  if (match === null) return undefined;
  return `#${hexChannel(match[1]!) }${hexChannel(match[2]!)}${hexChannel(match[3]!)}`;
}

function hexChannel(raw: string): string {
  const value = Number.parseInt(raw, 16);
  const max = 16 ** raw.length - 1;
  return Math.round((value / max) * 255)
    .toString(16)
    .padStart(2, "0");
}

/**
 * 感知亮度（ITU-R BT.601）。
 *
 * 这里不套 gamma 校正：判据只是"终端底色是深的还是浅的"，两个候选色差
 * 都在数量级上，加权平均足够。
 */
export function perceivedLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16) / 255;
  const g = Number.parseInt(value.slice(2, 4), 16) / 255;
  const b = Number.parseInt(value.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * 阈值取 0.6 而不是 0.5：`#808080`（ANSI 8，"亮黑"）的感知亮度是 0.502，
 * 而它几乎总是被当作深色底色用。
 */
export function backgroundFromColor(hex: string): TerminalBackground {
  return perceivedLuminance(hex) > 0.6 ? "light" : "dark";
}

/** 解析 `COLORFGBG`（形如 `"fg;bg"`），无法判定时返回 undefined。 */
export function backgroundFromColorFgbg(value: string | undefined): TerminalBackground | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(";");
  const background = Number.parseInt(parts[parts.length - 1] ?? "", 10);
  if (!Number.isFinite(background) || background < 0 || background > 15) return undefined;
  return backgroundFromColor(ANSI16[background]!);
}

export interface DetectOptions {
  /** 向终端写查询。 */
  write: (text: string) => void;
  /** 订阅终端数据；返回取消订阅的函数。 */
  subscribe: (handler: (chunk: string) => void) => () => void;
  env?: Record<string, string | undefined>;
  /** 等应答的上限；终端不回就直接走兜底。 */
  timeoutMs?: number;
}

export async function detectTerminalBackground(
  options: DetectOptions,
): Promise<BackgroundDetection> {
  const env = options.env ?? process.env;

  // 有 COLORFGBG 就直接用 —— 省掉一次启动期的往返
  const fromEnv = backgroundFromColorFgbg(env.COLORFGBG);
  if (fromEnv !== undefined) return { background: fromEnv, source: "colorfgbg" };

  const color = await queryOsc11(options, options.timeoutMs ?? 60);
  if (color !== undefined) return { background: backgroundFromColor(color), source: "osc11" };
  return { background: "dark", source: "default" };
}

function queryOsc11(options: DetectOptions, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let off: (() => void) | undefined;

    function cleanup(): void {
      if (timer !== undefined) clearTimeout(timer);
      off?.();
    }
    function finish(color: string | undefined): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(color);
    }

    // 先订阅再发查询：应答可能在写入的同一轮就到达
    off = options.subscribe((chunk) => {
      buffer += chunk;
      const parsed = parseOsc11Reply(buffer);
      if (parsed !== undefined) finish(parsed);
    });
    timer = setTimeout(() => finish(undefined), timeoutMs);
    options.write(OSC11_QUERY);
  });
}
