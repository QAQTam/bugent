import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSystemPrompt } from "../src/config/system-prompt.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("system prompt markdown", () => {
  test("默认从 src/prompts/system.md 读取", async () => {
    const loaded = await loadSystemPrompt({ cwd: process.cwd() });
    expect(loaded.source).toEndWith("src/prompts/system.md");
    expect(loaded.text).toContain("terminal-native coding agent");
  });

  test("配置路径优先，并按 cwd 解析相对路径", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bugent-prompt-"));
    dirs.push(dir);
    await writeFile(join(dir, "CUSTOM.md"), "CUSTOM PROMPT\n", "utf8");

    const loaded = await loadSystemPrompt({ cwd: dir, file: "CUSTOM.md" });
    expect(loaded.source).toBe(join(dir, "CUSTOM.md"));
    expect(loaded.text).toBe("CUSTOM PROMPT");
  });

  test("文件缺失时明确报错", async () => {
    await expect(
      loadSystemPrompt({ cwd: process.cwd(), file: "missing-prompt.md" }),
    ).rejects.toThrow("system prompt 文件不存在");
  });
});
