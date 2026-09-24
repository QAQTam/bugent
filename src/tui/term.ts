/**
 * 终端 I/O 层 —— 把备用屏、raw mode、尺寸变化这些脏活收在一处。
 *
 * 上面所有逻辑（Screen / KeyDecoder / 渲染）都是纯的，只有这里碰 stdout/stdin，
 * 所以整体是可测的。
 */

interface StdinLike {
  setRawMode?: (mode: boolean) => void;
  setEncoding?: (encoding: string) => void;
  resume?: () => void;
  pause?: () => void;
  on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
  off: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
}

export interface TerminalSize {
  width: number;
  height: number;
}

export class Terminal {
  #dataHandlers = new Set<(chunk: string) => void>();
  #resizeHandlers = new Set<() => void>();
  #entered = false;
  #boundData: ((chunk: Buffer | string) => void) | undefined;
  #boundResize: (() => void) | undefined;
  #resizePoll: ReturnType<typeof setInterval> | undefined;
  #polledSize: TerminalSize | undefined;

  get size(): TerminalSize {
    // 注意用 `||` 而不是 `??`：部分 PTY/终端会返回 0 而不是 undefined，
    // 0 会让屏幕被压成 1x1，必须兜底。
    return {
      width: process.stdout.columns || 80,
      height: process.stdout.rows || 24,
    };
  }

  get isTTY(): boolean {
    return Boolean(process.stdout.isTTY);
  }

  onData(handler: (chunk: string) => void): () => void {
    this.#dataHandlers.add(handler);
    return () => this.#dataHandlers.delete(handler);
  }

  onResize(handler: () => void): () => void {
    this.#resizeHandlers.add(handler);
    return () => this.#resizeHandlers.delete(handler);
  }

  /** 进入备用屏 + raw mode。 */
  enter(): void {
    if (this.#entered) return;
    this.#entered = true;

    this.write("\x1b[?1049h"); // 切到备用屏
    this.write("\x1b[?25l"); // 隐藏光标
    this.write("\x1b[2J\x1b[H"); // 清屏并归位
    this.write("\x1b[?1000h"); // 开启鼠标事件
    this.write("\x1b[?1006h"); // SGR 扩展坐标（支持 >223 列，且不混淆按键与坐标）
    this.write("\x1b[?1003h"); // 鼠标移动事件（按钮 hover）
    this.write("\x1b[?2004h"); // bracketed paste：粘贴内容与普通回车分开

    const stdin = process.stdin as unknown as StdinLike;
    stdin.setRawMode?.(true);
    stdin.resume?.();
    stdin.setEncoding?.("utf8");

    this.#boundData = (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const handler of this.#dataHandlers) handler(text);
    };
    stdin.on("data", this.#boundData);

    this.#boundResize = () => {
      for (const handler of this.#resizeHandlers) handler();
    };
    process.on("SIGWINCH", this.#boundResize);
    // Windows 不产生 SIGWINCH，只能自己轮询尺寸；这个定时器只在那边开，
    // 其他平台继续走信号。
    if (process.platform === "win32") {
      this.#polledSize = this.size;
      this.#resizePoll = setInterval(() => {
        const size = this.size;
        const last = this.#polledSize;
        if (last !== undefined && size.width === last.width && size.height === last.height) return;
        this.#polledSize = size;
        this.#boundResize?.();
      }, 250);
    }
  }

  /** 退出备用屏，恢复终端状态。必须保证异常路径也能调用。 */
  exit(): void {
    if (!this.#entered) return;
    this.#entered = false;

    const stdin = process.stdin as unknown as StdinLike;
    if (this.#boundData !== undefined) stdin.off("data", this.#boundData);
    if (this.#boundResize !== undefined) process.off("SIGWINCH", this.#boundResize);
    if (this.#resizePoll !== undefined) {
      clearInterval(this.#resizePoll);
      this.#resizePoll = undefined;
    }

    stdin.setRawMode?.(false);
    stdin.pause?.();

    // 先关鼠标追踪再回主屏，否则退出后终端里鼠标行为会残留
    this.write("\x1b[?2004l");
    this.write("\x1b[?1003l");
    this.write("\x1b[?1006l");
    this.write("\x1b[?1000l");
    this.write("\x1b[?25h"); // 显示光标
    this.write("\x1b[?1049l"); // 回主屏
  }

  write(text: string): void {
    process.stdout.write(text);
  }

  /**
   * Move the real terminal cursor to the logical input position.
   *
   * IME candidate windows and some terminal accessibility tools anchor to the
   * hardware cursor, not to a reverse-video cell drawn in the frame buffer.
   * Passing no position hides the cursor while a dialog owns the screen.
   */
  setCursor(row?: number, column?: number): void {
    if (row === undefined || column === undefined) {
      this.write("\x1b[?25l");
      return;
    }
    const safeRow = Math.max(1, row);
    const safeColumn = Math.max(1, column);
    this.write(`\x1b[${safeRow};${safeColumn}H\x1b[?25h`);
  }
}
