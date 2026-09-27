import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
    expect(out).toContain("(3 lines");
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
    await expect(readTool.run({ path: "nope.txt" }, ctxFor(cwd))).rejects.toThrow(/not found/);
  });

  test("拒绝读取二进制文件", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x41]));

    await expect(readTool.run({ path: "bin.dat" }, ctxFor(cwd))).rejects.toThrow(/binary file/);
  });

  test("非法参数被拒绝", async () => {
    const cwd = await workspace();
    await expect(readTool.run({ path: 123 }, ctxFor(cwd))).rejects.toThrow(/must be a string/);
    await expect(readTool.run({ path: "a.txt", offset: 0 }, ctxFor(cwd))).rejects.toThrow(/positive integer/);
  });
});

describe("P7 · write_file", () => {
  test("写入内容并自动创建父目录", async () => {
    const cwd = await workspace();

    const out = await writeTool.run({ path: "nested/deep/b.txt", content: "hello" }, ctxFor(cwd));

    expect(out).toContain("created");
    expect(out).toContain("+hello"); // 新内容以 diff 形式呈现
    expect(await readFile(join(cwd, "nested/deep/b.txt"), "utf8")).toBe("hello");
  });

  test("覆盖已有内容", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "c.txt"), "old");

    await writeTool.run({ path: "c.txt", content: "new" }, ctxFor(cwd));

    expect(await readFile(join(cwd, "c.txt"), "utf8")).toBe("new");
  });

  test("覆盖时保留原文件权限", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    const path = join(cwd, "script.sh");
    await writeFile(path, "#!/bin/sh\necho old\n", "utf8");
    await chmod(path, 0o755);

    await writeTool.run({ path: "script.sh", content: "#!/bin/sh\necho new\n" }, ctxFor(cwd));

    expect((await stat(path)).mode & 0o777).toBe(0o755);
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
    await expect(writeTool.run({ path: "a.txt" }, ctxFor(cwd))).rejects.toThrow(/content must be a string/);
  });
});

describe("P7 · edit_file", () => {
  test("唯一匹配时精确替换", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "alpha\nbeta\ngamma\n");

    const out = await editTool.run({ path: "a.txt", old_string: "beta", new_string: "BETA" }, ctxFor(cwd));

    expect(out).toContain("1 replacements");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("找不到 old_string 时报错，而不是瞎猜", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "alpha\n");

    await expect(
      editTool.run({ path: "a.txt", old_string: "zzz", new_string: "x" }, ctxFor(cwd)),
    ).rejects.toThrow(/old_string not found/);
  });

  test("多处匹配且未开 replace_all 时报错", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "x\nx\n");

    await expect(
      editTool.run({ path: "a.txt", old_string: "x", new_string: "y" }, ctxFor(cwd)),
    ).rejects.toThrow(/matches \d+ times/);
  });

  test("replace_all 替换全部匹配", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "x\nx\n");

    const out = await editTool.run(
      { path: "a.txt", old_string: "x", new_string: "y", replace_all: true },
      ctxFor(cwd),
    );

    expect(out).toContain("2 replacements");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("y\ny\n");
  });

  test("new_string 中的 $ 替换模板按字面量写入", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "token\n");

    await editTool.run(
      { path: "a.txt", old_string: "token", new_string: "$& $$ $1 $`" },
      ctxFor(cwd),
    );

    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("$& $$ $1 $`\n");
  });

  test("编辑保留原文件权限", async () => {
    if (process.platform === "win32") return;
    const cwd = await workspace();
    const path = join(cwd, "script.sh");
    await writeFile(path, "#!/bin/sh\necho old\n", "utf8");
    await chmod(path, 0o755);

    await editTool.run(
      { path: "script.sh", old_string: "old", new_string: "new" },
      ctxFor(cwd),
    );

    expect((await stat(path)).mode & 0o777).toBe(0o755);
    expect(await readFile(path, "utf8")).toContain("echo new");
  });

  test("拒绝编辑二进制文件", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "bin.dat"), Buffer.from([0x00, 0x41, 0x42]));

    await expect(
      editTool.run({ path: "bin.dat", old_string: "A", new_string: "B" }, ctxFor(cwd)),
    ).rejects.toThrow(/binary file/);
  });

  test("replace_all 非 boolean 时拒绝", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "x\n");

    await expect(
      editTool.run(
        {
          path: "a.txt",
          old_string: "x",
          new_string: "y",
          replace_all: "true" as unknown as boolean,
        },
        ctxFor(cwd),
      ),
    ).rejects.toThrow(/replace_all must be a boolean/);
  });

  test("空 old_string 与无变化替换被拒绝", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "abc");

    await expect(editTool.run({ path: "a.txt", old_string: "", new_string: "x" }, ctxFor(cwd))).rejects.toThrow(
      /must not be empty/,
    );
    await expect(
      editTool.run({ path: "a.txt", old_string: "abc", new_string: "abc" }, ctxFor(cwd)),
    ).rejects.toThrow(/nothing to change/);
  });
});

