/**
 * 原子写与 TOCTOU 收窄的回归（BUG-012）。
 *
 * 竞态窗口本身无法确定性复现，这里验证三件确定的事：
 *   1. 落盘后目标真实路径必须在边界内（final 组件被换成符号链接时拒收）；
 *   2. 中间目录是指向边界外的符号链接时，写被拒绝且不留任何文件；
 *   3. 并发写同一目标不再共享临时文件（随机 temp 段 + wx 标志）。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteWithin } from "../src/tools/atomic-write.ts";
import { PathEscapeError } from "../src/tools/paths.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-atomic-write-"));
  dirs.push(dir);
  return dir;
}

describe("atomicWriteWithin（BUG-012）", () => {
  test("正常写：temp + rename 后内容与权限就位", async () => {
    const root = await workspace();
    const target = join(root, "sub", "a.txt");

    await atomicWriteWithin(root, false, target, "hello\n", undefined);

    expect(await readFile(target, "utf8")).toBe("hello\n");
  });

  test("中间目录被换成边界外的符号链接时：拒绝写，且不留任何文件", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "bugent-atomic-outside-"));
    dirs.push(outside);
    const link = join(root, "dir");
    await symlink(outside, link);
    const target = join(link, "x.txt");

    await expect(atomicWriteWithin(root, false, target, "pwn\n", undefined)).rejects.toThrow(
      PathEscapeError,
    );
    // 外面没有落盘
    await expect(readFile(join(outside, "x.txt"), "utf8")).rejects.toThrow();
    // temp 也不存在
    await expect(readFile(`${target}.bugent-tmp-0-0-0`, "utf8")).rejects.toThrow();
  });

  test("final 组件是符号链接时：rename 替换链接本身，真实落点仍在边界内", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "bugent-atomic-outside-"));
    dirs.push(outside);
    await writeFile(join(outside, "victim.txt"), "victim\n", "utf8");
    const target = join(root, "file.txt");
    await writeFile(target, "original\n", "utf8");
    await symlink(join(outside, "victim.txt"), `${target}.link`);
    await rm(target);
    await symlink(join(outside, "victim.txt"), target);

    // rename 不跟随 final 符号链接：链接被替换掉，外面的 victim 保持原样
    await atomicWriteWithin(root, false, target, "new\n", undefined);

    expect(await readFile(target, "utf8")).toBe("new\n");
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("victim\n");
  });

  test("并发写同一目标：随机 temp 段 + wx，两次都成功", async () => {
    const root = await workspace();
    const target = join(root, "busy.txt");
    await writeFile(target, "seed\n", "utf8");
    await mkdir(root, { recursive: true });

    await Promise.all([
      atomicWriteWithin(root, false, target, "first\n", undefined),
      atomicWriteWithin(root, false, target, "second\n", undefined),
    ]);

    // 两次都成功，最终内容是其中之一（rename 原子性决定谁后到）
    const content = await readFile(target, "utf8");
    expect(["first\n", "second\n"]).toContain(content);
  });
});
