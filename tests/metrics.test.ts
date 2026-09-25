/**
 * 状态栏三项指标的测试：速度计（滑动窗口 + 自校准）、会话累计量、格式化与降级。
 */

import { describe, expect, test } from "bun:test";
import {
  cacheHitRate,
  contextOccupancy,
  formatMetrics,
  formatPercent,
  formatSpeed,
  formatTokenCount,
  StreamMeter,
} from "../src/tui/metrics.ts";
import { defaultContextWindow } from "../src/provider/model-window.ts";
import type { TokenCounter } from "../src/util/tokenizer.ts";

const plain = (text: string): string => Bun.stripANSI(text);

/** 固定每笔增量的计数器，方便算清楚期望值。 */
const fixedCounter = (tokens: number, kind: TokenCounter["kind"] = "heuristic"): TokenCounter => ({
  kind,
  count: () => tokens,
});

describe("StreamMeter 滑动窗口速度", () => {
  test("窗口内 token 数 ÷ 窗口跨度", () => {
    let now = 0;
    const meter = new StreamMeter({ now: () => now, counter: fixedCounter(5) });

    meter.noteDelta("x");
    now = 1000;
    meter.noteDelta("x");

    // 两笔各 5 token，跨度 1s
    expect(meter.rate()).toBeCloseTo(10, 5);
  });

  test("窗口排空后归零，并告诉 UI 不用再刷新", () => {
    let now = 0;
    const meter = new StreamMeter({ now: () => now, counter: fixedCounter(5) });
    meter.noteDelta("x");
    expect(meter.active()).toBe(true);

    // 窗口 3s：刚过窗口时样本被裁掉，读数归零
    now = 3001;
    expect(meter.active()).toBe(false);
    expect(meter.rate()).toBe(0);
  });

  test("跨度不足时用下限做除数，避免第一笔算出天文数字", () => {
    const meter = new StreamMeter({ now: () => 0, counter: fixedCounter(5) });
    meter.noteDelta("x");
    // 5 token / 250ms = 20 tok/s
    expect(meter.rate()).toBeCloseTo(20, 5);
  });

  test("启发式计数用服务端 usage 自校准", () => {
    let now = 0;
    const meter = new StreamMeter({ now: () => now, counter: fixedCounter(10) });
    expect(meter.calibrated).toBe(false);

    meter.noteDelta("a");
    meter.noteDelta("a");
    meter.noteDelta("a"); // 估了 30
    meter.noteUsage({ input: 0, output: 60 }); // 真值 60 → 系数 2
    expect(meter.calibrated).toBe(true);

    meter.noteDelta("a"); // 这一笔按 20 计
    now = 1000;
    expect(meter.rate()).toBeCloseTo(50, 5);
  });

  test("真 tokenizer 不参与校准（本来就准）", () => {
    let now = 0;
    const meter = new StreamMeter({ now: () => now, counter: fixedCounter(10, "deepseek-bpe") });
    meter.noteDelta("a");
    meter.noteUsage({ input: 0, output: 100 });
    meter.noteDelta("a");
    now = 1000;

    expect(meter.calibrated).toBe(false);
    expect(meter.rate()).toBeCloseTo(20, 5);
  });

  test("usage 的 output 为 0 时不动系数（拿不到真值就别校准）", () => {
    const meter = new StreamMeter({ now: () => 0, counter: fixedCounter(10) });
    meter.noteDelta("a");
    meter.noteUsage({ input: 100, output: 0 });
    expect(meter.calibrated).toBe(false);
  });
});

describe("会话级累计指标", () => {
  test("缓存命中率 = 累计 cached ÷ 累计 input", () => {
    expect(cacheHitRate({ input: 100, output: 5, cached: 80 })).toBeCloseTo(0.8, 5);
    // provider 没回传 → undefined（不是 0%）
    expect(cacheHitRate({ input: 100, output: 5 })).toBeUndefined();
    // 一次都没发过 → 分母为 0，不编比例
    expect(cacheHitRate({ input: 0, output: 0, cached: 0 })).toBeUndefined();
  });

  test("上下文占用取最近一次请求，而不是累计", () => {
    const occupancy = contextOccupancy({ input: 120_000, output: 500 }, 128_000);
    expect(occupancy).toEqual({ used: 120_500, window: 128_000, ratio: 120_500 / 128_000 });

    // 没收到 usage / 窗口未知
    expect(contextOccupancy(undefined, 128_000)).toBeUndefined();
    expect(contextOccupancy({ input: 1000, output: 0 })).toEqual({ used: 1000 });
  });

  test("内置上下文窗口兜底表", () => {
    expect(defaultContextWindow("deepseek-v4.1-flash")).toBe(128_000);
    expect(defaultContextWindow("gpt-5.4")).toBe(272_000);
    expect(defaultContextWindow("some-local-model")).toBeUndefined();
  });
});

describe("指标格式化", () => {
  const view = {
    context: { used: 24_100, window: 128_000, ratio: 24_100 / 128_000 },
    cacheRate: 0.87,
    tokensPerSecond: 42.34,
  };

  test("full 档：三样都带标签", () => {
    expect(plain(formatMetrics(view, "full"))).toBe("ctx 24.1k/128k 19% · cache 87% · 42.3 tok/s");
  });

  test("compact / minimal 逐档变短", () => {
    expect(plain(formatMetrics(view, "compact"))).toBe("ctx 19% · cache 87% · 42.3 tok/s");
    expect(plain(formatMetrics(view, "minimal"))).toBe("19% · 87% · 42.3/s");
  });

  test("拿不到的数据不显示，不编造", () => {
    expect(plain(formatMetrics({ tokensPerSecond: 0 }, "full"))).toBe("0.0 tok/s");
    expect(plain(formatMetrics({ ...view, cacheRate: undefined }, "full"))).toBe(
      "ctx 24.1k/128k 19% · 42.3 tok/s",
    );
  });

  test("估算值带 ~ 前缀", () => {
    expect(plain(formatMetrics({ tokensPerSecond: 12.3, estimated: true }, "full"))).toBe(
      "~12.3 tok/s",
    );
  });

  test("token 数与速度的缩写规则", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(24_100)).toBe("24.1k");
    expect(formatTokenCount(128_000)).toBe("128k");
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
    expect(formatSpeed(9.94)).toBe("9.9");
    expect(formatSpeed(128.4)).toBe("128");
  });

  test("百分比：小占用不取整成 0%", () => {
    expect(formatPercent(0.003)).toBe("0.3%");
    expect(formatPercent(0.099)).toBe("9.9%");
    expect(formatPercent(0.188)).toBe("19%");
    expect(formatPercent(1)).toBe("100%");
  });
});