describe("P7 · 路径约束", () => {
  test("读工作区之外是允许的 —— 档位不限制读", async () => {
    const cwd = await workspace();
    const outside = await workspace("bugent-outside-");
    await writeFile(join(outside, "secret.txt"), "secret");

    expect(await readTool.run({ path: join(outside, "secret.txt") }, ctxFor(cwd))).toContain("secret");
  });

  test("相对路径 ../ 读也是允许的", async () => {
    const cwd = await workspace();
    const parent = dirname(cwd);
    const name = `bugent-sibling-${basename(cwd)}.txt`;
    await writeFile(join(parent, name), "sibling");
    try {
      expect(await readTool.run({ path: `../${name}` }, ctxFor(cwd))).toContain("sibling");
    } finally {
      await rm(join(parent, name), { force: true });
    }
  });

  test("绝对路径指向工作区外被拒绝（写，未获越界授权）", async () => {
    const cwd = await workspace();
    await expect(
      writeTool.run({ path: "/tmp/bugent-should-not-be-written.txt", content: "x" }, ctxFor(cwd)),
    ).rejects.toThrow(/escapes the workspace/);
  });

  test("符号链接指向工作区外：读允许（读是自由的）", async () => {
    const cwd = await workspace();
    const outside = await workspace("bugent-outside-");
    await writeFile(join(outside, "target.txt"), "secret");
    await symlink(outside, join(cwd, "link"));

    expect(await readTool.run({ path: "link/target.txt" }, ctxFor(cwd))).toContain("secret");
  });

  test("符号链接逃逸被拒绝（新建文件）", async () => {
    const cwd = await workspace();
    const outside = await workspace("bugent-outside-");
    await symlink(outside, join(cwd, "link"));

    await expect(writeTool.run({ path: "link/new.txt", content: "x" }, ctxFor(cwd))).rejects.toThrow(/escapes the workspace/);
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

    await expect(readTool.run({ path: "docs" }, ctxFor(cwd))).rejects.toThrow(/this is a directory/);
    await expect(readTool.run({ path: "docs/" }, ctxFor(cwd))).rejects.toThrow(/this is a directory/);
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

    await expect(readTool.run({ path: "sneaky.bin" }, ctxFor(cwd))).rejects.toThrow(/binary file/);
  });

  test("行数与 wc -l 一致：结尾换行不算额外一行", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "one\ntwo\nthree\n");
    expect(await readTool.run({ path: "a.txt" }, ctxFor(cwd))).toContain("(3 lines");

    await writeFile(join(cwd, "b.txt"), "one\ntwo\nthree");
    expect(await readTool.run({ path: "b.txt" }, ctxFor(cwd))).toContain("(3 lines");
  });

  test("空文件给出明确提示", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "empty.txt"), "");
    expect(await readTool.run({ path: "empty.txt" }, ctxFor(cwd))).toContain("(empty file)");
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
      /offset 999 is beyond the file's 3 lines/,
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

describe("Windows 换行（CRLF）支持", () => {
  const ctxFor2 = (cwd: string) => ctxFor(cwd);

  test("edit_file 命中 CRLF 文件里的 LF old_string，并按 CRLF 回写", async () => {
    const cwd = await workspace();
    const p = join(cwd, "crlf.ts");
    await writeFile(p, "a\r\nconst x = 1;\r\nb\r\n");

    const out = await editTool.run(
      { path: "crlf.ts", old_string: "const x = 1;", new_string: "const x = 2;" },
      ctxFor2(cwd),
    );
    expect(out).toContain("edited");
    expect(await readFile(p, "utf8")).toBe("a\r\nconst x = 2;\r\nb\r\n");
  });

  test("edit_file 的 old_string 自带 \\r\\n 时同样命中", async () => {
    const cwd = await workspace();
    const p = join(cwd, "crlf2.txt");
    await writeFile(p, "one\r\ntwo\r\n");

    await editTool.run(
      { path: "crlf2.txt", old_string: "one\r\ntwo", new_string: "one\ntwo!" },
      ctxFor2(cwd),
    );
    expect(await readFile(p, "utf8")).toBe("one\r\ntwo!\r\n");
  });

  test("edit_file 保持 LF 文件不变", async () => {
    const cwd = await workspace();
    const p = join(cwd, "lf.txt");
    await writeFile(p, "one\ntwo\n");

    await editTool.run(
      { path: "lf.txt", old_string: "two", new_string: "two!" },
      ctxFor2(cwd),
    );
    expect(await readFile(p, "utf8")).toBe("one\ntwo!\n");
  });

  test("edit_file 在混合换行文件上逐字节保真未触碰区域", async () => {
    const cwd = await workspace();
    const p = join(cwd, "mixed.txt");
    await writeFile(p, "a\r\nb\nc\r\n");

    await editTool.run(
      { path: "mixed.txt", old_string: "b", new_string: "B" },
      ctxFor2(cwd),
    );
    expect(await readFile(p, "utf8")).toBe("a\r\nB\nc\r\n");
  });

  test("edit_file replace_all 在 CRLF 文件上全部替换", async () => {
    const cwd = await workspace();
    const p = join(cwd, "all.txt");
    await writeFile(p, "x = 1\r\ny = 1\r\n");

    await editTool.run(
      { path: "all.txt", old_string: "1", new_string: "2", replace_all: true },
      ctxFor2(cwd),
    );
    expect(await readFile(p, "utf8")).toBe("x = 2\r\ny = 2\r\n");
  });

  test("read_file 回显不残留行尾 \\r", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "crlf3.txt"), "alpha\r\nbeta\r\n");

    const out = await readTool.run({ path: "crlf3.txt" }, ctxFor2(cwd));
    expect(out).toContain("1\talpha\n");
    expect(out).not.toContain("alpha\r");
  });

  test("write_file 覆盖 CRLF 文件时沿用 CRLF；新建文件按模型给的 LF", async () => {
    const cwd = await workspace();
    const existing = join(cwd, "keep.txt");
    await writeFile(existing, "old\r\ncontent\r\n");

    await writeTool.run({ path: "keep.txt", content: "new\ncontent\n" }, ctxFor2(cwd));
    expect(await readFile(existing, "utf8")).toBe("new\r\ncontent\r\n");

    const fresh = join(cwd, "fresh.txt");
    await writeTool.run({ path: "fresh.txt", content: "a\nb\n" }, ctxFor2(cwd));
    expect(await readFile(fresh, "utf8")).toBe("a\nb\n");
  });
});
