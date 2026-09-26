import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDefaultTools } from "../src/tools/builtin.ts";
import type { ShellResult, ShellRunOptions, ShellRunner } from "../src/tools/bash.ts";
import { buildSandboxArgv } from "../src/sandbox/bwrap.ts";
import type { CapabilityEscalation, ToolCtx } from "../src/tools/types.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  await rm(OUTSIDE_ROOT, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-bash-auth-"));
  dirs.push(dir);
  return dir;
}

/**
 * "工作区之外"的落点。
 *
 * 不能放在 `/tmp` 下：沙箱里 `/tmp` 是私有 tmpfs，扫描据此认定写它不算越界
 * （见 src/sandbox/command-scan.ts）。工作区本身在 `/tmp` 下没关系 —— 那是
 * "档位"要管的，不是"越界"。
 */
const OUTSIDE_ROOT = join(process.cwd(), ".tmp-home", "bash-auth-outside");
const outside = (name: string): string => join(OUTSIDE_ROOT, name);

/** 记录每次运行收到的 ShellRunOptions —— 用来断言"批准后到底放开了什么"。 */
function recordingRunner(): { runner: ShellRunner; runs: ShellRunOptions[] } {
  const runs: ShellRunOptions[] = [];
  return {
    runs,
    runner: {
      async run(options: ShellRunOptions): Promise<ShellResult> {
        runs.push(options);
        return {
          stdout: "ran",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 1,
        };
      },
    },
  };
}

interface Answer {
  outcome: "approved" | "denied" | "timeout";
}

function ctxWith(cwd: string, answers: Answer[], seen: CapabilityEscalation[] = []): ToolCtx {
  return {
    cwd,
    signal: new AbortController().signal,
    callId: "c1",
    sessionId: "bash-auth",
    onRequestCapability: async (escalation) => {
      seen.push(escalation);
      return answers.shift()?.outcome ?? "denied";
    },
  };
}

