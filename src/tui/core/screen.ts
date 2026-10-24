/**
 * 行缓冲差分渲染器。
 *
 * 策略：每帧把"完整屏幕"表达成 `string[]`（每行一条），然后**只重写发生变化的行**。
 * 流式输出时通常只有最后 1~2 行变化，所以每帧的网络/IO 代价是 O(变化的行数)，
 * 而不是 O(屏幕面积) —— 这就是 README 里要的 O(1) 更新。
 *
 * 纯函数式：`draw()` 只返回要写入的转义序列，不碰 stdout，方便单测。
 */

import { expandTabs, truncateAnsi } from "./ansi.ts";

const ESC = "\x1b";

/** 把一行裁剪到屏幕宽度，并保证不含换行。 */
function fit(line: string, width: number): string {
  const single = line.replace(/[\r\n]+/g, " ");
  // 兜底：任何绕过 ansi.ts 测量、带着 TAB 走到这里的行，都在写屏前展开成空格。
  // 终端的制表位是从第 0 列算的，而每一行都是从行首开始写的，所以这里展开的列
  // 位置与终端一致。
  return truncateAnsi(expandTabs(single), width);
}

export class Screen {
  #width: number;
  #height: number;
  #previous: string[] = [];
  #initialized = false;

  constructor(width: number, height: number) {
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  /** 尺寸变化时调用；返回是否真的变了。 */
  resize(width: number, height: number): boolean {
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    if (nextWidth === this.#width && nextHeight === this.#height) return false;

    this.#width = nextWidth;
    this.#height = nextHeight;
    this.invalidate();
    return true;
  }

  /** 强制下一帧全量重绘。 */
  invalidate(): void {
    this.#previous = [];
    this.#initialized = false;
  }

  /** 需要重绘的行数（用于观测差分效果）。 */
  countChanged(lines: readonly string[]): number {
    let changed = 0;
    for (let row = 0; row < this.#height; row += 1) {
      const next = fit(lines[row] ?? "", this.#width);
      if (!this.#initialized || this.#previous[row] !== next) changed += 1;
    }
    return changed;
  }

  /** 生成把 lines 渲染到屏幕所需的最小转义序列。 */
  draw(lines: readonly string[]): string {
    const next: string[] = [];
    let out = "";

    for (let row = 0; row < this.#height; row += 1) {
      const fitted = fit(lines[row] ?? "", this.#width);
      next.push(fitted);
      if (this.#initialized && this.#previous[row] === fitted) continue;
      // 定位到行首 -> 清整行 -> 写内容
      out += `${ESC}[${row + 1};1H${ESC}[2K${fitted}`;
    }

    this.#previous = next;
    this.#initialized = true;
    return out;
  }
}
