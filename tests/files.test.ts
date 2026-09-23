import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
} from "../src/tools/files.ts";
import { resolveWithin } from "../src/tools/paths.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace(prefix = "bugent-files-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const ctxFor = (cwd: string): ToolCtx => ({
  cwd,
  signal: new AbortController().signal,
  callId: "c1",
  sessionId: "test-session",
});

const readTool = createReadFileTool();
const writeTool = createWriteFileTool();
const editTool = createEditFileTool();

describe("P7 · read_file", () => {
  test("返回带行号的内容与总行数", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "line1\nline2\nline3\n");

    const out = await readTool.run({ path: "a.txt" }, ctxFor(cwd));

    // 3 行内容 + 结尾换行 —— 不再把结尾换行算成第 4 行（与 wc -l 一致）
    expect(out).toContain("共 3 行");
    expect(out).toContain("1\tline1");
    expect(out).toContain("3\tline3");
  });

  test("offset / limit 分段读取并提示如何继续", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "l1\nl2\nl3\nl4\n");

    const out = await readTool.run({ path: "a.txt", offset: 2, limit: 1 }, ctxFor(cwd));

    expect(out).toContain("2\tl2");
    expect(out).not.toContain("1\tl1");
    expect(out).toContain("offset=3");
  });

  test("文件不存在时报错", async () => {
    const cwd = await workspace();
    await expect(readTool.run({ path: "nope.txt" }, ctxFor(cwd))).rejects.toThrow(/不存在/);
  });

  test("拒绝读取二进制文件", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x41]));

    await expect(readTool.run({ path: "bin.dat" }, ctxFor(cwd))).rejects.toThrow(/二进制/);
  });

  test("非法参数被拒绝", async () => {
    const cwd = await workspace();
    await expect(readTool.run({ path: 123 }, ctxFor(cwd))).rejects.toThrow(/必须是字符串/);
    await expect(readTool.run({ path: "a.txt", offset: 0 }, ctxFor(cwd))).rejects.toThrow(/正整数/);
  });
});

describe("P7 · write_file", () => {
  test("写入内容并自动创建父目录", async () => {
    const cwd = await workspace();

    const out = await writeTool.run({ path: "nested/deep/b.txt", content: "hello" }, ctxFor(cwd));

    expect(out).toContain("已创建");
    expect(out).toContain("+hello"); // 新内容以 diff 形式呈现
    expect(await readFile(join(cwd, "nested/deep/b.txt"), "utf8")).toBe("hello");
  });

  test("覆盖已有内容", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "c.txt"), "old");

    await writeTool.run({ path: "c.txt", content: "new" }, ctxFor(cwd));

    expect(await readFile(join(cwd, "c.txt"), "utf8")).toBe("new");
  });

  test("写入后不留临时文件", async () => {
    const cwd = await workspace();
    await writeTool.run({ path: "d.txt", content: "x" }, ctxFor(cwd));

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(cwd);
    expect(entries).toEqual(["d.txt"]);
  });

  test("非法参数被拒绝", async () => {
    const cwd = await workspace();
    await expect(writeTool.run({ path: "a.txt" }, ctxFor(cwd))).rejects.toThrow(/content 必须是字符串/);
  });
});

describe("P7 · edit_file", () => {
  test("唯一匹配时精确替换", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "alpha\nbeta\ngamma\n");

    const out = await editTool.run({ path: "a.txt", old_string: "beta", new_string: "BETA" }, ctxFor(cwd));

    expect(out).toContain("替换 1 处");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("找不到 old_string 时报错，而不是瞎猜", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "alpha\n");

    await expect(
      editTool.run({ path: "a.txt", old_string: "zzz", new_string: "x" }, ctxFor(cwd)),
    ).rejects.toThrow(/找不到 old_string/);
  });

  test("多处匹配且未开 replace_all 时报错", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "x\nx\n");

    await expect(
      editTool.run({ path: "a.txt", old_string: "x", new_string: "y" }, ctxFor(cwd)),
    ).rejects.toThrow(/不唯一/);
  });

  test("replace_all 替换全部匹配", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "x\nx\n");

    const out = await editTool.run(
      { path: "a.txt", old_string: "x", new_string: "y", replace_all: true },
      ctxFor(cwd),
    );

    expect(out).toContain("替换 2 处");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("y\ny\n");
  });

  test("空 old_string 与无变化替换被拒绝", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "abc");

    await expect(editTool.run({ path: "a.txt", old_string: "", new_string: "x" }, ctxFor(cwd))).rejects.toThrow(
      /不能为空/,
    );
    await expect(
      editTool.run({ path: "a.txt", old_string: "abc", new_string: "abc" }, ctxFor(cwd)),
    ).rejects.toThrow(/无需修改/);
  });
});

