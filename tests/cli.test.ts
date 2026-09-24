import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/index.ts";
import { BUGENT_VERSION } from "../src/version.ts";

describe("CLI", () => {
  test("版本常量与 package.json 一致", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
      version?: unknown;
    };
    // 写死版本号的话每次发版都要改两处，忘了改就会让 `--version` 撒谎
    expect(BUGENT_VERSION).toBe(String(pkg.version));
    expect(BUGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("--version / -v 走同一个开关", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  test("默认仍以当前目录启动", () => {
    const options = parseArgs([]);
    expect(options.version).toBe(false);
    expect(options.cwd).toBe(process.cwd());
  });
});
