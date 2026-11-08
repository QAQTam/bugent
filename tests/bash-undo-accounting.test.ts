/**
 * bash 写工作区的 undo 记账（HANDOFF 原 P0「沙箱内写盘的可观测性」）。
 *
 * write_file/edit_file/apply_patch 自报 before/after，bash 此前完全不报 ——
 * /undo 对 bash 写的文件要么静默漏掉、要么因 afterHash 冲突整体拒绝。
 * 这里用**真实 shell runner** 跑命令，断言 run() 期间经 ctx.onWorkspaceChange
 * 报出的 WorkspaceFileEdit：创建/覆盖/追加/删除/未变化/工作区外/目录目标/
 * 超限与非 UTF-8 的不可逆降级。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool, createShellRunner } from "../src/tools/bash.ts";
import type { WorkspaceFileEdit } from "../src/core/workspace.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-bash-undo-"));
  dirs.push(dir);
  return dir;
}

function ctxWith(cwd: string, edits: WorkspaceFileEdit[]): ToolCtx {
  return {
    cwd,
    signal: new AbortController().signal,
    callId: "c1",
    sessionId: "bash-undo",
    onWorkspaceChange: (edit) => edits.push(edit),
  };
}

const tool = createBashTool(createShellRunner());

async function run(command: string, cwd: string, edits: WorkspaceFileEdit[]): Promise<string> {
  return tool.run({ command }, ctxWith(cwd, edits));
}

describe("bash 写工作区的 undo 记账", () => {
  test("重定向：创建 / 覆盖 / 追加都产出 WorkspaceFileEdit", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "old.txt"), "old\n", "utf8");

    const edits: WorkspaceFileEdit[] = [];
    await run("echo hello > created.txt", cwd, edits);
    await run("echo x > old.txt", cwd, edits);
    await run("echo more >> old.txt", cwd, edits);

    const created = edits.find((edit) => edit.path === join(cwd, "created.txt"));
    expect(created).toMatchObject({
      beforeExists: false,
      afterExists: true,
      before: "",
      after: "hello\n",
    });

    const overwritten = edits.filter((edit) => edit.path === join(cwd, "old.txt"));
    expect(overwritten).toHaveLength(2);
    expect(overwritten[0]).toMatchObject({
      beforeExists: true,
      afterExists: true,
      before: "old\n",
      after: "x\n",
    });
    expect(overwritten[1]).toMatchObject({
      beforeExists: true,
      afterExists: true,
      before: "x\n",
      after: "x\nmore\n",
    });
    for (const edit of edits) expect(edit.reversible).toBe(true);
  });

  test("rm / tee / cp：删除恢复内容，管道与拷贝目标都记到", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "gone.txt"), "precious\n", "utf8");
    await writeFile(join(cwd, "src.txt"), "copy me\n", "utf8");

    const edits: WorkspaceFileEdit[] = [];
    await run("rm gone.txt", cwd, edits);
    await run("printf 'tee out\\n' | tee tee.txt", cwd, edits);
    await run("cp src.txt dst.txt", cwd, edits);

    const removed = edits.find((edit) => edit.path === join(cwd, "gone.txt"));
    expect(removed).toMatchObject({
      beforeExists: true,
      afterExists: false,
      before: "precious\n",
      after: "",
      reversible: true,
    });
    const tee = edits.find((edit) => edit.path === join(cwd, "tee.txt"));
    expect(tee).toMatchObject({ beforeExists: false, afterExists: true, after: "tee out\n" });
    const copied = edits.find((edit) => edit.path === join(cwd, "dst.txt"));
    expect(copied).toMatchObject({ beforeExists: false, afterExists: true, after: "copy me\n" });
  });

  test("内容未变化不记账；工作区外目标与目录目标忽略", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "same.txt"), "untouched\n", "utf8");

    const edits: WorkspaceFileEdit[] = [];
    await run("touch same.txt", cwd, edits);
    // 工作区（tmpdir 下的临时目录）之外的绝对路径
    await run("echo outside > /tmp/bugent-undo-outside-probe.txt", cwd, edits);
    await run("mkdir sub", cwd, edits);

    expect(edits).toEqual([]);
  });

  test("无 onRequestCapability（no-sandbox 形态）同样记账", async () => {
    const cwd = await workspace();
    const edits: WorkspaceFileEdit[] = [];
    const ctx: ToolCtx = {
      cwd,
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "bash-undo",
      onWorkspaceChange: (edit) => edits.push(edit),
    };
    await tool.run({ command: "echo plain > plain.txt" }, ctx);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      path: join(cwd, "plain.txt"),
      beforeExists: false,
      afterExists: true,
      after: "plain\n",
    });
  });

  test("超过快照上限的文件记为不可逆；非 UTF-8 同样", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "big.txt"), "x".repeat(8 * 1024 * 1024 + 1), "utf8");
    await writeFile(join(cwd, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00]), "utf8");

    const edits: WorkspaceFileEdit[] = [];
    await run("echo small > big.txt", cwd, edits);
    await run("echo ascii > bin.dat", cwd, edits);

    const big = edits.find((edit) => edit.path === join(cwd, "big.txt"));
    expect(big?.reversible).toBe(false);
    expect(big?.irreversibleReason).toContain("快照上限");
    expect(big?.after).toBe("small\n");

    const bin = edits.find((edit) => edit.path === join(cwd, "bin.dat"));
    expect(bin?.reversible).toBe(false);
    expect(bin?.irreversibleReason).toContain("UTF-8");

    // 落盘的真实内容不受记账影响
    expect(await readFile(join(cwd, "big.txt"), "utf8")).toBe("small\n");
  });

  test("经 ToolRegistry.execute 走一道：workspace 变更被收集进 ToolExecution", async () => {
    const { ToolRegistry } = await import("../src/tools/types.ts");
    const cwd = await workspace();
    const registry = new ToolRegistry().register(tool);
    const edits: WorkspaceFileEdit[] = [];
    const execution = await registry.execute(
      { id: "c-reg-1", name: "exec", args: { command: "echo via-registry > reg.txt" } },
      ctxWith(cwd, edits),
    );
    expect(execution.ok).toBe(true);
    expect(edits).toHaveLength(1);
    expect(execution.workspace?.map((edit) => edit.path)).toEqual([join(cwd, "reg.txt")]);
    expect(execution.workspace?.every((edit) => edit.reversible)).toBe(true);
  });
});
