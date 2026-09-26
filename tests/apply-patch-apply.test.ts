import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatchToWorkspace } from "../src/patch/apply.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-apply-patch-"));
  dirs.push(dir);
  return dir;
}

describe("apply_patch workspace transaction", () => {
  test("applies add, update and delete atomically", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "update.txt"), "old\nkeep\n", "utf8");
    await writeFile(join(cwd, "delete.txt"), "gone\n", "utf8");

    const result = await applyPatchToWorkspace(
      [
        "*** Begin Patch",
        "*** Add File: nested/add.txt",
        "+hello",
        "*** Update File: update.txt",
        "@@",
        "-old",
        "+new",
        "*** Delete File: delete.txt",
        "*** End Patch",
      ].join("\n"),
      cwd,
    );

    expect(await readFile(join(cwd, "nested/add.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(join(cwd, "update.txt"), "utf8")).toBe("new\nkeep\n");
    await expect(readFile(join(cwd, "delete.txt"), "utf8")).rejects.toThrow();
    expect(result.added).toEqual(["nested/add.txt"]);
    expect(result.modified).toEqual(["update.txt"]);
    expect(result.deleted).toEqual(["delete.txt"]);
    expect(result.edits.map((edit) => edit.path)).toEqual([
      "nested/add.txt",
      "update.txt",
      "delete.txt",
    ]);
  });

  test("supports move without losing line endings", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "old.txt"), "a\r\nb\r\n", "utf8");

    await applyPatchToWorkspace(
      [
        "*** Begin Patch",
        "*** Update File: old.txt",
        "*** Move to: new.txt",
        "@@",
        "-b",
        "+B",
        "*** End Patch",
      ].join("\n"),
      cwd,
      { updateFileMode: "preserve-line-endings" },
    );

    await expect(readFile(join(cwd, "old.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("a\r\nB\r\n");
  });

  test("context mismatch leaves every file untouched", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "one\n", "utf8");
    await writeFile(join(cwd, "b.txt"), "two\n", "utf8");

    await expect(
      applyPatchToWorkspace(
        [
          "*** Begin Patch",
          "*** Add File: c.txt",
          "+three",
          "*** Update File: a.txt",
          "@@",
          "-missing",
          "+changed",
          "*** End Patch",
        ].join("\n"),
        cwd,
      ),
    ).rejects.toThrow(/Failed to find expected lines/);

    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("two\n");
    await expect(readFile(join(cwd, "c.txt"), "utf8")).rejects.toThrow();
  });

  test("rejects paths outside the workspace", async () => {
    const cwd = await workspace();

    await expect(
      applyPatchToWorkspace(
        "*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch",
        cwd,
      ),
    ).rejects.toThrow(/escapes the workspace/);
  });

  test("BUG-011: Add File 拒绝覆盖已存在的文件", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "config.json"), '{"real": true}\n', "utf8");

    await expect(
      applyPatchToWorkspace(
        "*** Begin Patch\n*** Add File: config.json\n+{}\n*** End Patch",
        cwd,
      ),
    ).rejects.toThrow(/already exists/);
    expect(await readFile(join(cwd, "config.json"), "utf8")).toBe('{"real": true}\n');
  });

  test("BUG-011: Update + Move to 同一路径被拒绝，而不是删文件", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "one\n", "utf8");

    await expect(
      applyPatchToWorkspace(
        "*** Begin Patch\n*** Update File: a.txt\n*** Move to: a.txt\n@@\n-one\n+1\n*** End Patch",
        cwd,
      ),
    ).rejects.toThrow(/same path/);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("one\n");
  });

  test("BUG-011: EOF chunk 不能匹配到行游标之前（重叠替换不再互相覆盖）", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "f.txt"), "A\nB\nC\nD\nE\n", "utf8");

    // chunk1 替换 D,E -> X（EOF 锚定）；chunk2 也 EOF 锚定且模式覆盖 B..E，
    // 但它的游标在 chunk1 之后 —— 不允许再往回匹配 B..E。
    await expect(
      applyPatchToWorkspace(
        [
          "*** Begin Patch",
          "*** Update File: f.txt",
          "@@",
          "-D",
          "-E",
          "+X",
          "*** End of File",
          "-B",
          "-C",
          "-D",
          "-E",
          "+Y",
          "*** End Patch",
        ].join("\n"),
        cwd,
      ),
    ).rejects.toThrow();
    // 拒绝时文件保持原样（先算后写）
    expect(await readFile(join(cwd, "f.txt"), "utf8")).toBe("A\nB\nC\nD\nE\n");
  });

  test("BUG-011: 纯插入 chunk 尊重 @@ 锚点，不再跑到 EOF", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "code.ts"), "function foo() {}\n\nfunction bar() {}\n", "utf8");

    await applyPatchToWorkspace(
      [
        "*** Begin Patch",
        "*** Update File: code.ts",
        "@@ function foo() {}",
        "+  return null;",
        "*** End Patch",
      ].join("\n"),
      cwd,
    );

    expect(await readFile(join(cwd, "code.ts"), "utf8")).toBe(
      "function foo() {}\n  return null;\n\nfunction bar() {}\n",
    );
  });

  test("BUG-021: patch 正文里的 `*** ` 行按上下文处理，不再被当 header", async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, "doc.md"),
      "intro\n*** Update File: fake.txt\n*** End Patch\noutro\n",
      "utf8",
    );

    // 上下文行前缀空格 + 看似 header 的内容：旧实现 trimStart 后把它们当
    // 真头标记，hunk 被截断；现在它们是上下文，补丁应用后文件不变。
    await applyPatchToWorkspace(
      [
        "*** Begin Patch",
        "*** Update File: doc.md",
        "@@",
        " *** Update File: fake.txt",
        " *** End Patch",
        "*** End Patch",
      ].join("\n"),
      cwd,
    );

    expect(await readFile(join(cwd, "doc.md"), "utf8")).toBe(
      "intro\n*** Update File: fake.txt\n*** End Patch\noutro\n",
    );
  });

  test("BUG-011: 模糊匹配多处命中时拒绝，而不是改到第一个碰巧相同的段落", async () => {
    const cwd = await workspace();
    const content = "if (a) {\n  return x;\n}\nif (a) {\n  return x;\n}\n";
    await writeFile(join(cwd, "code.ts"), content, "utf8");

    // old_string 缩进写错（少一层），trim 后与两处都匹配 → 多义，必须拒绝
    await expect(
      applyPatchToWorkspace(
        [
          "*** Begin Patch",
          "*** Update File: code.ts",
          "@@",
          "-if (a) {",
          "-return x;",
          "-}",
          "+if (a) {",
          "+  return y;",
          "+}",
          "*** End Patch",
        ].join("\n"),
        cwd,
      ),
    ).rejects.toThrow(/Failed to find expected lines/);
    expect(await readFile(join(cwd, "code.ts"), "utf8")).toBe(content);
  });

  test("BUG-011: 非 UTF-8 文件拒绝编辑，不再被 U+FFFD 整文件重写", async () => {
    const cwd = await workspace();
    // GBK 编码的 "中文"：D6 D0 CE C4 —— 无 NUL 字节，旧的 NUL 检查挡不住
    const gbkBytes = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
    await Bun.write(join(cwd, "gbk.txt"), gbkBytes);

    await expect(
      applyPatchToWorkspace(
        "*** Begin Patch\n*** Update File: gbk.txt\n@@\n-x\n+y\n*** End Patch",
        cwd,
      ),
    ).rejects.toThrow(/non-UTF-8/);
    expect(new Uint8Array(await Bun.file(join(cwd, "gbk.txt")).arrayBuffer())).toEqual(gbkBytes);
  });
});
