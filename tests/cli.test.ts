import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/index.ts";
import { BUGENT_VERSION } from "../src/version.ts";

describe("CLI", () => {
  test("--version 使用 0.0.0 版本常量", () => {
    expect(BUGENT_VERSION).toBe("0.0.0");
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  test("默认仍以当前目录启动", () => {
    const options = parseArgs([]);
    expect(options.version).toBe(false);
    expect(options.cwd).toBe(process.cwd());
  });
});
