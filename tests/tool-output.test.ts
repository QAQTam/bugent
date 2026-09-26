import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactDiff,
  diffLines,
  diffStat,
  formatDiff,
  formatDiffStat,
  MAX_DIFF_LINES,
  parseDiffLine,
  parseDiffStat,
} from "../src/tools/diff.ts";
import { createBashTool, createShellRunner, MAX_MODEL_OUTPUT_CHARS } from "../src/tools/bash.ts";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
  MAX_READ_CHARS,
  MAX_READ_LINES,
} from "../src/tools/files.ts";
import { renderBashTool, renderDiffTool, renderReadFileTool, parseReadHeader } from "../src/tui/render-tools.ts";
import { registerBuiltinToolRenderers } from "../src/tui/renderers-builtin.ts";
import { renderGenericTool, renderToolItem, type ToolItem } from "../src/tui/renderers.ts";
import { visibleWidth } from "../src/tui/ansi.ts";
import type { ToolPresentation } from "../src/core/presentation.ts";
import type { ToolCtx } from "../src/tools/types.ts";

// 显示名与 renderer 都在这里注册（应用启动时同一入口）。直接调 renderXxx 的
// 用例必须自己先注册，否则卡片头会退回注册名 —— 那正好也是回退行为本身。
registerBuiltinToolRenderers();

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace(prefix = "bugent-out-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const ctxFor = (cwd: string, sessionId = "s1", presentations?: ToolPresentation[]): ToolCtx => ({
  cwd,
  signal: new AbortController().signal,
  callId: "c1",
  sessionId,
  ...(presentations !== undefined
    ? { onPresentation: (value: ToolPresentation) => presentations.push(value) }
    : {}),
});

