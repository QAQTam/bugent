/**
 * 档位语义 —— 三档是"默认批准范围"，不是"能力边界"。
 *
 * 这份用例存在的理由（和 `permission-wiring.test.ts` 同一个）：档位语义在
 * 类型层写得完整，在消费端容易只接一半。三处曾经真实错配过：
 *
 *   1. `readOutside` 声明了但**从来没有消费者** —— 三档读工作区外全被拦；
 *   2. `--allow-network` 在 CLI 解析了但**没有人消费** —— 传了不生效；
 *   3. `no-sandbox` 被实现成"关掉 bwrap"，而语义是"默认批准一切、不拦截"。
 *
 * 所以这里一律走**真实工具 + 真实 registry + 真实闸门**，并且断言到
 * "文件真的落盘了吗""沙箱真的还在吗"这一层，而不是断言返回值形状。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionGate } from "../src/permission/gate.ts";
import { composePolicy, PermissionPolicy } from "../src/permission/policy.ts";
import type { SandboxMode } from "../src/permission/mode.ts";
import { createDefaultTools } from "../src/tools/builtin.ts";
import type { ShellRunner } from "../src/tools/bash.ts";
import { describeCall, type ToolCtx } from "../src/tools/types.ts";
import { sessionOutputDir } from "../src/tools/spill.ts";

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix = "bugent-modes-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 这些用例不执行 shell；真被调到就是测试写错了。 */
const forbiddenRunner: ShellRunner = {
  async run() {
    throw new Error("测试不应执行 shell 命令");
  },
};

interface ProbeOptions {
  /** 是否给闸门一个"用户批准这一次"的处理器。 */
  approve?: boolean;
  /** 是否给闸门一个"用户确认"的处理器（显式 ask 规则用）。 */
  ask?: boolean;
}

interface Probe {
  /** 执行一次工具调用，返回是否成功。 */
  call(name: string, args: unknown): Promise<{ ok: boolean; output: string }>;
  /** 当前闸门档位（用来断言"批准没有偷偷改档位"）。 */
  mode(): SandboxMode;
  /** 审批处理器被调用了几次（断言"按次"）。 */
  approvals(): number;
}

function probe(mode: SandboxMode, cwd: string, options: ProbeOptions = {}): Probe {
  const setup = createDefaultTools({ mode, runner: forbiddenRunner });
  const policy = new PermissionPolicy(
    composePolicy(undefined, setup.registry.defaultPermissionRules()),
  );
  let approvals = 0;
  const gate = new PermissionGate({
    policy,
    mode,
    prompter: { ask: async () => (options.ask === true ? "approved" : "denied") },
    ...(options.approve === true
      ? {
          onEscalate: async () => {
            approvals += 1;
            return "approved" as const;
          },
        }
      : {}),
  });
  setup.registry.setGate(gate);

  const ctx: ToolCtx = {
    cwd,
    signal: new AbortController().signal,
    callId: "call-1",
    sessionId: "modes-session",
  };

  return {
    async call(name, args) {
      const result = await setup.registry.execute({ id: "call-1", name, args }, ctx);
      return { ok: result.ok, output: result.output };
    },
    mode: () => gate.mode,
    approvals: () => approvals,
  };
}

/* ------------------------------------------------------------------ */
/* 读：三档都自由                                                       */
/* ------------------------------------------------------------------ */

