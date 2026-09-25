/**
 * 权限接线 —— 三档 × 真实工具的矩阵。
 *
 * 这里存在的唯一理由：`tests/mode.test.ts` 测的是**闸门**，但它手工构造
 * `PermissionRequest`（自己把 `requires` 填上了），于是绕过了 `describeCall`。
 * 而生产代码里 `describeCall` 恰恰把 `tool.requires` 丢掉了 —— 闸门里那段
 * 档位检查从来没有执行过，read-only 档下 `write_file` 能直接写盘。
 *
 * 单测全绿、线上全废。所以这份用例一律走**真实工具 + 真实 ToolRegistry**，
 * 让接线本身成为被测对象。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionGate } from "../src/permission/gate.ts";
import { composePolicy, PermissionPolicy } from "../src/permission/policy.ts";
import type { SandboxMode } from "../src/permission/mode.ts";
import { createDefaultTools } from "../src/tools/builtin.ts";
import { createApplyPatchTool } from "../src/tools/apply-patch.ts";
import { createEditFileTool, createReadFileTool, createWriteFileTool } from "../src/tools/files.ts";
import { createTodoWriteTool } from "../src/tools/todo.ts";
import { describeCall, type Tool, type ToolCtx } from "../src/tools/types.ts";
import type { ShellRunner } from "../src/tools/bash.ts";

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-wiring-"));
  dirs.push(dir);
  return dir;
}

/** 这些用例不执行 shell；真被调到就是测试写错了。 */
const forbiddenRunner: ShellRunner = {
  async run() {
    throw new Error("测试不应执行 shell 命令");
  },
};

const PATCH = "*** Begin Patch\n*** Add File: patched.txt\n+hello\n*** End Patch";

interface Outcome {
  ok: boolean;
  output: string;
}

/**
 * 跑一次真实的工具调用：真实 registry → describeCall → 真实闸门 → tool.run。
 *
 * `prompter` 一律拒绝、且不给 onEscalate —— 也就是"用户不批准任何越档"。
 * 这样凡是能执行的，都说明档位本身允许它。
 */
async function execute(
  mode: SandboxMode,
  cwd: string,
  name: string,
  args: unknown,
  options: { approveEscalation?: boolean } = {},
): Promise<Outcome> {
  const setup = createDefaultTools({ mode, runner: forbiddenRunner });
  const policy = new PermissionPolicy(composePolicy(undefined, setup.registry.defaultPermissionRules()));
  const gate = new PermissionGate({
    policy,
    mode,
    prompter: { ask: async () => false },
    ...(options.approveEscalation === true
      ? { onEscalate: async (_request, needed: SandboxMode) => needed }
      : {}),
  });
  setup.registry.setGate(gate);

  const ctx: ToolCtx = {
    cwd,
    signal: new AbortController().signal,
    callId: "call-1",
    sessionId: "wiring-session",
  };
  const result = await setup.registry.execute({ id: "call-1", name, args }, ctx);
  return { ok: result.ok, output: result.output };
}

const WRITE_CALLS: Array<{ name: string; args: unknown; file: string }> = [
  { name: "write_file", args: { path: "out.txt", content: "hello" }, file: "out.txt" },
  {
    name: "edit_file",
    args: { path: "out.txt", old_string: "hello", new_string: "bye" },
    file: "out.txt",
  },
  { name: "apply_patch", args: { patch: PATCH }, file: "patched.txt" },
];

/* ------------------------------------------------------------------ */
/* 接线本身                                                             */
/* ------------------------------------------------------------------ */

