import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
});

const readTool = createReadFileTool();
const writeTool = createWriteFileTool();
const editTool = createEditFileTool();

describe("P7 · read_file", () => {
  test("返回带行号的内容与总行数", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "line1\nline2\nline3\n");

    const out = await readTool.run({ path: "a.txt" }, ctxFor(cwd));

    expect(out).toContain("共 4 行");
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

    expect(out).toContain("已写入");
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
