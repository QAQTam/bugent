/**
 * 帧调度器的合流语义。
 *
 * 这些用例是**回归防线**：流式文本曾经因为"没人请求重绘"退化成每 80ms 才
 * 吐一批，而漏掉一次请求不会报错、只会变慢。所以这里既钉住"请求一定兑现"，
 * 也钉住"窗口期内不重复兑现"。
 */

import { describe, expect, test } from "bun:test";
import { FrameScheduler } from "../src/tui/frame-scheduler.ts";

/** 可手动推进的假定时器：不依赖真实时间，用例是确定的。 */
function makeClock() {
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();

  return {
    schedule(fn: () => void, ms: number): unknown {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, ms });
      return id;
    },
    cancel(handle: unknown): void {
      timers.delete(handle as number);
    },
    get pending(): number {
      return timers.size;
    },
    /** 窗口到期：把所有挂起的回调跑掉。 */
    expire(): void {
      const due = [...timers.values()];
      timers.clear();
      for (const timer of due) timer.fn();
    },
    /** 最近一次注册的窗口长度，用来确认默认值没被改坏。 */
    lastMs(): number | undefined {
      return [...timers.values()].at(-1)?.ms;
    },
  };
}

function setup(intervalMs?: number) {
  const clock = makeClock();
  const calls: boolean[] = [];
  const scheduler = new FrameScheduler({
    render: (force) => calls.push(force),
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  return { clock, calls, scheduler };
}

describe("FrameScheduler", () => {
  test("窗口期内多次请求只渲染一帧", () => {
    const { clock, calls, scheduler } = setup();

    for (let i = 0; i < 20; i += 1) scheduler.request();
    expect(calls).toHaveLength(0);
    expect(scheduler.pending).toBe(true);

    clock.expire();
    expect(calls).toEqual([false]);
    expect(scheduler.frames).toBe(1);
  });

  test("窗口到期后可以再次请求", () => {
    const { clock, calls, scheduler } = setup();

    scheduler.request();
    clock.expire();
    scheduler.request();
    clock.expire();

    expect(calls).toHaveLength(2);
    expect(scheduler.frames).toBe(2);
  });

  test("force 会被合流保留，不会被后来的普通请求冲掉", () => {
    const { clock, calls, scheduler } = setup();

    scheduler.request(true);
    scheduler.request();
    scheduler.request(false);
    clock.expire();

    expect(calls).toEqual([true]);
  });

  test("普通请求之后来的 force 也能生效", () => {
    const { clock, calls, scheduler } = setup();

    scheduler.request();
    scheduler.request(true);
    clock.expire();

    expect(calls).toEqual([true]);
  });

  test("force 不跨帧残留：第二帧回到普通渲染", () => {
    const { clock, calls, scheduler } = setup();

    scheduler.request(true);
    clock.expire();
    scheduler.request();
    clock.expire();

    expect(calls).toEqual([true, false]);
  });

  test("默认合流窗口是 16ms", () => {
    const { clock, scheduler } = setup();
    scheduler.request();
    expect(clock.lastMs()).toBe(16);
  });

  test("flush 立刻渲染并丢弃挂起的那一帧", () => {
    const { clock, calls, scheduler } = setup();

    scheduler.request();
    expect(clock.pending).toBe(1);

    scheduler.flush();
    expect(calls).toEqual([false]);
    expect(clock.pending).toBe(0);
    expect(scheduler.pending).toBe(false);

    // 挂起帧已被丢弃，窗口到期不该再画一次。
    clock.expire();
    expect(calls).toEqual([false]);
  });

  test("flush 会带上挂起帧的 force", () => {
    const { calls, scheduler } = setup();
    scheduler.request(true);
    scheduler.flush();
    expect(calls).toEqual([true]);
  });

  test("没有挂起帧时 flush 是空操作", () => {
    const { calls, scheduler } = setup();
    scheduler.flush();
    expect(calls).toHaveLength(0);
    expect(scheduler.frames).toBe(0);
  });

  test("dispose 取消挂起帧，且之后不再渲染", () => {
    const { clock, calls, scheduler } = setup();

    scheduler.request();
    scheduler.dispose();

    expect(clock.pending).toBe(0);
    expect(scheduler.pending).toBe(false);

    clock.expire();
    scheduler.request();
    clock.expire();
    expect(calls).toHaveLength(0);
  });

  test("dispose 之后 flush 也是空操作", () => {
    const { calls, scheduler } = setup();
    scheduler.dispose();
    scheduler.flush();
    expect(calls).toHaveLength(0);
  });
});
