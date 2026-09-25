import { describe, expect, test } from "bun:test";
import { splitRevealUnits, StreamPacer } from "../src/tui/stream-pacer.ts";

describe("StreamPacer", () => {
  test("flush 原样拼回所有文本", () => {
    const pacer = new StreamPacer();
    pacer.push("你好");
    pacer.push(" world");
    expect(pacer.flush()).toBe("你好 world");
    expect(pacer.pending).toBe(false);
  });

  test("小 delta 保持原子，不会把逐字流合成大块", () => {
    expect(splitRevealUnits("a")).toEqual(["a"]);
    expect(splitRevealUnits("你")).toEqual(["你"]);
    expect(splitRevealUnits("**hi**")).toEqual(["**hi**"]);
  });

  test("大 delta 会拆成接近 1 token 的显示单元", () => {
    const units = splitRevealUnits(
      "这是一个很长的中文回答，会在一次网络读取里突然到达很多内容。",
    );
    expect(units.length).toBeGreaterThan(10);
    expect(units.every((unit) => unit.length > 0)).toBe(true);
    expect(units.join("")).toBe("这是一个很长的中文回答，会在一次网络读取里突然到达很多内容。");
  });

  test("10ms 一个字符的节奏不会被压成低频批次", () => {
    let now = 0;
    const pacer = new StreamPacer({ now: () => now });
    const shown: string[] = [];

    for (let i = 0; i < 20; i += 1) {
      now += 10;
      pacer.push("x", now);
      now += 8.333;
      const text = pacer.drain(now);
      if (text.length > 0) shown.push(text);
    }

    expect(shown.length).toBeGreaterThanOrEqual(18);
    expect(shown.join("")).toBe("x".repeat(20));
  });

  test("突发被摊到多帧，而不是一帧整块出现", () => {
    let now = 0;
    const pacer = new StreamPacer({ now: () => now });
    pacer.push("one two three four five six seven eight nine ten", now);

    const batches: string[] = [];
    while (pacer.pending) {
      now += 8.333;
      const text = pacer.drain(now);
      if (text.length > 0) batches.push(text);
    }

    expect(batches.length).toBeGreaterThanOrEqual(5);
    expect(batches.join("")).toBe("one two three four five six seven eight nine ten");
  });

  test("延迟超过阈值后有限追帧，不无限落后", () => {
    let now = 0;
    const pacer = new StreamPacer({ now: () => now, catchUpAfterMs: 50 });
    pacer.push("one two three four five six seven eight nine ten", now);

    now = 60;
    const first = pacer.drain(now);
    now = 68.333;
    const second = pacer.drain(now);

    expect(first.length + second.length).toBeGreaterThan(8);
    expect(pacer.queuedTokens).toBeLessThan(8);
  });

  test("大突发部分消费后继续入队和 flush 不丢顺序", () => {
    let now = 0;
    const pacer = new StreamPacer({ now: () => now });
    const burst = "x".repeat(5000);
    pacer.push(burst, now);

    now += 100;
    const first = pacer.drain(now);
    pacer.push("TAIL", now);
    const rest = pacer.flush();

    expect(first.length).toBeGreaterThan(0);
    expect(first + rest).toBe(`${burst}TAIL`);
  });

  test("reset 会丢弃旧 turn 的未显示文本", () => {
    const pacer = new StreamPacer();
    pacer.push("old");
    pacer.reset();
    expect(pacer.pending).toBe(false);
    expect(pacer.flush()).toBe("");
  });
});
