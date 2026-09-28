import { describe, expect, test } from "bun:test";
import { visibleWidth } from "../src/tui/ansi.ts";
import {
  composeSplash,
  mixHex,
  paintWordmark,
  wordmarkWidth,
  type SplashInfo,
  type SplashInput,
} from "../src/tui/splash.ts";

const plain = (text: string): string => Bun.stripANSI(text);

const info: SplashInfo = {
  version: "0.3.2",
  clientId: "deepseek/deepseek-chat",
  mode: "workspace-write",
  cwd: "D:\\bugent",
  sessionId: "sess-1a2b",
};

const splash = (overrides: Partial<SplashInput> = {}): string[] =>
  composeSplash({ width: 80, rows: 20, elapsedMs: 5_000, exit: 0, info, ...overrides });

/** 逐行可见宽度都不超过终端宽度 —— 超一列就会折行，把整块布局顶乱。 */
const withinWidth = (lines: readonly string[], width: number): boolean =>
  lines.every((line) => visibleWidth(line) <= width);

describe("开屏渲染", () => {
  test("行数严格等于正文高度", () => {
    for (const rows of [1, 2, 3, 5, 7, 12, 20, 40]) {
      expect(splash({ rows }).length).toBe(rows);
      expect(splash({ rows, width: 40 }).length).toBe(rows);
      expect(splash({ rows, width: 12 }).length).toBe(rows);
    }
  });

  test("任何尺寸下都不超宽", () => {
    for (const width of [8, 16, 24, 40, 60, 80, 120, 200]) {
      for (const rows of [1, 2, 4, 7, 12, 20, 40]) {
        expect(withinWidth(splash({ width, rows }), width)).toBe(true);
      }
    }
  });

  test("宽度或高度为 0 时返回空数组，不抛错", () => {
    expect(splash({ width: 0 })).toEqual([]);
    expect(splash({ rows: 0 })).toEqual([]);
    expect(splash({ width: -3, rows: -3 })).toEqual([]);
  });

  test("就绪状态一直在：矮终端也只是少说别的", () => {
    for (const rows of [2, 3, 5, 7, 12, 20]) {
      for (const width of [10, 20, 40, 80]) {
        const text = splash({ width, rows }).map(plain).join("\n");
        expect(text).toContain("已就绪");
      }
    }
  });

  test("同一输入渲染两次结果一致（纯函数）", () => {
    expect(splash()).toEqual(splash());
    expect(splash({ elapsedMs: 1_234 })).toEqual(splash({ elapsedMs: 1_234 }));
  });

  test("相位推进会改变画面", () => {
    const a = splash({ elapsedMs: 0 }).join("\n");
    const b = splash({ elapsedMs: 900 }).join("\n");
    const c = splash({ elapsedMs: 4_100 }).join("\n");
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
  });
});

describe("字标档位", () => {
  test("档位宽度：大字标 > 中字标 > 单行", () => {
    expect(wordmarkWidth("full")).toBeGreaterThan(wordmarkWidth("compact"));
    expect(wordmarkWidth("compact")).toBeGreaterThan(wordmarkWidth("mini"));
  });

  test("宽终端用大字标，中等终端降级，矮终端只留单行", () => {
    const full = splash({ width: 100, rows: 20 }).map(plain).join("\n");
    const compact = splash({ width: 60, rows: 7 }).map(plain).join("\n");
    const mini = splash({ width: 40, rows: 4 }).map(plain).join("\n");
    // 三档各有自己的独有字符：六行大字标的圆角下沿、半块字标的 ▄、单行字标的 ▐。
    expect(full).toContain("╚");
    expect(compact).not.toContain("╚");
    expect(compact).toContain("▄");
    expect(mini).not.toContain("▄");
    expect(mini).toContain("▐");
  });

  test("装不下的字标不会硬塞：窄终端退回单行，极窄终端连字标都不要", () => {
    const narrow = splash({ width: 24, rows: 10 }).map(plain).join("\n");
    expect(narrow).not.toContain("█");
    expect(narrow).toContain("BUGENT");
  });
});

describe("字标上色", () => {
  const art = ["████", "████"];

  test("逐列擦入：首帧还没画出来，最后全部画出来", () => {
    expect(paintWordmark(art, 0).map(plain).join("").trim()).toBe("");
    expect(plain(paintWordmark(art, 5_000)[0]!)).toBe("████");
  });

  test("上色只在色值变化时写转义，不是每字符一次", () => {
    const line = paintWordmark(["████████████████████████████"], 3_000)[0]!;
    const sequences = line.match(/\x1b\[38;2;/g) ?? [];
    expect(sequences.length).toBeGreaterThan(0);
    expect(sequences.length).toBeLessThan(29);
  });

  test("高光带会扫过：不同相位下同一列的颜色不一样", () => {
    const samples = [0, 600, 1_300, 2_000, 2_500].map(
      (elapsedMs) => paintWordmark(["████████████████████"], elapsedMs)[0]!,
    );
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  test("空字标返回空数组", () => {
    expect(paintWordmark([], 100)).toEqual([]);
    expect(paintWordmark(["   "], 100)).toEqual(["   "]);
  });
});

describe("退场", () => {
  test("exit=1 全部清空", () => {
    expect(splash({ exit: 1 }).every((line) => line === "")).toBe(true);
  });

  test("退场从外向内收：中间留得比两边久", () => {
    const lines = splash({ rows: 21, exit: 0.5 });
    const filled = lines.map((line, index) => (line === "" ? index : -1)).filter((i) => i >= 0);
    const center = 10;
    // 清掉的都是离中心更远的行：最后一个被清的行一定不在正中。
    expect(filled).not.toContain(center);
    expect(Math.min(...filled)).toBeLessThan(center);
    expect(Math.max(...filled)).toBeGreaterThan(center);
  });

  test("exit=0 时不动任何一行", () => {
    expect(splash({ exit: 0 })).toEqual(splash());
  });
});

describe("颜色混合", () => {
  test("两端取到原色，中间是插值", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  test("越界的比例被夹回 0..1", () => {
    expect(mixHex("#000000", "#ffffff", -5)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 5)).toBe("#ffffff");
  });
});