describe("describeCall 必须把 requires 带下去", () => {
  test("声明了 requires 的工具，请求里就有 requires", () => {
    const call = { id: "c1", name: "write_file", args: { path: "a.txt", content: "x" } };
    expect(describeCall(createWriteFileTool(), call).requires).toEqual({ write: true });
    expect(describeCall(createEditFileTool(), call).requires).toEqual({ write: true });
    expect(describeCall(createApplyPatchTool(), call).requires).toEqual({ write: true });
  });

  test("没声明 requires 的工具不凭空多出一个字段", () => {
    const request = describeCall(createReadFileTool(), { id: "c1", name: "read_file", args: { path: "a.txt" } });
    expect("requires" in request).toBe(false);
  });

  test("tool / resource / summary 照旧传递", () => {
    const request = describeCall(createWriteFileTool(), {
      id: "c1",
      name: "write_file",
      args: { path: "a/b.txt", content: "x" },
    });
    expect(request.tool).toBe("write_file");
    expect(request.resource).toBe("a/b.txt");
    expect(request.summary).toContain("a/b.txt");
  });

  test("每个声明了 requires 的内置工具都能被 describeCall 带出来", () => {
    const tools: Tool[] = [createWriteFileTool(), createEditFileTool(), createApplyPatchTool(), createTodoWriteTool()];
    for (const tool of tools) {
      if (tool.requires === undefined) continue;
      const request = describeCall(tool, { id: "c1", name: tool.name, args: { patch: PATCH } });
      expect(request.requires).toEqual(tool.requires);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 三档 × 写工具矩阵                                                    */
/* ------------------------------------------------------------------ */

describe("read-only 档：进程内写工具一律被挡", () => {
  for (const entry of WRITE_CALLS) {
    test(`${entry.name} 被拒，且不会落盘`, async () => {
      const cwd = await workspace();
      const result = await execute("read-only", cwd, entry.name, entry.args);

      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/不支持写入工作区|需要升到/);
      expect(await Bun.file(join(cwd, entry.file)).exists()).toBe(false);
    });
  }

  test("策略默认放行也挡得住 —— 边界是档位给的，不是策略给的", async () => {
    const cwd = await workspace();
    // 不配任何规则 => policy 默认 allow；拦住它的只能是档位检查
    const result = await execute("read-only", cwd, "write_file", { path: "out.txt", content: "x" });
    expect(result.ok).toBe(false);
    expect(await Bun.file(join(cwd, "out.txt")).exists()).toBe(false);
  });

  test("只读工具不受影响，照常放行", async () => {
    const cwd = await workspace();
    await Bun.write(join(cwd, "readable.txt"), "content\n");
    const result = await execute("read-only", cwd, "read_file", { path: "readable.txt" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("content");
  });

  test("批准升档后确实放行，且档位真的升了", async () => {
    const cwd = await workspace();
    const result = await execute("read-only", cwd, "write_file", { path: "out.txt", content: "x" }, {
      approveEscalation: true,
    });
    expect(result.ok).toBe(true);
    expect(await Bun.file(join(cwd, "out.txt")).text()).toBe("x");
  });
});

describe("workspace-write 档：写工具直接放行，不打扰用户", () => {
  for (const entry of WRITE_CALLS) {
    test(`${entry.name} 放行并真的落盘`, async () => {
      const cwd = await workspace();
      if (entry.name === "edit_file") await Bun.write(join(cwd, "out.txt"), "hello\n");

      const result = await execute("workspace-write", cwd, entry.name, entry.args);

      expect(result.ok).toBe(true);
      expect(await Bun.file(join(cwd, entry.file)).exists()).toBe(true);
    });
  }

  test("apply_patch 不再弹窗 —— 与 write_file 行为一致", async () => {
    const cwd = await workspace();
    // prompter 一律拒绝；apply_patch 若还带 defaultPermission:"ask" 就会被拒。
    const result = await execute("workspace-write", cwd, "apply_patch", { patch: PATCH });
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("用户拒绝");
  });
});

describe("no-sandbox 档：写工具放行", () => {
  for (const entry of WRITE_CALLS) {
    test(`${entry.name} 放行`, async () => {
      const cwd = await workspace();
      if (entry.name === "edit_file") await Bun.write(join(cwd, "out.txt"), "hello\n");
      const result = await execute("no-sandbox", cwd, entry.name, entry.args);
      expect(result.ok).toBe(true);
    });
  }
});

/* ------------------------------------------------------------------ */
/* 三档的差别只在"能不能写"                                             */
/* ------------------------------------------------------------------ */

describe("三档能力差异", () => {
  test("同一份写调用：read-only 拒，另两档放行", async () => {
    const outcomes: Record<string, boolean> = {};
    for (const mode of ["read-only", "workspace-write", "no-sandbox"] as const) {
      const cwd = await workspace();
      outcomes[mode] = (await execute(mode, cwd, "write_file", { path: "out.txt", content: "x" })).ok;
    }
    expect(outcomes).toEqual({ "read-only": false, "workspace-write": true, "no-sandbox": true });
  });
});
