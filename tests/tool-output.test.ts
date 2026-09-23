import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactDiff, diffLines, diffStat, formatDiff, formatDiffStat, parseDiffStat } from "../src/tools/diff.ts";
import { createBashTool, createShellRunner, MAX_MODEL_OUTPUT_CHARS } from "../src/tools/bash.ts";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
  MAX_READ_CHARS,
  MAX_READ_LINES,
} from "../src/tools/files.ts";
import { renderDiffTool } from "../src/tui/render-tools.ts";
import { visibleWidth } from "../src/tui/ansi.ts";
import type { ToolItem } from "../src/tui/renderers.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace(prefix = "bugent-out-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const ctxFor = (cwd: string, sessionId = "s1"): ToolCtx => ({
  cwd,
  signal: new AbortController().signal,
  callId: "c1",
  sessionId,
});

describe("diff", () => {
  test("识别增删改", () => {
    const lines = diffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(lines).toEqual([
      { kind: " ", text: "a" },
      { kind: "-", text: "b" },
      { kind: "+", text: "B" },
      { kind: " ", text: "c" },
      { kind: " ", text: "" },
    ]);
  });

  test("diffStat 统计增删", () => {
    expect(diffStat(diffLines("a\nb\n", "a\nc\nd\n"))).toEqual({ added: 2, removed: 1 });
  });

  test("compactDiff 裁掉远处上下文并标记省略", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    const after = before.replace("line20", "CHANGED");

    const compact = compactDiff(diffLines(before, after));

    // 只有变更点附近保留，其余折叠
    expect(compact.length).toBeLessThan(15);
    expect(compact.some((l) => l.text.includes("省略"))).toBe(true);
    expect(compact.some((l) => l.kind === "+" && l.text === "CHANGED")).toBe(true);
  });

  test("无变更时 compactDiff 返回空", () => {
    expect(compactDiff(diffLines("same\n", "same\n"))).toEqual([]);
  });

  test("超大内容退化为行数摘要，不建 DP 表", () => {
    const huge = Array.from({ length: 2000 }, (_, i) => `l${i}`).join("\n");
    const lines = diffLines(huge, "small");
    expect(lines[0]?.text).toContain("超过");
  });

  test("formatDiff 首行是统计头", () => {
    const text = formatDiff(diffLines("a\n", "b\n"), "已编辑 x.ts");
    expect(text.split("\n")[0]).toBe("已编辑 x.ts");
  });
});

describe("bash 输出截断与落盘", () => {
  test(`超过 ${MAX_MODEL_OUTPUT_CHARS} 字符时截断，并给出完整输出路径`, async () => {
    const home = await workspace("bugent-home-");
    const cwd = await workspace();
    const previousHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const tool = createBashTool(createShellRunner());
      const out = await tool.run(
        { command: `yes 'xxxxxxxxxxxxxxxxxxxx' | head -n 500` },
        ctxFor(cwd),
      );

      expect(out).toContain("已省略");
      expect(out).toContain("完整输出共");
      expect(out).toContain("read_file");

      // 落盘文件确实存在且是完整内容
      const match = /已写入：(.+?)\]/u.exec(out);
      expect(match).not.toBeNull();
      const path = match![1]!;
      const full = await readFile(path, "utf8");
      expect(full.length).toBeGreaterThan(MAX_MODEL_OUTPUT_CHARS);
      expect(full).toContain("xxxxxxxxxxxxxxxxxxxx");
    } finally {
      process.env.HOME = previousHome;
    }
  });

  test("短输出不落盘，原样返回", async () => {
    const home = await workspace("bugent-home-");
    const cwd = await workspace();
    const previousHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const tool = createBashTool(createShellRunner());
      const out = await tool.run({ command: "echo short" }, ctxFor(cwd));
      expect(out).toContain("short");
      expect(out).not.toContain("已省略");
    } finally {
      process.env.HOME = previousHome;
    }
  });

  test("onProgress 能把输出流式推给 UI", async () => {
    const cwd = await workspace();
    const chunks: string[] = [];
    const tool = createBashTool(createShellRunner());

    await tool.run(
      { command: "echo one; echo two" },
      { ...ctxFor(cwd), onProgress: (chunk) => chunks.push(chunk) },
    );

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toContain("one");
  });
});