describe("diff", () => {
  test("识别增删改", () => {
    const lines = diffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(lines).toEqual([
      { kind: " ", text: "a", before: 1, after: 1 },
      { kind: "-", text: "b", before: 2 },
      { kind: "+", text: "B", after: 2 },
      { kind: " ", text: "c", before: 3, after: 3 },
      { kind: " ", text: "", before: 4, after: 4 },
    ]);
  });

  test("行号：上下文两侧都有，删只有改动前，增只有改动后", () => {
    const added = diffLines("a\nb\n", "a\nb\nc\n").find((line) => line.kind === "+");
    expect(added).toEqual({ kind: "+", text: "c", after: 3 });

    const removed = diffLines("a\nb\nc\n", "a\nb\n").find((line) => line.kind === "-");
    expect(removed).toEqual({ kind: "-", text: "c", before: 3 });
  });

  test("行号：文件头部插入后，后面所有行的行号整体后移", () => {
    expect(diffLines("a\nb\n", "new\na\nb\n")).toEqual([
      { kind: "+", text: "new", after: 1 },
      { kind: " ", text: "a", before: 1, after: 2 },
      { kind: " ", text: "b", before: 2, after: 3 },
      // 尾随换行 split 出来的最后一行是空行，两边行号照常往后排
      { kind: " ", text: "", before: 3, after: 4 },
    ]);
  });

  test("行号：超大文件退化成摘要时两边都不给行号", () => {
    const huge = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line${i}`).join("\n");
    const lines = diffLines(huge, "small");
    expect(lines.every((line) => line.before === undefined && line.after === undefined)).toBe(true);
  });

  test("行号：compactDiff 之后仍然指向真实文件行（省略的不是行号）", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n");
    const after = before.replace("line20", "CHANGED");

    const compact = compactDiff(diffLines(before, after));

    // 省略标记自己没有行号
    const marker = compact.find((line) => line.text.includes("省略"));
    expect(marker?.before).toBeUndefined();
    expect(marker?.after).toBeUndefined();

    // 改的是第 20 行（1-based），裁剪之后行号仍然是 20 —— 不能是"渲染列表下标"
    expect(compact.find((line) => line.text === "CHANGED")).toEqual({
      kind: "+",
      text: "CHANGED",
      after: 20,
    });
    expect(compact.find((line) => line.text === "line20")).toEqual({
      kind: "-",
      text: "line20",
      before: 20,
    });
    expect(compact.find((line) => line.text === "line19")).toEqual({
      kind: " ",
      text: "line19",
      before: 19,
      after: 19,
    });
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

  test("formatDiff 带两列行号，且列对齐", () => {
    const text = formatDiff(diffLines("a\nb\nc\n", "a\nB\nc\n"), "edited x.ts");
    // 列宽 = max(2, 最长行号的位数)：`-` 只占旧列、`+` 只占新列，替换时两列
    // 指向同一个位置，一眼能看出"改的是这一行"而不是"动了两行"。
    expect(text.split("\n")).toEqual([
      "edited x.ts",
      "@@ -1,4 +1,4 @@",
      " 1  1  a",
      " 2    -b",
      "    2 +B",
      " 3  3  c",
      " 4  4  ",
    ]);
  });

  test("formatDiff 行号列随最大行号变宽，仍然对齐", () => {
    const before = Array.from({ length: 120 }, (_, i) => `line${i + 1}`).join("\n");
    const after = before.replace("line100", "CHANGED");
    const body = formatDiff(diffLines(before, after), "h").split("\n").slice(1);

    // 三位行号：列宽 3，`-` / `+` 的标记列对齐在同一列
    const changed = body.filter((line) => line.includes("line100") || line.includes("CHANGED"));
    expect(changed).toEqual(["100     -line100", "    100 +CHANGED"]);
    // hunk 头不带行号列，其余每一行的标记列都对齐在同一列
    for (const line of body) {
      if (line.startsWith("@@")) continue;
      const marker = line.search(/[ +-] /);
      expect(marker, line).toBeGreaterThan(-1);
    }
  });

  test("formatDiff 每个 hunk 一个 @@ 头，范围取自真实行号", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n");
    const after = before.replace("line20", "CHANGED");

    const body = formatDiff(compactDiff(diffLines(before, after)), "h").split("\n").slice(1);
    const headers = body.filter((line) => line.startsWith("@@"));

    // 改动被省略行隔成一段 -> 一个 hunk；范围是 17..23（±3 上下文）
    expect(headers).toEqual(["@@ -17,7 +17,7 @@"]);
  });

  test("formatDiff 多 hunk 各自带头，纯新增的旧侧是 -0,0", () => {
    // 新建文件：所有行都是新增，旧侧没有行号
    const created = formatDiff(
      diffLines("", "one\ntwo").filter((line) => line.kind === "+"),
      "created x.ts",
    );
    expect(created.split("\n")[1]).toBe("@@ -0,0 +1,2 @@");

    // 两个相隔很远的改动 -> 两个 hunk
    const before = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join("\n");
    const after = before.replace("line20", "A").replace("line180", "B");
    const body = formatDiff(compactDiff(diffLines(before, after)), "h").split("\n").slice(1);
    expect(body.filter((line) => line.startsWith("@@"))).toEqual([
      "@@ -17,7 +17,7 @@",
      "@@ -177,7 +177,7 @@",
    ]);
  });

  test("formatDiff 不给纯上下文段加 @@ 头（那里没改动）", () => {
    const text = formatDiff(diffLines("same\n", "same\n"), "h");
    expect(text).not.toContain("@@");
  });

  test("formatDiff 对没有行号的行不画行号列（老格式、超大文件摘要）", () => {
    const text = formatDiff([{ kind: "-", text: "old" }, { kind: "+", text: "new" }], "h");
    expect(text.split("\n")).toEqual(["h", "-old", "+new"]);
  });

  test("parseDiffLine 反解出标记、正文与两侧行号", () => {
    expect(parseDiffLine("2   -b")).toEqual({ kind: "-", text: "b", gutter: "2   ", before: 2 });
    expect(parseDiffLine("  2 +B")).toEqual({ kind: "+", text: "B", gutter: "  2 ", after: 2 });
    expect(parseDiffLine("3 3  c")).toEqual({
      kind: " ",
      text: "c",
      gutter: "3 3 ",
      before: 3,
      after: 3,
    });
  });

  test("parseDiffLine 兼容没有行号列的老文本", () => {
    expect(parseDiffLine("-old")).toEqual({ kind: "-", text: "old" });
    expect(parseDiffLine("+new")).toEqual({ kind: "+", text: "new" });
    expect(parseDiffLine(" plain")).toEqual({ kind: " ", text: "plain" });
  });

  test("parseDiffLine 不认省略标记行与正文行", () => {
    expect(parseDiffLine("⋯ 省略 5 行未变更内容")).toBeUndefined();
    expect(parseDiffLine("plain text")).toBeUndefined();
    expect(parseDiffLine("")).toBeUndefined();
  });

  test("parseDiffLine 不会把正文里的数字当成行号列（标记必须紧跟列尾）", () => {
    // 无行号列时，正文以数字开头也要原样保留
    expect(parseDiffLine(" 42 items")).toEqual({ kind: " ", text: "42 items" });
    expect(parseDiffLine(" 42 43 items")).toEqual({ kind: " ", text: "42 43 items" });
  });

  test("parseDiffStat：带行号列与不带行号列都要算对（徽标不能静默变 0）", () => {
    const withGutter = formatDiff(diffLines("a\nb\nc\n", "a\nB\nc\nd\n"), "h");
    expect(parseDiffStat(withGutter)).toEqual({ added: 2, removed: 1 });

    // 改这个格式之前落库的输出（--resume 会读到）没有行号列
    const legacy = "edited x.ts\n-a\n+b\n+c";
    expect(parseDiffStat(legacy)).toEqual({ added: 2, removed: 1 });

    // 摘要行、省略标记行都不计入
    const withMarker = "h\n⋯ 省略 3 行未变更内容\n  7  -old\n    7 +new";
    expect(parseDiffStat(withMarker)).toEqual({ added: 1, removed: 1 });
  });

  test("parseDiffStat 不把 @@ 头当成增删", () => {
    const text = formatDiff(diffLines("a\nb\nc\n", "a\nB\nc\n"), "h");
    expect(text).toContain("@@");
    // `@@ -1,4 +1,4 @@` 里既没有 `+行` 也没有 `-行`
    expect(parseDiffStat(text)).toEqual({ added: 1, removed: 1 });
    expect(parseDiffLine("@@ -1,4 +1,4 @@")).toBeUndefined();
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

  test("徽标跟在摘要后面，不铺满整行", () => {
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
    expect(visibleWidth(head!)).toBeLessThanOrEqual(60);
    const plain = head!.replace(/\x1b\[[0-9;]*m/g, "");
    // 显示名 + 路径 + 两列间隔 + 徽标，而不是被拉到第 60 列
    expect(plain).toBe("⏺ Edit src/a.ts  +1 -1");
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

describe("文件工具自报展示元数据（TUI 不必反解文本）", () => {
  /** 跑一个工具，收下它自报的展示元数据。 */
  async function runWith<T>(
    tool: { run: (input: never, ctx: ToolCtx) => Promise<T> },
    input: unknown,
    cwd: string,
  ): Promise<{ output: T; presentation: ToolPresentation | undefined }> {
    const presentations: ToolPresentation[] = [];
    const output = await tool.run(input as never, ctxFor(cwd, "s1", presentations));
    return { output, presentation: presentations.at(-1) };
  }

  test("read_file 自报规范路径与读取窗口", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "small.txt"), "a\nb\nc\n");

    const { presentation } = await runWith(createReadFileTool(), { path: "small.txt" }, cwd);
    expect(presentation).toEqual({ kind: "file", path: "small.txt", range: "1-3" });
  });

  test("read_file 带 offset/limit 时窗口与实际读到的一致", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "many.txt"), Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join("\n"));

    const { output, presentation } = await runWith(
      createReadFileTool(),
      { path: "many.txt", offset: 5, limit: 4 },
      cwd,
    );
    // 输出头与自报窗口必须是同一个口径（反解回退才不会给出不同答案）
    expect(presentation).toMatchObject({ kind: "file", path: "many.txt", range: "5-8" });
    expect(output).toContain("showing 5-8");
  });

  test("read_file 用规范化后的路径，不是入参原样", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "x\n");

    const { presentation } = await runWith(createReadFileTool(), { path: "./a.txt" }, cwd);
    expect(presentation).toMatchObject({ path: "a.txt" });
  });

  test("write_file 新建文件自报 +N -0", async () => {
    const cwd = await workspace();

    const { presentation } = await runWith(
      createWriteFileTool(),
      { path: "new.txt", content: "one\ntwo\nthree" },
      cwd,
    );
    expect(presentation).toEqual({ kind: "file", path: "new.txt", added: 3, removed: 0 });
  });

  test("write_file 覆写自报真实增删（与 diff 文本口径一致）", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "one\ntwo\nthree\n");

    const { output, presentation } = await runWith(
      createWriteFileTool(),
      { path: "a.txt", content: "one\nTWO\nthree\n" },
      cwd,
    );
    expect(presentation).toMatchObject({ kind: "file", path: "a.txt", added: 1, removed: 1 });
    // 反解文本得到的是同一组数字 —— 两条路不会给出不同答案
    expect(parseDiffStat(output)).toEqual({ added: 1, removed: 1 });
  });

  test("edit_file 自报增删，与输出文本反解一致", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "one\ntwo\nthree\n");

    const { output, presentation } = await runWith(
      createEditFileTool(),
      { path: "a.txt", old_string: "two", new_string: "TWO\nEXTRA" },
      cwd,
    );
    expect(presentation).toMatchObject({ kind: "file", path: "a.txt" });
    const stat = parseDiffStat(output);
    expect(presentation).toMatchObject({ added: stat?.added, removed: stat?.removed });
  });

  test("失败的调用不自报（渲染层继续走反解 + ok 判断）", async () => {
    const cwd = await workspace();
    const presentations: ToolPresentation[] = [];
    await expect(
      createReadFileTool().run({ path: "missing.txt" }, ctxFor(cwd, "s1", presentations)),
    ).rejects.toThrow();
    expect(presentations).toEqual([]);
  });
});

describe("文件工具卡片 · 显示名与徽标", () => {
  function fileItem(over: Partial<ToolItem>): ToolItem {
    return {
      kind: "tool",
      callId: "c1",
      name: "read_file",
      args: { path: "src/a.ts" },
      output: "",
      ok: true,
      done: true,
      progress: "",
      expanded: false,
      ...over,
    };
  }

  function head(over: Partial<ToolItem>, width = 80): string {
    return Bun.stripANSI(renderReadFileTool(fileItem(over), width)[0]!);
  }

  test("卡片头是 Read + 路径，不是 read_file", () => {
    const line = head({ output: "# src/a.ts (12 lines）\n1\tfoo" });
    expect(line).toBe("⏺ Read src/a.ts  1-12");
    expect(line).not.toContain("read_file");
  });

  test("只读了窗口时徽标是窗口范围，不是总行数", () => {
    const line = head({ output: "# src/a.ts (500 lines, showing 101-200）\n101\tfoo" });
    expect(line).toBe("⏺ Read src/a.ts  101-200");
  });

  test("撞到扫描上限（还不知道总行数）时同样是窗口范围", () => {
    const line = head({ output: "# src/a.ts (showing 1-500, not yet at end of file)\n1\tfoo" });
    expect(line).toBe("⏺ Read src/a.ts  1-500");
  });

  test("空文件没有徽标，但仍然显示路径", () => {
    expect(head({ output: "# src/a.ts (empty file)" })).toBe("⏺ Read src/a.ts");
  });

  test("用输出里的展示路径，而不是入参原样", () => {
    // 模型写 `./src/a.ts`，工具输出的是规范化后的 `src/a.ts`
    const line = head({ args: { path: "./src/a.ts" }, output: "# src/a.ts (3 lines）\n1\tx" });
    expect(line).toBe("⏺ Read src/a.ts  1-3");
  });

  test("流式阶段不出徽标（还没有输出可解析）", () => {
    const lines = renderReadFileTool(fileItem({ done: false }), 80).map((line) => Bun.stripANSI(line));
    expect(lines[0]).toBe("⏺ Read src/a.ts");
    expect(lines[1]).toContain("读取中…");
  });

  test("失败时不出徽标，也不把错误文本当路径", () => {
    const line = head({ ok: false, output: "file not found: src/a.ts" });
    expect(line).toBe("⏺ Read src/a.ts");
  });

  test("错误文本里恰好有 # 开头时也不误判", () => {
    expect(parseReadHeader("# not a header\nfoo")).toEqual({});
    expect(parseReadHeader("file not found: src/a.ts")).toEqual({});
    expect(parseReadHeader("")).toEqual({});
  });

  test("路径里带括号也能解出正确的 path", () => {
    expect(parseReadHeader("# src/a (1).ts (3 lines）")).toEqual({
      path: "src/a (1).ts",
      range: "1-3",
    });
  });

  test("write/edit 用 Write / Edit，不再暴露注册名", () => {
    const write = Bun.stripANSI(
      renderDiffTool(
        fileItem({
          name: "write_file",
          args: { path: "src/a.ts" },
          output: "overwrote src/a.ts (2 bytes, 2 lines)\n+new\n-old",
        }),
        80,
      )[0]!,
    );
    expect(write).toBe("⏺ Write src/a.ts  +1 -1");

    const edit = Bun.stripANSI(
      renderDiffTool(
        fileItem({
          name: "edit_file",
          args: { path: "src/a.ts" },
          output: "已编辑 src/a.ts\n-old\n+new",
        }),
        80,
      )[0]!,
    );
    expect(edit).toBe("⏺ Edit src/a.ts  +1 -1");
  });

  test("未注册的工具回退到注册名（不静默丢信息）", () => {
    const line = Bun.stripANSI(
      renderGenericTool(fileItem({ name: "mcp__fs__read", args: { path: "x" } }), 80)[0]!,
    );
    expect(line).toContain("mcp__fs__read");
  });

  test("参数还在流式到达时不显示 JSON，而是已经到达的路径", () => {
    // loop 对半截 JSON 的表示：`{_raw, _parseError}`（见 src/core/loop.ts:parseArgs）
    const streaming = fileItem({
      name: "write_file",
      done: false,
      args: { _raw: '{"path":"src/foo.ts","content":"line one\\nline tw', _parseError: true },
    });
    const line = Bun.stripANSI(renderDiffTool(streaming, 80)[0]!);
    expect(line).toBe("⏺ Write src/foo.ts");
    expect(line).not.toContain("_raw");
    expect(line).not.toContain("_parseError");
    expect(line).not.toContain("{");
  });

  test("路径还没收尾时显示已经到达的前缀，仍然不显示 JSON", () => {
    const streaming = fileItem({
      name: "edit_file",
      done: false,
      args: { _raw: '{"path":"src/very/long', _parseError: true },
    });
    expect(Bun.stripANSI(renderDiffTool(streaming, 80)[0]!)).toBe("⏺ Edit src/very/long");
  });

  test("抠不出路径时头部只有名字，不退回 JSON", () => {
    const streaming = fileItem({
      name: "write_file",
      done: false,
      args: { _raw: '{"content":"{', _parseError: true },
    });
    const line = Bun.stripANSI(renderDiffTool(streaming, 80)[0]!);
    expect(line).toBe("⏺ Write");
    expect(line).not.toContain("{");
  });

  test("半截 JSON 不再按原文长度做序列化（O(n²) 的根因）", () => {
    // 10 万个字符的半截 content：头部只该出现路径，不该出现原文
    const raw = `{"path":"src/a.ts","content":"${"x".repeat(100_000)}`;
    const streaming = fileItem({
      name: "write_file",
      done: false,
      args: { _raw: raw, _parseError: true },
    });
    const lines = renderDiffTool(streaming, 80);
    expect(Bun.stripANSI(lines[0]!)).toBe("⏺ Write src/a.ts");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });

  test("卡片优先用工具自报的元数据，而不是反解输出文本", () => {
    // 输出里**故意**不带可解析的头/统计：只有自报能给出路径与窗口
    const item = fileItem({
      output: "（这段文本没有任何可反解的头）",
      presentation: { kind: "file", path: "src/real.ts", range: "7-9" },
    });
    expect(Bun.stripANSI(renderReadFileTool(item, 80)[0]!)).toBe("⏺ Read src/real.ts  7-9");
  });

  test("diff 卡片优先用自报的增删数（输出没有 diff 行也算得出来）", () => {
    const item = fileItem({
      name: "edit_file",
      output: "edited src/real.ts (1 replacements)\n（没有 +/- 行）",
      presentation: { kind: "file", path: "src/real.ts", added: 5, removed: 2 },
    });
    expect(Bun.stripANSI(renderDiffTool(item, 80)[0]!)).toBe("⏺ Edit src/real.ts  +5 -2");
  });

  test("没有自报时（--resume 重建）仍然能反解出同样的结果", () => {
    const item = fileItem({
      name: "edit_file",
      output: formatDiff(diffLines("a\nb\nc\n", "a\nB\nc\n"), "edited src/a.ts"),
    });
    expect(Bun.stripANSI(renderDiffTool(item, 80)[0]!)).toBe("⏺ Edit src/a.ts  +1 -1");
  });

  test("流式阶段用参数进度显示路径与 +N，不必等执行完", () => {
    const streaming = fileItem({
      name: "write_file",
      done: false,
      args: { _raw: '{"path":"src/foo.ts","content":"one\\ntwo\\nthree', _parseError: true },
      fileProgress: { path: "src/foo.ts", added: 3, removed: 0, complete: false },
    });
    const lines = renderDiffTool(streaming, 80).map((line) => Bun.stripANSI(line));
    expect(lines[0]).toBe("⏺ Write src/foo.ts  +3");
    expect(lines[1]).toContain("写入中…");
  });

  test("流式阶段 edit 同时显示 +N -M（-M 来自 old_string）", () => {
    const streaming = fileItem({
      name: "edit_file",
      done: false,
      fileProgress: { path: "src/bar.ts", added: 2, removed: 3, complete: false },
    });
    expect(Bun.stripANSI(renderDiffTool(streaming, 80)[0]!)).toBe("⏺ Edit src/bar.ts  +2 -3");
  });

  test("流式阶段还没有进度时退回参数摘要（已经到达的路径）", () => {
    const streaming = fileItem({
      name: "write_file",
      done: false,
      args: { _raw: '{"path":"src/foo.ts","cont', _parseError: true },
    });
    expect(Bun.stripANSI(renderDiffTool(streaming, 80)[0]!)).toBe("⏺ Write src/foo.ts");
  });

  test("hunk 头单独着色、不带行号列，也不超宽", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n");
    const after = before.replace("line20", "CHANGED");
    const item = fileItem({
      name: "edit_file",
      output: formatDiff(compactDiff(diffLines(before, after)), "edited src/a.ts"),
    });

    for (const width of [40, 60, 80]) {
      const lines = renderToolItem(item, width);
      const header = lines.map((line) => Bun.stripANSI(line)).find((line) => line.startsWith("  @@"));
      expect(header, `width=${width}`).toBeDefined();
      // 行号列没有画到 @@ 行上
      expect(header).not.toMatch(/\d+\s+\d+\s+@@/);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("diff 面板带行号：宽屏画出行号列", () => {
    const item = fileItem({
      name: "edit_file",
      output: formatDiff(diffLines("a\nb\nc\n", "a\nB\nc\n"), "edited src/a.ts (1 replacements)"),
    });
    const lines = renderDiffTool(item, 80).map((line) => Bun.stripANSI(line));

    // 行号列 + 标记 + 正文，`-` / `+` 指向同一个位置（第 2 行）
    expect(lines.some((line) => / 2\s+-b$/.test(line))).toBe(true);
    expect(lines.some((line) => / 2\s+\+B$/.test(line))).toBe(true);
    expect(lines.some((line) => / 1\s+1\s+a$/.test(line))).toBe(true);
  });

  test("diff 面板带行号：窄屏丢掉行号列，正文不被挤成一条缝", () => {
    const item = fileItem({
      name: "edit_file",
      output: formatDiff(diffLines("a\nb\nc\n", "a\nB\nc\n"), "edited src/a.ts"),
    });
    const narrow = renderDiffTool(item, 40).map((line) => Bun.stripANSI(line));

    // 标记与正文还在，行号列没了
    expect(narrow.some((line) => line.trimEnd().endsWith("-b"))).toBe(true);
    expect(narrow.some((line) => line.trimEnd().endsWith("+B"))).toBe(true);
    expect(narrow.some((line) => /\s2\s/.test(line))).toBe(false);
    for (const line of renderToolItem(item, 40)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  test("省略标记行不带行号，两种宽度下都不超宽", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join("\n");
    const after = before.replace("line20", "CHANGED");
    const item = fileItem({
      name: "edit_file",
      output: formatDiff(compactDiff(diffLines(before, after)), "edited src/a.ts"),
    });

    for (const width of [40, 60, 80]) {
      const lines = renderToolItem(item, width).map((line) => Bun.stripANSI(line));
      const marker = lines.find((line) => line.includes("省略")) ?? "";
      expect(marker).not.toMatch(/\d+\s+\d+\s+⋯/);
      for (const line of renderToolItem(item, width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("极窄终端下徽标不与内容挤在一起，也不超宽", () => {
    // 走真实出口 renderToolItem：它带一层"任何一行都不许超过 width"的兜底，
    // 固定文案（"… 还有 N 行"）在极窄终端上就靠它收住。
    for (const width of [12, 20, 30, 40]) {
      for (const line of renderToolItem(
        fileItem({ output: "# src/very/long/path/to/a.ts (500 lines, showing 101-200）\n1\tx" }),
        width,
      )) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
