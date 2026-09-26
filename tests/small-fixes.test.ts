/**
 * 小修回归（BUG-026 / BUG-027）。
 */

import { describe, expect, test } from "bun:test";
import { parseConfigToml } from "../src/config/toml.ts";
import { stripAnsi } from "../src/util/sanitize.ts";

describe("BUG-026: config.toml 类型收窄", () => {
  const base = `default_model = "mock/m"\n`;

  test("extra_body 写成字符串/数组时拒绝，不再展开成索引垃圾", () => {
    expect(() =>
      parseConfigToml(
        `${base}\n[[providers]]\nid = "mock"\nendpoint = "mock"\n[providers.extra_body]\nx = 1\n`,
      ),
    ).not.toThrow();
    expect(() =>
      parseConfigToml(`${base}\nproviders = [{ id = "mock", endpoint = "mock", extra_body = "hi" }]`),
    ).toThrow(/extra_body/);
    expect(() =>
      parseConfigToml(`${base}\nproviders = [{ id = "mock", endpoint = "mock", extra_body = [1] }]`),
    ).toThrow(/extra_body/);
  });

  test("max_steps 必须是正整数", () => {
    const withProvider = `${base}\n[[providers]]\nid = "mock"\nendpoint = "mock"\n`;
    expect(() => parseConfigToml(`${withProvider}\n[agent]\nmax_steps = 800\n`)).not.toThrow();
    expect(() => parseConfigToml(`${withProvider}\n[agent]\nmax_steps = -1\n`)).toThrow(/max_steps/);
    expect(() => parseConfigToml(`${withProvider}\n[agent]\nmax_steps = 1.5\n`)).toThrow(/max_steps/);
  });
});

describe("BUG-027: stripAnsi", () => {
  test("剥掉 CSI / OSC 与游离 ESC，正文保留", () => {
    expect(stripAnsi("\x1b[2J\x1b[Hclear\x1b[0m")).toBe("clear");
    expect(stripAnsi("\x1b]0;title\x07body")).toBe("body");
    expect(stripAnsi("a\x1bb")).toBe("ab");
    expect(stripAnsi("普通中文\n保留换行")).toBe("普通中文\n保留换行");
  });
});