describe("diff 统计徽标", () => {
  test("从工具输出反解 +N -M", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.ts"), "l1\nl2\nl3\nl4\nl5\n");

    const output = await createEditFileTool().run(
      { path: "a.ts", old_string: "l2\nl3", new_string: "新的一行\n第二行\n第三行" },
      ctxFor(cwd),
    );

    // 删 2 行、加 3 行
    expect(parseDiffStat(output)).toEqual({ added: 3, removed: 2 });
  });

  test("新建文件是 +N -0", async () => {
    const cwd = await workspace();
    const output = await createWriteFileTool().run(
      { path: "new.txt", content: "a\nb\nc" },
      ctxFor(cwd),
    );
    expect(parseDiffStat(output)).toEqual({ added: 3, removed: 0 });
  });

  test("无变更时返回 undefined", () => {
    expect(parseDiffStat("已编辑 a.ts（替换 1 处）")).toBeUndefined();
    expect(parseDiffStat("")).toBeUndefined();
  });

  test("摘要行里的数字不会被误算（只从第二行起数）", () => {
    // 首行即使以 + 开头也不算
    expect(parseDiffStat("+5 -3\n context")).toBeUndefined();
  });

  test("省略提示行（以空格开头）不计入", () => {
    const text = "已编辑 x\n ⋯ 省略 100 行未变更内容\n-old\n+new";
    expect(parseDiffStat(text)).toEqual({ added: 1, removed: 1 });
  });

  test("formatDiffStat 省略为 0 的部分", () => {
    expect(formatDiffStat({ added: 5, removed: 0 })).toBe("+5");
    expect(formatDiffStat({ added: 0, removed: 3 })).toBe("-3");
    expect(formatDiffStat({ added: 2, removed: 3 })).toBe("+2 -3");
  });

  test("徽标右对齐到指定宽度", () => {
    const item: ToolItem = {
      kind: "tool",
      callId: "c1",
      name: "edit_file",
      args: { path: "src/a.ts" },
      output: "已编辑 src/a.ts\n-old\n+new",
      ok: true,
      done: true,
      progress: "",
      expanded: false,
    };

    const [head] = renderDiffTool(item, 60);
    // 去掉颜色后，可见宽度应正好等于给定宽度，且以 -1 结尾
    expect(visibleWidth(head!)).toBeLessThanOrEqual(60);
    const plain = head!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain.endsWith("+1 -1")).toBe(true);
  });

  test("窄屏时压缩摘要但保留徽标", () => {
    const item: ToolItem = {
      kind: "tool",
      callId: "c1",
      name: "edit_file",
      args: { path: "一个非常长的路径/深/深/深/文件.ts" },
      output: "已编辑 x\n-a\n+b",
      ok: true,
      done: true,
      progress: "",
      expanded: false,
    };

    const [head] = renderDiffTool(item, 30);
    const plain = head!.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("+1 -1"); // 徽标不能被挤掉
    expect(visibleWidth(head!)).toBeLessThanOrEqual(30);
  });

  test("折叠时保留开头（改动在中段，头尾折叠会把它藏起来）", () => {
    const item: ToolItem = {
      kind: "tool",
      callId: "c1",
      name: "edit_file",
      args: { path: "a.ts" },
      output: ["已编辑 a.ts", ...Array.from({ length: 30 }, (_, i) => `${i === 5 ? "+" : " "}l${i}`)].join("\n"),
      ok: true,
      done: true,
      progress: "",
      expanded: false,
    };

    const lines = renderDiffTool(item, 80).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
    // 改动行在开头范围内，必须可见
    expect(lines.some((line) => line.includes("+l5"))).toBe(true);
    expect(lines.some((line) => line.includes("还有"))).toBe(true);
  });

  test("展开后显示全部 diff 行", () => {
    const item: ToolItem = {
      kind: "tool",
      callId: "c1",
      name: "edit_file",
      args: { path: "a.ts" },
      output: ["已编辑 a.ts", ...Array.from({ length: 30 }, (_, i) => ` l${i}`)].join("\n"),
      ok: true,
      done: true,
      progress: "",
      expanded: true,
    };

    const lines = renderDiffTool(item, 80);
    expect(lines.some((line) => line.includes("还有"))).toBe(false);
  });

  test("失败时不显示徽标", () => {
    const item: ToolItem = {
      kind: "tool",
      callId: "c1",
      name: "edit_file",
      args: { path: "a.ts" },
      output: "Error: 找不到 old_string",
      ok: false,
      done: true,
      progress: "",
      expanded: false,
    };

    const [head] = renderDiffTool(item, 60);
    expect(head).not.toContain("+");
  });
});

describe("read_file 截断", () => {

  test(`默认最多读 ${MAX_READ_LINES} 行`, async () => {
    const cwd = await workspace();
    const content = Array.from({ length: 1200 }, (_, i) => `line${i}`).join("\n");
    await writeFile(join(cwd, "big.txt"), content);

    const out = await createReadFileTool().run({ path: "big.txt" }, ctxFor(cwd));

    expect(out).toContain("offset=");
    // 输出本身不应超过字符上限太多（含头尾提示）
    expect(out.length).toBeLessThan(MAX_READ_CHARS + 500);
  });

  test("单行超长时按字符上限截断（行数限制挡不住）", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "oneline.txt"), "y".repeat(50_000));

    const out = await createReadFileTool().run({ path: "oneline.txt" }, ctxFor(cwd));
    expect(out.length).toBeLessThan(MAX_READ_CHARS + 500);
  });

  test("小文件完整返回且不提示截断", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "small.txt"), "a\nb\nc\n");

    const out = await createReadFileTool().run({ path: "small.txt" }, ctxFor(cwd));
    expect(out).toContain("1\ta");
    expect(out).not.toContain("还有");
  });
});
