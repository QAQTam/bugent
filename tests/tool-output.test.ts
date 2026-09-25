import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { renderBashTool, renderDiffTool } from "../src/tui/render-tools.ts";
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
    expect(lines[0]?.text).toContain("no line-by-line diff");
  });

  test("formatDiff 首行是统计头", () => {
    const text = formatDiff(diffLines("a\n", "b\n"), "edited x.ts");
    expect(text.split("\n")[0]).toBe("edited x.ts");
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

      expect(out).toContain("characters omitted");
      expect(out).toContain("full output is");
      expect(out).toContain("read_file");

      // 落盘文件确实存在且是完整内容
      const match = /written to: (.+?)\]/u.exec(out);
      expect(match).not.toBeNull();
      const path = match![1]!;
      const full = await readFile(path, "utf8");
      expect(full.length).toBeGreaterThan(MAX_MODEL_OUTPUT_CHARS);
      expect(full).toContain("xxxxxxxxxxxxxxxxxxxx");
    } finally {
      process.env.HOME = previousHome;
    }
  });

  test("超过内存上限时仍完整落盘，stdout/stderr 都不丢", async () => {
    const home = await workspace("bugent-home-");
    const cwd = await workspace();
    const previousHome = process.env.HOME;
    process.env.HOME = home;

    try {
      const tool = createBashTool(createShellRunner(), { maxOutputBytes: 1024 });
      const out = await tool.run(
        {
          command: "yes x | head -c 200000; printf '\\nSTDERR-TAIL\\n' >&2",
        },
        ctxFor(cwd),
      );

      expect(out).toContain("was truncated");
      expect(out).toContain("full output is");

      const match = /written to: (.+?)\]/u.exec(out);
      expect(match).not.toBeNull();
      const full = await readFile(match![1]!, "utf8");
      expect(full.length).toBeGreaterThan(200_000);
      expect(full).toContain("--- stdout ---");
      expect(full).toContain("--- stderr ---");
      expect(full).toContain("STDERR-TAIL");
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
      expect(out).not.toContain("characters omitted");

      // 临时 spool 必须被清理，不能给短命令留下垃圾文件。
      expect(await readdir(join(home, ".bugent", "output", "s1"))).toEqual([]);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  test("onProgress 在超过内存截断点后仍持续推送", async () => {
    const cwd = await workspace();
    const chunks: string[] = [];
    const tool = createBashTool(createShellRunner(), { maxOutputBytes: 64 });

    await tool.run(
      { command: "printf 'HEAD'; yes x | head -c 5000; printf 'TAIL'" },
      { ...ctxFor(cwd), onProgress: (chunk) => chunks.push(chunk) },
    );

    expect(chunks.join("")).toContain("TAIL");
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

  test("标记列铺底色，正文与上下文行不着底", () => {
    const item: ToolItem = {
      kind: "tool",
      callId: "c1",
      name: "edit_file",
      args: { path: "src/a.ts" },
      output: "已编辑 src/a.ts\n unchanged\n-old line\n+new line",
      ok: true,
      done: true,
      progress: "",
      expanded: false,
    };

    const lines = renderDiffTool(item, 60);
    const addLine = lines.find((line) => line.includes("new line"))!;
    const delLine = lines.find((line) => line.includes("old line"))!;
    const ctxLine = lines.find((line) => line.includes("unchanged"))!;
    const bgCount = (line: string) => (line.match(/\x1b\[48;[0-9;]*m/g) ?? []).length;

    // 底色恰好一个，且盖在标记列（正文不着底）
    expect(bgCount(addLine)).toBe(1);
    expect(bgCount(delLine)).toBe(1);
    expect(ctxLine).not.toContain("\x1b[48;");

    // 底色序列在标记列之前；正文（第一个 RESET 之后）不再带底色
    expect(addLine.indexOf("\x1b[48;")).toBeLessThan(addLine.indexOf("  +"));
    expect(delLine.indexOf("\x1b[48;")).toBeLessThan(delLine.indexOf("  -"));
    expect(addLine.split("\x1b[0m")[1]!).not.toContain("\x1b[48;");
    expect(delLine.split("\x1b[0m")[1]!).not.toContain("\x1b[48;");

    // 文本布局没变：仍是 `  +正文` / `  -正文`
    const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
    expect(strip(addLine)).toBe("  +new line");
    expect(strip(delLine)).toBe("  -old line");
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

    // 摘要折行之后徽标落在**最后一行**右端，所以整块里找，而不是只看第一行。
    const lines = renderDiffTool(item, 30);
    const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("+1 -1"); // 徽标不能被挤掉
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
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
    expect(lines.some((line) => line.includes("more lines not shown"))).toBe(false);
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
    expect(out).not.toContain("more lines not shown");
  });
describe("bash 头部 · 长命令折行", () => {
  const command =
    'for i in 1 2 3; do echo "a very long line $i" | tee /tmp/some/deep/path/out.txt; done';

  function bashItem(): ToolItem {
    return {
      kind: "tool",
      callId: "c1",
      name: "bash",
      args: { command },
      output: "",
      ok: true,
      done: false,
      progress: "tick",
      expanded: false,
    };
  }

  test("命令折行而不是截断 —— 后半段往往才是关键参数", () => {
    const lines = renderBashTool(bashItem(), 50);
    const plain = lines.map((line) => Bun.stripANSI(line));
    const joined = plain.join("");
    // 整条命令都在（去掉折行带来的空白）
    expect(joined.replace(/\s+/g, "")).toContain(command.replace(/\s+/g, ""));
    // 确实折了不止一行
    expect(plain.filter((line) => line.includes("tee") || line.includes("out.txt")).length).toBeGreaterThan(0);
    expect(plain.length).toBeGreaterThan(2);
  });

  test("续行对齐到命令起点（悬挂缩进），不是行首", () => {
    const lines = renderBashTool(bashItem(), 50);
    const plain = lines.map((line) => Bun.stripANSI(line));
    const first = plain[0]!;
    const commandStart = first.indexOf("for i in");
    expect(commandStart).toBeGreaterThan(0);

    const continuation = plain[1]!;
    expect(continuation.slice(0, commandStart).trim()).toBe("");
    expect(continuation.indexOf(continuation.trimStart())).toBe(commandStart);
  });

  test("每一行都不超过 width", () => {
    for (const width of [20, 30, 40, 50, 80, 120]) {
      for (const line of renderBashTool(bashItem(), width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("短命令不折行", () => {
    const short = { ...bashItem(), args: { command: "ls -la" } };
    const plain = renderBashTool(short, 80).map((line) => Bun.stripANSI(line));
    expect(plain[0]).toContain("ls -la");
    expect(plain[0]).not.toContain("…");
  });
});

});
