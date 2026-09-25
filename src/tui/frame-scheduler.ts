/**
 * 帧调度器 —— 全应用**唯一**的重绘入口。
 *
 * 存在的理由：重绘请求以前散落在各处（`#scheduleRender()` 只有 7 处，
 * 而直调 `#render()` 有 113 处），漏掉一处不会报错，只会让界面变慢 ——
 * 流式文本正是因为漏了请求，退化成每 80ms 才吐一批。
 *
 * 约定：
 *   - 任何"状态变了、需要重画"的地方都调 `request()`；
 *   - 只有"必须同步拿到渲染结果"的地方（构造、teardown、尺寸变化后的
 *     命中区重算）才直调底层 render，并在这里显式 `flush()`。
 *
 * 合流语义：窗口期内的多次 `request()` 合并成一帧；期间只要有一次
 * `request(true)`，这一帧就是 forced。这样"强制重绘"不会因为合流而丢失。
 */

export interface FrameSchedulerOptions {
  /** 真正执行绘制的回调；`force` 表示要求全量重绘。 */
  render: (force: boolean) => void;
  /** 合流窗口，默认 16ms（约 60fps 上限）。 */
  intervalMs?: number;
  /** 定时器注入点，测试用。默认 `setTimeout` / `clearTimeout`。 */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class FrameScheduler {
  #render: (force: boolean) => void;
  #intervalMs: number;
  #schedule: (fn: () => void, ms: number) => unknown;
  #cancel: (handle: unknown) => void;

  #handle: unknown | undefined;
  #force = false;
  #frames = 0;
  #disposed = false;

  constructor(options: FrameSchedulerOptions) {
    this.#render = options.render;
    this.#intervalMs = options.intervalMs ?? 16;
    this.#schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.#cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** 已经真正绘制过的帧数。测试与自检用。 */
  get frames(): number {
    return this.#frames;
  }

  /** 是否有帧挂起等待合流窗口结束。 */
  get pending(): boolean {
    return this.#handle !== undefined;
  }

  /** 请求一帧。窗口期内重复调用只会产生一帧；force 会被累积保留。 */
  request(force = false): void {
    if (this.#disposed) return;
    if (force) this.#force = true;
    if (this.#handle !== undefined) return;

    this.#handle = this.#schedule(() => {
      this.#handle = undefined;
      const forced = this.#force;
      this.#force = false;
      this.#frames += 1;
      this.#render(forced);
    }, this.#intervalMs);
  }

  /**
   * 立刻绘制，丢弃挂起的那一帧。
   *
   * 给"渲染结果马上要被读"的路径用：构造期的首帧、teardown、以及尺寸
   * 变化后必须立刻重算命中区的情况。挂起帧若已带 force，合并进本次。
   */
  flush(): void {
    if (this.#disposed) return;
    const hadPending = this.#handle !== undefined;
    const forced = this.#force;
    if (hadPending) {
      this.#cancel(this.#handle);
      this.#handle = undefined;
    }
    this.#force = false;
    // 没有挂起帧、也没有 force 需求时不必空跑一帧。
    if (!hadPending && !forced) return;
    this.#frames += 1;
    this.#render(forced);
  }

  /** 取消挂起帧并停止接受新请求（退出时调用，避免定时器吊住进程）。 */
  dispose(): void {
    if (this.#handle !== undefined) {
      this.#cancel(this.#handle);
      this.#handle = undefined;
    }
    this.#force = false;
    this.#disposed = true;
  }
}
