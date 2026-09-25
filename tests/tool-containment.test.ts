/**
 * 工具自身的路径收容 —— 不经过权限闸门。
 *
 * bash 有 bwrap 内核兜底；文件工具是**进程内**的，bwrap 碰不到它们，
 * 只能靠 `resolveWithin` 这一层。所以这里把已知的逃逸手法逐条钉住：
 * 任何一条能写出工作区，就是真实的洞。
 *
 * 已发现并修掉的洞：`workspace-fs`（undo 落盘）直接 `writeFile`，会**跟随**
 * 悬空符号链接写到工作区外。write_file / edit_file / apply_patch 当时侥幸安全，
 * 只因为它们的原子写是 temp+`rename`，而 rename 替换目标而不是跟随。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplyPatchTool } from "../src/tools/apply-patch.ts";
import { createEditFileTool, createReadFileTool, createWriteFileTool } from "../src/tools/files.ts";
import { createWorkspaceFs } from "../src/tools/workspace-fs.ts";
import { applyPatchToWorkspace } from "../src/patch/apply.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  ws: string;
  outside: string;
  /** 工作区外那个"哨兵"文件，任何逃逸都会动到它。 */
  sentinel: string;
}

/**
 * 建一个工作区 + 一个工作区外的目录。
 *
 * `plant` 决定在工作区里埋什么：
 *   - dangling: `link` 是指向外部**不存在**文件的悬空符号链接
 *   - live-file: `link` 指向外部一个已存在的文件
 *   - live-dir:  `link` 指向外部一个已存在的目录
 *   - symlink-dir: 工作区内的目录本身是符号链接，指向外部
 */
async function fixture(plant: "none" | "dangling" | "live-file" | "live-dir" | "symlink-dir"): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "bugent-containment-"));
  dirs.push(base);
  const ws = join(base, "ws");
  const outside = join(base, "outside");
  await mkdir(ws, { recursive: true });
  await mkdir(outside, { recursive: true });

  const sentinel = join(outside, "sentinel.txt");
  await writeFile(sentinel, "ORIGINAL", "utf8");

  if (plant === "dangling") await symlink(join(outside, "planted.txt"), join(ws, "link"));
  if (plant === "live-file") await symlink(sentinel, join(ws, "link"));
  if (plant === "live-dir") await symlink(outside, join(ws, "link"));
  if (plant === "symlink-dir") {
    await mkdir(join(ws, "sub"), { recursive: true });
    await rm(join(ws, "sub"), { recursive: true, force: true });
    await symlink(outside, join(ws, "sub"));
  }

  return { ws, outside, sentinel };
}

function ctxFor(ws: string): ToolCtx {
  return {
    cwd: ws,
    signal: new AbortController().signal,
    callId: "call-1",
    sessionId: "containment-session",
  };
}

/** 断言工作区外一个字都没被改。 */
async function expectOutsideUntouched(f: Fixture): Promise<void> {
  expect(await Bun.file(f.sentinel).text()).toBe("ORIGINAL");
  expect(await Bun.file(join(f.outside, "planted.txt")).exists()).toBe(false);
  expect(await Bun.file(join(f.outside, "escaped.txt")).exists()).toBe(false);
}

/* ------------------------------------------------------------------ */
/* 逃逸向量 × 每个写工具                                                */
/* ------------------------------------------------------------------ */

type Writer = {
  label: string;
  /** 返回一个"用给定路径做一次写操作"的闭包。 */
  run(ws: string, path: string): Promise<unknown>;
};

const WRITERS: Writer[] = [
  {
    label: "write_file",
    run: (ws, path) => createWriteFileTool().run({ path, content: "PWNED" }, ctxFor(ws)),
  },
  {
    label: "edit_file",
    run: (ws, path) =>
      createEditFileTool().run({ path, old_string: "ORIGINAL", new_string: "PWNED" }, ctxFor(ws)),
  },
  {
    label: "apply_patch Add File",
    run: (ws, path) =>
      applyPatchToWorkspace(`*** Begin Patch\n*** Add File: ${path}\n+PWNED\n*** End Patch`, ws),
  },
  {
    label: "apply_patch Update File",
    run: (ws, path) =>
      applyPatchToWorkspace(
        `*** Begin Patch\n*** Update File: ${path}\n@@\n-ORIGINAL\n+PWNED\n*** End Patch`,
        ws,
      ),
  },
  {
    label: "apply_patch Delete File",
    run: (ws, path) => applyPatchToWorkspace(`*** Begin Patch\n*** Delete File: ${path}\n*** End Patch`, ws),
  },
  {
    label: "apply_patch Move",
    run: (ws, path) =>
      applyPatchToWorkspace(
        `*** Begin Patch\n*** Update File: ${path}\n*** Move to: escaped.txt\n@@\n-ORIGINAL\n+PWNED\n*** End Patch`,
        ws,
      ),
  },
  {
    label: "workspace-fs.write (undo)",
    run: (ws, path) => createWorkspaceFs(ws).write(path, "PWNED"),
  },
  {
    label: "workspace-fs.remove (undo)",
    run: (ws, path) => createWorkspaceFs(ws).remove(path),
  },
];

