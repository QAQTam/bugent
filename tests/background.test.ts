import { describe, expect, test } from "bun:test";
import {
  backgroundFromColor,
  backgroundFromColorFgbg,
  detectTerminalBackground,
  OSC11_QUERY,
  parseOsc11Reply,
  perceivedLuminance,
  type BackgroundDetection,
} from "../src/tui/background.ts";

describe("OSC 11 应答解析", () => {
  test("BEL 结尾的 4 位通道", () => {
    expect(parseOsc11Reply("\x1b]11;rgb:1e1e/1e1e/1e1e\x07")).toBe("#1e1e1e");
    expect(parseOsc11Reply("\x1b]11;rgb:ffff/ffff/ffff\x07")).toBe("#ffffff");
  });

  test("ST 结尾同样认", () => {
    expect(parseOsc11Reply("\x1b]11;rgb:f5f5/f5f5/f5f5\x1b\\")).toBe("#f5f5f5");
  });

  test("2 位通道按自己的位宽归一化", () => {
    expect(parseOsc11Reply("\x1b]11;rgb:00/00/00\x07")).toBe("#000000");
    expect(parseOsc11Reply("\x1b]11;rgb:ff/80/00\x07")).toBe("#ff8000");
  });

  test("不是应答时返回 undefined", () => {
    expect(parseOsc11Reply("")).toBeUndefined();
    expect(parseOsc11Reply("\x1b]0;title\x07")).toBeUndefined();
    expect(parseOsc11Reply("\x1b]11;?\x07")).toBeUndefined();
  });
});

describe("深浅判定", () => {
  test("感知亮度", () => {
    expect(perceivedLuminance("#000000")).toBeCloseTo(0, 5);
    expect(perceivedLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  test("常见深色底色判为 dark", () => {
    for (const hex of ["#000000", "#1e1e1e", "#282c34", "#002b36", "#1e2430"]) {
      expect(backgroundFromColor(hex)).toBe("dark");
    }
  });

  test("常见浅色底色判为 light", () => {
    for (const hex of ["#ffffff", "#f5f5f5", "#fdf6e3", "#c0c0c0"]) {
      expect(backgroundFromColor(hex)).toBe("light");
    }
  });

  test("ANSI 8（亮黑）算深色 —— 阈值取 0.6 而不是 0.5 的原因", () => {
    expect(perceivedLuminance("#808080")).toBeGreaterThan(0.5);
    expect(backgroundFromColor("#808080")).toBe("dark");
  });
});

describe("COLORFGBG 解析", () => {
  test("取最后一个字段作为背景色索引", () => {
    expect(backgroundFromColorFgbg("0;15")).toBe("light");
    expect(backgroundFromColorFgbg("15;0")).toBe("dark");
    expect(backgroundFromColorFgbg("0;7")).toBe("light");
    expect(backgroundFromColorFgbg("0;8")).toBe("dark");
  });

  test("缺失或非法时返回 undefined", () => {
    expect(backgroundFromColorFgbg(undefined)).toBeUndefined();
    expect(backgroundFromColorFgbg("")).toBeUndefined();
    expect(backgroundFromColorFgbg("abc")).toBeUndefined();
    expect(backgroundFromColorFgbg("0;99")).toBeUndefined();
    expect(backgroundFromColorFgbg("0;-1")).toBeUndefined();
  });
});

/** 把 detectTerminalBackground 的 I/O 换成可控的假终端。 */
function harness(options: {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
} = {}): {
  written: string[];
  detection: Promise<BackgroundDetection>;
  push: (chunk: string) => void;
  subscribed: () => boolean;
} {
  const written: string[] = [];
  let handler: ((chunk: string) => void) | undefined;
  const detection = detectTerminalBackground({
    write: (text) => written.push(text),
    subscribe: (next) => {
      handler = next;
      return () => {
        handler = undefined;
      };
    },
    env: options.env ?? {},
    timeoutMs: options.timeoutMs ?? 30,
  });
  return {
    written,
    detection,
    push: (chunk) => handler?.(chunk),
    subscribed: () => handler !== undefined,
  };
}

describe("底色探测", () => {
  test("有 COLORFGBG 就直接用，不发查询", async () => {
    const h = harness({ env: { COLORFGBG: "0;15" } });
    expect(await h.detection).toEqual({ background: "light", source: "colorfgbg" });
    expect(h.written).toEqual([]);
  });

  test("没有线索时发 OSC 11 查询，按应答判定", async () => {
    const h = harness();
    expect(h.written).toEqual([OSC11_QUERY]);
    h.push("\x1b]11;rgb:ffff/ffff/ffff\x07");
    expect(await h.detection).toEqual({ background: "light", source: "osc11" });
    // 拿到答案后要退订，别把监听留在终端上
    expect(h.subscribed()).toBe(false);
  });

  test("应答跨 chunk 切断也能判定", async () => {
    const h = harness();
    h.push("\x1b]11;rgb:1e");
    h.push("1e/1e1e/1e1e\x07");
    expect(await h.detection).toEqual({ background: "dark", source: "osc11" });
  });

  test("终端不回应时超时回退到 dark", async () => {
    const h = harness({ timeoutMs: 20 });
    expect(await h.detection).toEqual({ background: "dark", source: "default" });
    expect(h.subscribed()).toBe(false);
  });

  test("应答里夹杂其它 OSC 也能挑出底色", async () => {
    const h = harness();
    h.push("\x1b]0;window title\x07\x1b]11;rgb:1e1e/1e1e/1e1e\x07");
    expect(await h.detection).toEqual({ background: "dark", source: "osc11" });
  });
});
