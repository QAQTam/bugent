import { describe, expect, test } from "bun:test";
import { createBashTool, type ShellRunner } from "../src/tools/bash.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import type { ToolItem } from "../src/tui/renderers.ts";
import {
  classifyBashLine,
  parseBashPresentation,
  renderBashTool,
} from "../src/tui/render-tools.ts";
import { clearHighlightCache, highlightCode } from "../src/tui/highlight.ts";

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("bash 输出语义高亮", () => {
  test("stdout / stderr / exit code 被结构化为不同段", () => {
    const presentation = parseBashPresentation(
      "hello\n--- stderr ---\nerror: failed\n[exit code: 1]",
    );

    expect(presentation.segments).toEqual([
      { kind: "stdout", text: "hello" },
      { kind: "stderr", text: "error: failed" },
    ]);
    expect(presentation.exitCode).toBe(1);
  });

  test("语义分类覆盖 error / warning / success / path / url", () => {
    expect(classifyBashLine("error: failed", "stdout")).toBe("error");
    expect(classifyBashLine("warning: deprecated", "stdout")).toBe("warn");
    expect(classifyBashLine("PASS src/a.test.ts", "stdout")).toBe("success");
    expect(classifyBashLine("src/a.ts:12:3", "stdout")).toBe("path");
    expect(classifyBashLine("https://example.com/x", "stdout")).toBe("url");
    expect(classifyBashLine("ordinary output", "stderr")).toBe("error");
    expect(classifyBashLine("错误：失败", "stdout")).toBe("error");
    expect(classifyBashLine("警告：已弃用", "stdout")).toBe("warn");
    expect(classifyBashLine("测试通过", "stdout")).toBe("success");
  });

  test("渲染时 stdout、stderr、exit code 使用不同颜色", () => {
    const item: ToolItem = {
      kind: "tool",
      callId: "c1",
      name: "bash",
      args: { command: "echo hi" },
      output: "hello\n--- stderr ---\nerror: failed\n[exit code: 1]",
      ok: true,
      done: true,
      progress: "",
      presentation: {
        kind: "bash",
        command: "echo hi",
        segments: [
          { kind: "stdout", text: "hello" },
          { kind: "stderr", text: "error: failed" },
        ],
        exitCode: 1,
        timedOut: false,
        aborted: false,
        truncated: false,
      },
      expanded: false,
    };

    const rendered = renderBashTool(item, 80).join("\n");
    expect(strip(rendered)).toContain("hello");
    expect(strip(rendered)).toContain("[exit code: 1]");
    expect(rendered).toContain("\x1b[");
    expect(rendered).not.toContain("--- stderr ---");
    const foregrounds = new Set(rendered.match(/\x1b\[38;5;\d+m/g) ?? []);
    expect(foregrounds.size).toBeGreaterThan(1);
  });

  test("BashTool 生成结构化 presentation，并保留 progress stream", async () => {
    const runner: ShellRunner = {
      async run(options) {
        options.onProgress?.("out", "stdout");
        options.onProgress?.("err", "stderr");
        return {
          stdout: "hello\n",
          stderr: "warning: x\n",
          exitCode: 0,
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 1,
          signalCode: null,
        };
      },
    };

    const presentations: unknown[] = [];
    const progress: Array<{ text: string; stream: string }> = [];
    const ctx: ToolCtx = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "s1",
      onProgress: (text, stream) => progress.push({ text, stream }),
      onPresentation: (value) => presentations.push(value),
    };

    await createBashTool(runner).run({ command: "echo hi" }, ctx);

    expect(progress).toEqual([
      { text: "out", stream: "stdout" },
      { text: "err", stream: "stderr" },
    ]);
    expect(presentations).toHaveLength(1);
    expect(presentations[0]).toMatchObject({
      kind: "bash",
      command: "echo hi",
      exitCode: 0,
      segments: [
        { kind: "stdout", text: "hello" },
        { kind: "stderr", text: "warning: x" },
      ],
    });
  });

  test("bash 命令可以走 highlight.js 语法高亮", async () => {
    clearHighlightCache();
    const command = "git diff --stat | rg copy";
    highlightCode(command, "bash");
    await Bun.sleep(400);

    const highlighted = highlightCode(command, "bash");
    expect(highlighted).toContain("\x1b[");
    expect(strip(highlighted)).toBe(command);
  });
});
