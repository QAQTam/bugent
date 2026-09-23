import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditFileTool, createWriteFileTool } from "../src/tools/files.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import { createWorkspaceFs } from "../src/tools/workspace-fs.ts";
import { AgentSession } from "../src/core/session.ts";
import { runTurn } from "../src/core/loop.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import {
  applyPatch,
  createWorkspaceChange,
  diffPatch,
  hashContent,
  reversePatch,
  type WorkspaceFileEdit,
} from "../src/core/workspace.ts";
import { applyWorkspaceUndo, planWorkspaceUndo } from "../src/core/workspace-undo.ts";
import { makeMessage, textPart } from "../src/core/message.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function workspace(prefix = "bugent-workspace-undo-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function messageWithEdit(msgid: number, edit: WorkspaceFileEdit) {
  const workspace = createWorkspaceChange([edit]);
  return makeMessage({
    msgid,
    parentMsgId: msgid - 1,
    role: "tool",
    origin: "tool",
    parts: [textPart("changed")],
    createdAt: msgid,
    toolCallId: `c${msgid}`,
    ...(workspace !== undefined ? { workspace } : {}),
  });
}

describe("workspace patch", () => {
  test("diff / reverse / apply 往返，并保留末尾换行", () => {
    const before = "one\ntwo\nthree\n";
    const after = "one\nTWO\nthree";

    const forward = diffPatch(before, after);
    const forwardApplied = applyPatch(before, forward);
    expect(forwardApplied.ok).toBe(true);
    if (forwardApplied.ok) expect(forwardApplied.text).toBe(after);

    const backward = applyPatch(after, reversePatch(forward));
    expect(backward.ok).toBe(true);
    if (backward.ok) expect(backward.text).toBe(before);
  });

  test("上下文不匹配时报冲突，而不是写坏文件", () => {
    const patch = diffPatch("one\ntwo\n", "one\nTWO\n");
    const result = applyPatch("one\nother\n", reversePatch(patch));
    expect(result.ok).toBe(false);
  });

  test("hashContent 稳定且对内容敏感", () => {
    expect(hashContent("abc")).toBe(hashContent("abc"));
    expect(hashContent("abc")).not.toBe(hashContent("abd"));
  });
});

describe("文件工具上报工作区变更", () => {
  test("write_file 上报新建与覆盖的 before/after", async () => {
    const cwd = await workspace();
    const edits: WorkspaceFileEdit[] = [];
    const ctx: ToolCtx = {
      cwd,
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "s1",
      onWorkspaceChange: (edit) => edits.push(edit),
    };

    await createWriteFileTool().run({ path: "a.txt", content: "hello\n" }, ctx);
    await createWriteFileTool().run({ path: "a.txt", content: "hello\nworld\n" }, ctx);

    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({
      path: "a.txt",
      before: "",
      after: "hello\n",
      beforeExists: false,
      afterExists: true,
    });
    expect(edits[1]).toMatchObject({
      path: "a.txt",
      before: "hello\n",
      after: "hello\nworld\n",
      beforeExists: true,
      afterExists: true,
    });
  });

  test("edit_file 上报原内容和更新内容", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "a.txt"), "alpha\nbeta\n", "utf8");
    const edits: WorkspaceFileEdit[] = [];
    const ctx: ToolCtx = {
      cwd,
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "s1",
      onWorkspaceChange: (edit) => edits.push(edit),
    };

    await createEditFileTool().run(
      { path: "a.txt", old_string: "beta", new_string: "BETA" },
      ctx,
    );

    expect(edits).toEqual([
      {
        path: "a.txt",
        before: "alpha\nbeta\n",
        after: "alpha\nBETA\n",
        beforeExists: true,
        afterExists: true,
        reversible: true,
      },
    ]);
  });
});