describe("工具收容 · 逃逸向量", () => {
  const vectors: Array<{ label: string; path: string; plant: Parameters<typeof fixture>[0] }> = [
    { label: "../escaped.txt", path: "../escaped.txt", plant: "none" },
    { label: "../../escaped.txt", path: "../../escaped.txt", plant: "none" },
    { label: "绝对路径指向工作区外", path: "/etc/bugent-should-not-exist", plant: "none" },
    { label: "嵌套 ../ 绕一圈", path: "sub/../../escaped.txt", plant: "none" },
    { label: "悬空符号链接", path: "link", plant: "dangling" },
    { label: "悬空符号链接下的子路径", path: "link/escaped.txt", plant: "dangling" },
    { label: "活符号链接指向外部文件", path: "link", plant: "live-file" },
    { label: "活符号链接指向外部目录", path: "link/escaped.txt", plant: "live-dir" },
    { label: "工作区内目录本身是符号链接", path: "sub/escaped.txt", plant: "symlink-dir" },
  ];

  for (const writer of WRITERS) {
    for (const vector of vectors) {
      test(`${writer.label} 挡不住 ${vector.label}`, async () => {
        const f = await fixture(vector.plant);
        try {
          await writer.run(f.ws, vector.path);
        } catch {
          // 拒绝是预期结果，不是失败。
        }
        await expectOutsideUntouched(f);
      });
    }
  }
});

describe("工具收容 · 悬空符号链接（已修的真实洞）", () => {
  /**
   * 这一条单独留一个具名用例：它是实际被利用过的那条路径。
   *
   * `resolveWithin` 的祖先校验用 `existsSync`，而它**跟随**符号链接 ——
   * 悬空链接返回 false，于是校验一路上溯到父目录（在工作区内）判定安全，
   * 真正写盘时内核再跟随链接写到外面。
   */
  test("workspace-fs 不会跟随悬空链接写到工作区外", async () => {
    const f = await fixture("dangling");
    await expect(createWorkspaceFs(f.ws).write("link", "PWNED")).rejects.toThrow(/escapes the workspace/);
    await expectOutsideUntouched(f);
  });

  test("write_file / edit_file / apply_patch 同样拒绝悬空链接", async () => {
    for (const writer of WRITERS.filter((w) => w.label !== "workspace-fs.remove (undo)")) {
      const f = await fixture("dangling");
      await writer.run(f.ws, "link").catch(() => {});
      await expectOutsideUntouched(f);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 合法用法不能被误伤                                                   */
/* ------------------------------------------------------------------ */

describe("工具收容 · 合法路径仍然可用", () => {
  test("普通路径与自动建目录", async () => {
    const f = await fixture("none");
    await createWriteFileTool().run({ path: "a/b/c.txt", content: "ok" }, ctxFor(f.ws));
    expect(await Bun.file(join(f.ws, "a/b/c.txt")).text()).toBe("ok");
  });

  test("工作区内的符号链接（活链接）照常可读可写", async () => {
    const f = await fixture("none");
    await mkdir(join(f.ws, "real"), { recursive: true });
    await writeFile(join(f.ws, "real", "a.txt"), "hello\n", "utf8");
    await symlink(join(f.ws, "real"), join(f.ws, "alias"));

    const read = await createReadFileTool().run({ path: "alias/a.txt" }, ctxFor(f.ws));
    expect(read).toContain("hello");

    await createWriteFileTool().run({ path: "alias/b.txt", content: "written" }, ctxFor(f.ws));
    expect(await Bun.file(join(f.ws, "real", "b.txt")).text()).toBe("written");
  });

  test("指向工作区内文件的符号链接可以读取", async () => {
    const f = await fixture("none");
    await writeFile(join(f.ws, "target.txt"), "inner\n", "utf8");
    await symlink(join(f.ws, "target.txt"), join(f.ws, "alias.txt"));
    expect(await createReadFileTool().run({ path: "alias.txt" }, ctxFor(f.ws))).toContain("inner");
  });

  test("undo 落盘走原子写，不留临时文件", async () => {
    const f = await fixture("none");
    await createWorkspaceFs(f.ws).write("undo.txt", "restored");
    expect(await Bun.file(join(f.ws, "undo.txt")).text()).toBe("restored");
    const entries = [...new Bun.Glob("*").scanSync({ cwd: f.ws })];
    expect(entries.filter((name) => name.includes("bugent-tmp"))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* apply_patch 工具的权限声明                                           */
/* ------------------------------------------------------------------ */

describe("apply_patch 工具声明", () => {
  test("声明需要写工作区，但不自带 ask（否则每次调用都弹窗）", () => {
    const tool = createApplyPatchTool();
    expect(tool.requires).toEqual({ write: true });
    expect(tool.defaultPermission).toBeUndefined();
  });

  test("与 write_file / edit_file 的声明保持一致", () => {
    const patch = createApplyPatchTool();
    for (const sibling of [createWriteFileTool(), createEditFileTool()]) {
      expect(patch.requires).toEqual(sibling.requires);
      expect(patch.defaultPermission).toBe(sibling.defaultPermission);
    }
  });

  test("悬空链接不会被 lstat 之外的检查漏掉", async () => {
    const f = await fixture("dangling");
    // 链接本身还在（没被替换成普通文件），且外部没被创建
    expect((await lstat(join(f.ws, "link"))).isSymbolicLink()).toBe(true);
    await expectOutsideUntouched(f);
  });
});
