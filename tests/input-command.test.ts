import { describe, expect, test } from "bun:test";
import { looksLikeSlashCommand } from "../src/tui/input-command.ts";

describe("输入框 slash command 判定", () => {
  test("命令名与带参数命令仍被识别", () => {
    expect(looksLikeSlashCommand("/")).toBe(true);
    expect(looksLikeSlashCommand("/help")).toBe(true);
    expect(looksLikeSlashCommand("/goal status")).toBe(true);
    expect(looksLikeSlashCommand("/model provider/model")).toBe(true);
    expect(looksLikeSlashCommand("/foo-bar")).toBe(true);
  });

  test("绝对路径不会被误判为命令", () => {
    expect(looksLikeSlashCommand("/home/qaqtamsy/项目/bugent")).toBe(false);
    expect(looksLikeSlashCommand("/usr/bin/env bash")).toBe(false);
    expect(looksLikeSlashCommand("/tmp/file.txt")).toBe(false);
    expect(looksLikeSlashCommand("//server/share")).toBe(false);
  });

  test("普通文本不受影响", () => {
    expect(looksLikeSlashCommand("hello")).toBe(false);
    expect(looksLikeSlashCommand("relative/path")).toBe(false);
    expect(looksLikeSlashCommand("  ")).toBe(false);
  });
});
