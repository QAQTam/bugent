import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplyPatchTool, APPLY_PATCH_TOOL_NAME } from "../src/tools/apply-patch.ts";
import { createWorkspaceChange } from "../src/core/workspace.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-apply-patch-tool-"));
  dirs.push(dir);
  return dir;
}

describe("apply_patch tool", () => {
  test("uses Codex-compatible tool name, description and permission", () => {
    const tool = createApplyPatchTool();
    expect(tool.name).toBe(APPLY_PATCH_TOOL_NAME);
    expect(tool.description).toContain("*** Begin Patch");
    expect(tool.description).toContain("*** Update File:");
    expect(tool.requires).toEqual({ write: true });
    // 刻意**不**自带 defaultPermission。
    //
    // 这里曾经是 "ask"，后果是每次 apply_patch 都弹窗确认 —— 即使档位是
    // workspace-write（写工作区本来就是那一档声明的边界），而且和同类的
    // write_file / edit_file 行为不一致。写权限由 `requires` 交给档位判断。
    expect(tool.defaultPermission).toBeUndefined();
  });

  test("applies a multi-file patch and reports workspace edits", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "one\n", "utf8");
    const edits: unknown[] = [];
    const ctx: ToolCtx = {
      cwd,
      signal: new AbortController().signal,
      callId: "call-1",
      sessionId: "session-1",
      onWorkspaceChange: (edit) => edits.push(edit),
    };
    const tool = createApplyPatchTool();
    const patch = [
      "*** Begin Patch",
      "*** Add File: b.txt",
      "+two",
      "*** Update File: a.txt",
      "@@",
      "-one",
      "+ONE",
      "*** End Patch",
    ].join("\n");

    const output = await tool.run({ patch }, ctx);
    expect(output).toContain("Success. Updated the following files:");
    expect(output).toContain("A b.txt");
    expect(output).toContain("M a.txt");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("ONE\n");
    expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("two\n");
    expect(edits).toHaveLength(2);

    const change = createWorkspaceChange(edits as never);
    expect(change?.files.map((file) => file.path)).toEqual(["b.txt", "a.txt"]);
  });

  test("accepts the same patch as freeform text or a JSON function argument", async () => {
    const cwd = await workspace();
    const ctx: ToolCtx = {
      cwd,
      signal: new AbortController().signal,
      callId: "call-freeform",
      sessionId: "session-1",
    };
    const tool = createApplyPatchTool();
    const patch = "*** Begin Patch\n*** Add File: free.txt\n+ok\n*** End Patch";

    await tool.run(patch, ctx);
    expect(await readFile(join(cwd, "free.txt"), "utf8")).toBe("ok\n");

    await tool.run({ patch: "*** Begin Patch\n*** Update File: free.txt\n@@\n-ok\n+still ok\n*** End Patch" }, ctx);
    expect(await readFile(join(cwd, "free.txt"), "utf8")).toBe("still ok\n");
  });

  test("derives file-level resource locks and rejects path escape", async () => {
    const cwd = await workspace();
    const tool = createApplyPatchTool();
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch";
    const ctx: ToolCtx = {
      cwd,
      signal: new AbortController().signal,
      callId: "call-1",
      sessionId: "session-1",
    };
    expect(tool.resources?.({ patch }, ctx)).toEqual([
      { key: "workspace/a.txt", access: "write" },
    ]);

    await expect(
      tool.run(
        { patch: "*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch" },
        ctx,
      ),
    ).rejects.toThrow(/escapes the workspace/);
  });
});