describe("读工作区之外在三档都是自由的", () => {
  for (const mode of ["read-only", "workspace-write", "no-sandbox"] as const) {
    test(`${mode} 档下 read_file 能读到工作区外`, async () => {
      const cwd = await tempDir();
      const outside = await tempDir("bugent-outside-");
      await writeFile(join(outside, "secret.txt"), "SECRET");

      const result = await probe(mode, cwd).call("read_file", {
        path: join(outside, "secret.txt"),
      });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("SECRET");
    });
  }

  test("read_file 不给闸门添麻烦 —— 读不触发任何审批", async () => {
    const cwd = await tempDir();
    const outside = await tempDir("bugent-outside-");
    await writeFile(join(outside, "x.txt"), "x");

    const p = probe("read-only", cwd, { approve: true });
    expect((await p.call("read_file", { path: join(outside, "x.txt") })).ok).toBe(true);
    expect(p.approvals()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 写：越界一律按次授权                                                 */
/* ------------------------------------------------------------------ */

describe("写工作区之外需要按次授权", () => {
  test("workspace-write 档下未获批准 → 拒，且文件不落盘", async () => {
    const cwd = await tempDir();
    const outside = await tempDir("bugent-outside-");
    const target = join(outside, "new.txt");

    const result = await probe("workspace-write", cwd).call("write_file", {
      path: target,
      content: "x",
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("写入工作区之外");
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test("workspace-write 档下获批准 → 真的写到工作区外", async () => {
    const cwd = await tempDir();
    const outside = await tempDir("bugent-outside-");
    const target = join(outside, "new.txt");

    const p = probe("workspace-write", cwd, { approve: true });
    const result = await p.call("write_file", { path: target, content: "hello" });

    expect(result.ok).toBe(true);
    expect(await Bun.file(target).text()).toBe("hello");
    expect(p.approvals()).toBe(1);
  });

  test("no-sandbox 档下免问 —— 但仍然走同一套授权记录", async () => {
    const cwd = await tempDir();
    const outside = await tempDir("bugent-outside-");
    const target = join(outside, "new.txt");

    const p = probe("no-sandbox", cwd, { approve: true });
    expect((await p.call("write_file", { path: target, content: "hi" })).ok).toBe(true);
    expect(await Bun.file(target).text()).toBe("hi");
    expect(p.approvals()).toBe(0); // 默认批准范围已覆盖，不该问
  });

  test("apply_patch 的越界路径同样走按次授权", async () => {
    const cwd = await tempDir();
    const outside = await tempDir("bugent-outside-");
    const target = join(outside, "patched.txt");
    const patch = `*** Begin Patch\n*** Add File: ${target}\n+hello\n*** End Patch`;

    expect((await probe("workspace-write", cwd).call("apply_patch", { patch })).ok).toBe(false);

    const p = probe("workspace-write", cwd, { approve: true });
    expect((await p.call("apply_patch", { patch })).ok).toBe(true);
    expect(await Bun.file(target).text()).toContain("hello");
  });
});

/* ------------------------------------------------------------------ */
/* read-only：写要"每次"批准，不是"批准一次就永久放行"                   */
/* ------------------------------------------------------------------ */

describe("read-only 档下写工作区需要逐次批准", () => {
  test("批准一次只生效一次，档位不被改掉", async () => {
    const cwd = await tempDir();
    const p = probe("read-only", cwd, { approve: true });

    expect((await p.call("write_file", { path: join(cwd, "a.txt"), content: "1" })).ok).toBe(true);
    expect(await Bun.file(join(cwd, "a.txt")).text()).toBe("1");

    // 第二次仍然要问 —— 这才是"按次"。如果档位被改成 workspace-write，
    // 这里 approvals 会停在 1，read-only 就退化成了"审批一次之后随便写"。
    expect((await p.call("write_file", { path: join(cwd, "b.txt"), content: "2" })).ok).toBe(true);
    expect(p.approvals()).toBe(2);
    expect(p.mode()).toBe("read-only");
  });

  test("拒绝批准时写不落盘", async () => {
    const cwd = await tempDir();
    const result = await probe("read-only", cwd).call("write_file", {
      path: join(cwd, "a.txt"),
      content: "1",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("逐次批准");
    expect(await Bun.file(join(cwd, "a.txt")).exists()).toBe(false);
  });

  test("workspace-write 档下写工作区不打扰用户", async () => {
    const cwd = await tempDir();
    const p = probe("workspace-write", cwd, { approve: true });
    expect((await p.call("write_file", { path: join(cwd, "a.txt"), content: "1" })).ok).toBe(true);
    expect(p.approvals()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 沙箱恒开                                                             */
/* ------------------------------------------------------------------ */

describe("沙箱至始至终开着", () => {
  for (const mode of ["read-only", "workspace-write", "no-sandbox"] as const) {
    test(`${mode} 档都启用 bwrap 隔离`, () => {
      const setup = createDefaultTools({ mode });
      // no-sandbox 的语义是"默认批准一切、不拦截"，不是"关掉隔离"。
      // 曾经它是 `sandboxed: false` → 直接裸 spawn，隔离整层消失。
      expect(setup.sandbox.enabled).toBe(true);
      expect(setup.sandbox.note).toContain("bwrap");
    });
  }

  test("no-sandbox 的说明如实写明沙箱仍在", () => {
    expect(createDefaultTools({ mode: "no-sandbox" }).sandbox.note).toContain("沙箱仍在");
  });
});

/* ------------------------------------------------------------------ */
/* --allow-network 的接线                                               */
/* ------------------------------------------------------------------ */

describe("--allow-network / sandbox.allow_network 接线", () => {
  test("默认断网，命令失败后才按次问联网", () => {
    expect(createDefaultTools({ mode: "workspace-write" }).sandbox.networkBlocked).toBe(true);
  });

  test("allowNetwork 传进来之后不再走按次询问", () => {
    // 这条断言的就是曾经断掉的那根线：CLI 解析了 --allow-network，
    // 但没人把它传给 createDefaultTools，于是开关形同虚设。
    expect(
      createDefaultTools({ mode: "workspace-write", allowNetwork: true }).sandbox.networkBlocked,
    ).toBe(false);
  });

  test("no-sandbox 默认批准一切，含联网", () => {
    expect(createDefaultTools({ mode: "no-sandbox" }).sandbox.networkBlocked).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 逐次判定：writesOutside 只在越界时为真                                */
/* ------------------------------------------------------------------ */

describe("writesOutside 是逐次判定，不是静态声明", () => {
  test("工作区内的写不带 writeOutside", async () => {
    const cwd = await tempDir();
    const setup = createDefaultTools({ mode: "workspace-write", runner: forbiddenRunner });
    const tool = setup.registry.list().find((entry) => entry.name === "write_file")!;
    const ctx: ToolCtx = {
      cwd,
      signal: new AbortController().signal,
      callId: "c",
      sessionId: "s",
    };

    const inside = describeCall(tool, { id: "c", name: "write_file", args: { path: "a.txt" } }, ctx);
    expect(inside.requires?.write).toBe(true);
    expect(inside.requires?.writeOutside).toBeUndefined();

    const outside = describeCall(
      tool,
      { id: "c", name: "write_file", args: { path: "/tmp/somewhere-else.txt" } },
      ctx,
    );
    expect(outside.requires?.writeOutside).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 工具产物落盘后必须读得回来                                            */
/* ------------------------------------------------------------------ */

describe("bash 落盘的完整输出能被 read_file 读回", () => {
  test("按 spill 给的路径读得回来", async () => {
    const cwd = await tempDir();
    const spillDir = sessionOutputDir("spill-session");
    await mkdir(spillDir, { recursive: true });
    const spilled = join(spillDir, "call-1.txt");
    await writeFile(spilled, "FULL OUTPUT\n");
    dirs.push(spillDir);

    // bash 会在结果里写 "[use read_file on that path ...]" 引导模型来读。
    // 读不回来就等于给了模型一个死指针，它会反复重试并浪费轮次。
    const result = await probe("workspace-write", cwd).call("read_file", { path: spilled });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("FULL OUTPUT");
  });
});