describe("P7 · 路径约束", () => {
  test("../ 逃逸被拒绝", async () => {
    const cwd = await workspace();
    await expect(readTool.run({ path: "../secret.txt" }, ctxFor(cwd))).rejects.toThrow(/越界/);
  });

  test("绝对路径指向工作区外被拒绝", async () => {
    const cwd = await workspace();
    await expect(
      writeTool.run({ path: "/tmp/bugent-should-not-be-written.txt", content: "x" }, ctxFor(cwd)),
    ).rejects.toThrow(/越界/);
  });

  test("符号链接逃逸被拒绝（读取）", async () => {
    const cwd = await workspace();
    const outside = await workspace("bugent-outside-");
    await writeFile(join(outside, "target.txt"), "secret");
    await symlink(outside, join(cwd, "link"));

    await expect(readTool.run({ path: "link/target.txt" }, ctxFor(cwd))).rejects.toThrow(/越界/);
  });

  test("符号链接逃逸被拒绝（新建文件）", async () => {
    const cwd = await workspace();
    const outside = await workspace("bugent-outside-");
    await symlink(outside, join(cwd, "link"));

    await expect(writeTool.run({ path: "link/new.txt", content: "x" }, ctxFor(cwd))).rejects.toThrow(/越界/);
  });

  test("工作目录内的绝对路径是允许的", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "ok.txt"), "fine");

    const out = await readTool.run({ path: join(cwd, "ok.txt") }, ctxFor(cwd));
    expect(out).toContain("fine");
  });

  test("resolveWithin 对工作目录本身返回 root", async () => {
    const cwd = await workspace();
    expect(resolveWithin(cwd, ".")).toBe(cwd);
  });
});

describe("P7 · read_file 的边界情况", () => {
  test("目录给出明确提示，而不是误报「文件不存在」", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "docs"), { recursive: true });
    await writeFile(join(cwd, "docs/README.md"), "hi");

    await expect(readTool.run({ path: "docs" }, ctxFor(cwd))).rejects.toThrow(/这是一个目录/);
    await expect(readTool.run({ path: "docs/" }, ctxFor(cwd))).rejects.toThrow(/这是一个目录/);
  });

  test("无后缀文件按文本正常读", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "Makefile"), "all:\n\techo hi\n");

    const out = await readTool.run({ path: "Makefile" }, ctxFor(cwd));
    expect(out).toContain("all:");
  });

  test("二进制在流式读取中被拦截（不必先读完整个文件）", async () => {
    const cwd = await workspace();
    // 前 64KB 都是文本，NUL 藏在后面 —— 验证检测是跟着流走的
    const head = Buffer.from("a".repeat(64 * 1024), "utf8");
    await writeFile(join(cwd, "sneaky.bin"), Buffer.concat([head, Buffer.from([0x00, 0x01])]));

    await expect(readTool.run({ path: "sneaky.bin" }, ctxFor(cwd))).rejects.toThrow(/二进制/);
  });

  test("行数与 wc -l 一致：结尾换行不算额外一行", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "one\ntwo\nthree\n");
    expect(await readTool.run({ path: "a.txt" }, ctxFor(cwd))).toContain("共 3 行");

    await writeFile(join(cwd, "b.txt"), "one\ntwo\nthree");
    expect(await readTool.run({ path: "b.txt" }, ctxFor(cwd))).toContain("共 3 行");
  });

  test("空文件给出明确提示", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "empty.txt"), "");
    expect(await readTool.run({ path: "empty.txt" }, ctxFor(cwd))).toContain("空文件");
  });

  test("大文件流式读前 N 行，而不是直接拒绝", async () => {
    const cwd = await workspace();
    // 造一个远超旧的 8MB 上限的文件
    const chunk = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const handle = Bun.file(join(cwd, "big.log"));
    const writer = handle.writer();
    for (let i = 0; i < 400; i += 1) writer.write(chunk); // ≈ 400 * 5000 行
    await writer.end();

    const started = Bun.nanoseconds();
    const out = await readTool.run({ path: "big.log", limit: 10 }, ctxFor(cwd));
    const ms = (Bun.nanoseconds() - started) / 1e6;

    expect(out).toContain("1\tline 0");
    expect(out).toContain("10\tline 9");
    expect(out).toContain("offset=11");
    // 只读 10 行就应该很快，不该把整个文件读完
    expect(ms).toBeLessThan(500);
  });

  test("大文件用 offset 往后读", async () => {
    const cwd = await workspace();
    const content = Array.from({ length: 200_000 }, (_, i) => `L${i}`).join("\n");
    await writeFile(join(cwd, "big2.log"), content);

    const out = await readTool.run({ path: "big2.log", offset: 100_000, limit: 3 }, ctxFor(cwd));
    expect(out).toContain("100000\tL99999");
    expect(out).toContain("100002\tL100001");
  });

  test("offset 超出文件末尾时报错并给出真实行数", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "small.txt"), "a\nb\nc\n");

    await expect(readTool.run({ path: "small.txt", offset: 999 }, ctxFor(cwd))).rejects.toThrow(
      /offset 999 超出文件总行数 3/,
    );
  });
});

describe("P7 · 权限资源描述", () => {
  test("文件工具把路径作为权限匹配的资源", () => {
    expect(readTool.describe?.({ path: "src/a.ts" })).toEqual({
      resource: "src/a.ts",
      summary: "读取文件 src/a.ts",
    });
    expect(writeTool.describe?.({ path: "src/b.ts" })).toEqual({
      resource: "src/b.ts",
      summary: "写入文件 src/b.ts",
    });
    expect(editTool.describe?.({ path: "src/c.ts" })).toEqual({
      resource: "src/c.ts",
      summary: "编辑文件 src/c.ts",
    });
  });
});