describe("workspace undo", () => {
  test("撤回已有文件并支持新建文件删除", async () => {
    const cwd = await workspace();
    const fs = createWorkspaceFs(cwd);
    await writeFile(join(cwd, "edit.txt"), "two\n", "utf8");
    await writeFile(join(cwd, "created.txt"), "created\n", "utf8");

    const messages = [
      messageWithEdit(1, {
        path: "edit.txt",
        before: "one\n",
        after: "two\n",
        beforeExists: true,
        afterExists: true,
      }),
      messageWithEdit(2, {
        path: "created.txt",
        before: "",
        after: "created\n",
        beforeExists: false,
        afterExists: true,
      }),
    ];

    const plan = await planWorkspaceUndo(messages, fs);
    expect(plan.conflicts).toEqual([]);
    expect([...plan.files].sort()).toEqual(["created.txt", "edit.txt"]);

    const result = await applyWorkspaceUndo(plan, fs);
    expect(result.ok).toBe(true);
    expect(await readFile(join(cwd, "edit.txt"), "utf8")).toBe("one\n");
    await expect(readFile(join(cwd, "created.txt"), "utf8")).rejects.toThrow();
  });

  test("链式修改按逆序逐级回退", async () => {
    const cwd = await workspace();
    const fs = createWorkspaceFs(cwd);
    await writeFile(join(cwd, "a.txt"), "v3\n", "utf8");

    const plan = await planWorkspaceUndo(
      [
        messageWithEdit(1, {
          path: "a.txt",
          before: "v1\n",
          after: "v2\n",
          beforeExists: true,
          afterExists: true,
        }),
        messageWithEdit(2, {
          path: "a.txt",
          before: "v2\n",
          after: "v3\n",
          beforeExists: true,
          afterExists: true,
        }),
      ],
      fs,
    );

    expect(plan.conflicts).toEqual([]);
    expect((await applyWorkspaceUndo(plan, fs)).ok).toBe(true);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("v1\n");
  });

  test("外部修改产生冲突且不写入任何文件", async () => {
    const cwd = await workspace();
    const fs = createWorkspaceFs(cwd);
    await writeFile(join(cwd, "a.txt"), "external\n", "utf8");
    await writeFile(join(cwd, "b.txt"), "two\n", "utf8");

    const plan = await planWorkspaceUndo(
      [
        messageWithEdit(1, {
          path: "a.txt",
          before: "one\n",
          after: "two\n",
          beforeExists: true,
          afterExists: true,
        }),
        messageWithEdit(2, {
          path: "b.txt",
          before: "one\n",
          after: "two\n",
          beforeExists: true,
          afterExists: true,
        }),
      ],
      fs,
    );

    expect(plan.conflicts).toEqual(["a.txt"]);
    const result = await applyWorkspaceUndo(plan, fs);
    expect(result.ok).toBe(false);
    expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("two\n");
  });

  test("不可逆项进入 skipped，不影响可逆项", async () => {
    const cwd = await workspace();
    const fs = createWorkspaceFs(cwd);
    await writeFile(join(cwd, "a.txt"), "two\n", "utf8");

    const plan = await planWorkspaceUndo(
      [
        messageWithEdit(1, {
          path: "a.txt",
          before: "one\n",
          after: "two\n",
          beforeExists: true,
          afterExists: true,
          reversible: false,
          irreversibleReason: "测试不可逆",
        }),
      ],
      fs,
    );

    expect(plan.irreversible).toEqual(["a.txt（测试不可逆）"]);
    const result = await applyWorkspaceUndo(plan, fs);
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual(["a.txt（测试不可逆）"]);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("two\n");
  });

  test("loop 会把工具上报的 workspace 元数据挂到 tool result 消息", async () => {
    const cwd = await workspace();
    const session = new AgentSession({
      id: "workspace-loop",
      system: "SYS",
      client: createMockClient({
        script: [
          {
            toolCalls: [
              {
                id: "c1",
                name: "write_file",
                args: { path: "created.txt", content: "hello\n" },
              },
            ],
          },
          { text: "完成" },
        ],
      }),
      model: "test-model",
      now: () => 1,
    });
    session.appendUser("写文件");

    await runTurn(session, {
      tools: new ToolRegistry().register(createWriteFileTool()),
      cwd,
    });

    const toolMessage = session.messages.find((message) => message.role === "tool");
    expect(toolMessage?.workspace?.files).toHaveLength(1);
    expect(toolMessage?.workspace?.files[0]).toMatchObject({
      path: "created.txt",
      beforeExists: false,
      afterExists: true,
    });
    expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("hello\n");
  });
});