describe("bash 执行前授权 · 判定出越界就不跑", () => {
  test("workspace-write 档：写工作区外被拒 -> 命令根本没执行", async () => {
    const cwd = await workspace();
    const target = outside("should-not-exist.txt");
    const setup = createDefaultTools({ mode: "workspace-write" });
    const seen: CapabilityEscalation[] = [];

    const command = `echo hi > ${target}`;
    const result = await setup.registry.execute(
      { id: "c1", name: "bash", args: { command } },
      ctxWith(cwd, [{ outcome: "denied" }], seen),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.capability.writeOutside).toBe(true);
    expect(seen[0]?.details?.join("\n")).toContain(target);
    // 回传的是明确结论，不是一句看不懂的沙箱报错
    expect(result.output).toContain("用户拒绝操作");
    expect(result.output).toContain("未执行");
    expect(result.output).not.toContain("Read-only file system");
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test("超时与拒绝在回传里可区分", async () => {
    const cwd = await workspace();
    const setup = createDefaultTools({ mode: "workspace-write" });
    const command = `echo hi > ${outside("timeout.txt")}`;

    const result = await setup.registry.execute(
      { id: "c1", name: "bash", args: { command } },
      ctxWith(cwd, [{ outcome: "timeout" }]),
    );

    expect(result.output).toContain("授权已超时");
    expect(result.output).not.toContain("用户拒绝操作");
  });

  test("工作区内的普通命令不打扰用户", async () => {
    const cwd = await workspace();
    const setup = createDefaultTools({ mode: "workspace-write" });
    const seen: CapabilityEscalation[] = [];

    await setup.registry.execute(
      { id: "c1", name: "bash", args: { command: "echo hi > inside.txt" } },
      ctxWith(cwd, [], seen),
    );

    expect(seen).toHaveLength(0);
  });

  test("no-sandbox 档：档位就是预先授权，写工作区外也不问", async () => {
    const cwd = await workspace();
    const { runner, runs } = recordingRunner();
    const setup = createDefaultTools({ mode: "no-sandbox", runner });
    const seen: CapabilityEscalation[] = [];

    const result = await setup.registry.execute(
      { id: "c1", name: "bash", args: { command: `echo hi > ${outside("no-sandbox.txt")}` } },
      ctxWith(cwd, [], seen),
    );

    expect(seen).toHaveLength(0);
    expect(result.output).toContain("ran");
    // 没有按次授权，就不该往 argv 里塞 --bind
    expect(runs[0]?.writablePaths).toBeUndefined();
  });
});

describe("bash 执行前授权 · 批准后按次放开", () => {
  test("批准写工作区外 -> 本次 argv 带上那个目录的 --bind", async () => {
    const cwd = await workspace();
    const target = outside("approved/x.txt");
    await mkdir(dirname(target), { recursive: true });
    const { runner, runs } = recordingRunner();
    const setup = createDefaultTools({ mode: "workspace-write", runner });
    const seen: CapabilityEscalation[] = [];

    const result = await setup.registry.execute(
      { id: "c1", name: "bash", args: { command: `echo hi > ${target}` } },
      ctxWith(cwd, [{ outcome: "approved" }], seen),
    );

    expect(seen).toHaveLength(1);
    expect(result.output).toContain("ran");
    expect(runs).toHaveLength(1);
    // 目标还不存在 -> 上提到最近的已存在祖先（这里就是它的父目录）
    expect(runs[0]?.writablePaths).toEqual([dirname(target)]);
  });

  test("read-only 档：写工作区内的批准后放开工作区本身", async () => {
    const cwd = await workspace();
    const { runner, runs } = recordingRunner();
    const setup = createDefaultTools({ mode: "read-only", runner });
    const seen: CapabilityEscalation[] = [];

    await setup.registry.execute(
      { id: "c1", name: "bash", args: { command: "echo hi > inside.txt" } },
      ctxWith(cwd, [{ outcome: "approved" }], seen),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.capability.writeOutside).toBe(true);
    expect(runs[0]?.writablePaths).toEqual([cwd]);
  });

  test("read-only 档：写工作区内被拒 -> 不跑", async () => {
    const cwd = await workspace();
    const { runner, runs } = recordingRunner();
    const setup = createDefaultTools({ mode: "read-only", runner });

    const result = await setup.registry.execute(
      { id: "c1", name: "bash", args: { command: "echo hi > inside.txt" } },
      ctxWith(cwd, [{ outcome: "denied" }]),
    );

    expect(runs).toHaveLength(0);
    expect(result.output).toContain("用户拒绝操作");
  });

  test("判不出目标且没提到 home -> 批准也不放开任何目录", async () => {
    const cwd = await workspace();
    const { runner, runs } = recordingRunner();
    const setup = createDefaultTools({ mode: "workspace-write", runner });
    const seen: CapabilityEscalation[] = [];

    // 解释器写文件，目标是变量拼的 —— 静态判不出来
    await setup.registry.execute(
      {
        id: "c1",
        name: "bash",
        args: { command: `python3 -c "import os; open(os.environ['T'] + '/x','w')"` },
      },
      ctxWith(cwd, [{ outcome: "approved" }], seen),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toContain("判不出来");
    expect(seen[0]?.details?.join("\n")).toContain("仍会被沙箱挡住");
    // 判不出目标就"哪里都放开"是把授权变成猜谜 —— 这里必须什么都不放开
    expect(runs[0]?.writablePaths).toBeUndefined();
  });
});

describe("bash 执行前授权 · 真沙箱下批准就真的能写", () => {
  test("read-only 档 + 批准 -> 工作区内写入真的落盘", async () => {
    const cwd = await workspace();
    const target = join(cwd, "inside.txt");
    await Bun.write(target, "原始内容\n");
    const setup = createDefaultTools({ mode: "read-only" });

    const result = await setup.registry.execute(
      { id: "c1", name: "bash", args: { command: "echo 改过 > inside.txt" } },
      ctxWith(cwd, [{ outcome: "approved" }]),
    );

    expect(result.output).toContain("exit code: 0");
    expect(await readFile(target, "utf8")).toBe("改过\n");
  });

  test("read-only 档 + 拒绝 -> 文件一个字节没变", async () => {
    const cwd = await workspace();
    const target = join(cwd, "inside.txt");
    await Bun.write(target, "原始内容\n");
    const setup = createDefaultTools({ mode: "read-only" });

    await setup.registry.execute(
      { id: "c1", name: "bash", args: { command: "echo 改过 > inside.txt" } },
      ctxWith(cwd, [{ outcome: "denied" }]),
    );

    expect(await readFile(target, "utf8")).toBe("原始内容\n");
  });

  test("workspace-write 档 + 批准写工作区外 -> 文件真的落盘", async () => {
    const cwd = await workspace();
    const target = outside("really-written.txt");
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { force: true });
    const setup = createDefaultTools({ mode: "workspace-write" });

    const result = await setup.registry.execute(
      { id: "c1", name: "bash", args: { command: `echo hi > ${target}` } },
      ctxWith(cwd, [{ outcome: "approved" }]),
    );

    // 批准之后内核那层也真的放开了 —— 不只是断言返回值形状
    expect(result.output).toContain("exit code: 0");
    expect(await readFile(target, "utf8")).toBe("hi\n");
  });

  test("read-only 档 + 批准写工作区外 -> 文件真的落盘", async () => {
    const cwd = await workspace();
    const target = outside("read-only-outside.txt");
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { force: true });
    const setup = createDefaultTools({ mode: "read-only" });

    const result = await setup.registry.execute(
      { id: "c1", name: "bash", args: { command: `echo hi > ${target}` } },
      ctxWith(cwd, [{ outcome: "approved" }]),
    );

    expect(result.output).toContain("exit code: 0");
    expect(await readFile(target, "utf8")).toBe("hi\n");
  });

  test("workspace-write 档 + 未批准 -> 内核仍然挡着（漏判兜底不退化）", async () => {
    const cwd = await workspace();
    const target = outside("never-written.txt");
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { force: true });
    // 不给 onRequestCapability：模拟"静态没识别出来"的那条路 —— 命令照跑，
    // 由内核兜底。安全上不能有任何退步。
    const setup = createDefaultTools({ mode: "workspace-write" });
    const ctx = { cwd, signal: new AbortController().signal, callId: "c1", sessionId: "s" };

    const result = await setup.registry.execute(
      { id: "c1", name: "bash", args: { command: `echo hi > ${target}` } },
      ctx,
    );

    expect(result.output).toContain("exit code: 1");
    expect(result.output).not.toContain("exit code: 0");
    expect(await Bun.file(target).exists()).toBe(false);
  });

  test("联网授权是真的放开：批准后能连上本地服务，拒绝则连不上", async () => {
    // 起一个真的服务，而不是断言 argv 里少了个 --unshare-net ——
    // "批准之后网络真的通了吗"只有真连一次才算验证过。
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("pong"),
    });
    try {
      const cwd = await workspace();
      const url = `http://127.0.0.1:${server.port}/`;
      const setup = createDefaultTools({ mode: "workspace-write" });

      const approved = await setup.registry.execute(
        { id: "c1", name: "bash", args: { command: `curl -sS -m 5 ${url}` } },
        ctxWith(cwd, [{ outcome: "approved" }]),
      );
      expect(approved.output).toContain("pong");

      const denied = await setup.registry.execute(
        { id: "c1", name: "bash", args: { command: `curl -sS -m 5 ${url}` } },
        ctxWith(cwd, [{ outcome: "denied" }]),
      );
      expect(denied.output).not.toContain("pong");
      // 拒绝 = 命令根本不跑，不是"跑了但连不上"
      expect(denied.output).toContain("未执行");
    } finally {
      server.stop(true);
    }
  });
});

describe("批准后的 argv 长什么样", () => {
  const options = {
    command: "echo hi",
    cwd: "/work/repo",
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    signal: new AbortController().signal,
  };

  test("本次额外可写路径 -> 逐个 --bind", () => {
    const argv = buildSandboxArgv(
      { ...options, writablePaths: ["/home/me", "/var/log"] },
      { workspaceWrite: false },
      "bash",
    );
    expect(argv.join(" ")).toContain("--bind /home/me /home/me");
    expect(argv.join(" ")).toContain("--bind /var/log /var/log");
  });

  test("没有授权时不加任何 --bind", () => {
    const argv = buildSandboxArgv(options, { workspaceWrite: false }, "bash");
    expect(argv.join(" ")).not.toContain("--bind");
  });

  test("本次可写路径排在工作区判定之后，能盖掉 read-only", () => {
    const argv = buildSandboxArgv(
      { ...options, writablePaths: ["/work/repo"] },
      { workspaceWrite: false },
      "bash",
    );
    const indexes = argv.reduce<number[]>((acc, value, index) => {
      if (value === "--bind" && argv[index + 1] === "/work/repo") acc.push(index);
      return acc;
    }, []);
    expect(indexes).toHaveLength(1);
  });
});
