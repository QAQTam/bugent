import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capabilitiesOf,
  defaultApproves,
  describeCapability,
  describeRequirement,
  escalate,
  isSandboxMode,
  minimumModeFor,
  MODE_ORDER,
  MODES,
  type SandboxMode,
} from "../src/permission/mode.ts";
import { PermissionGate } from "../src/permission/gate.ts";
import { composePolicy, PermissionPolicy, type PermissionRequest } from "../src/permission/policy.ts";
import { ScriptedPrompter } from "../src/permission/prompt.ts";
import { createDefaultTools } from "../src/tools/builtin.ts";
import { looksLikeNetworkFailure } from "../src/tools/bash.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-mode-"));
  dirs.push(dir);
  return dir;
}

const req = (tool: string, resource = "x", requires?: PermissionRequest["requires"]): PermissionRequest => ({
  tool,
  resource,
  summary: `${tool} ${resource}`,
  ...(requires !== undefined ? { requires } : {}),
});

describe("三档模型", () => {
  test("档位定义齐全且顺序递进", () => {
    expect(MODE_ORDER).toEqual(["read-only", "workspace-write", "no-sandbox"]);
    for (const mode of MODE_ORDER) expect(MODES[mode].label.length).toBeGreaterThan(0);
  });

  test("档位只描述默认批准范围，不含网络", () => {
    expect(capabilitiesOf("read-only").defaultApprove).toBe("read");
    expect(capabilitiesOf("workspace-write").defaultApprove).toBe("workspace-write");
    expect(capabilitiesOf("no-sandbox").defaultApprove).toBe("all");

    // 网络不参与档位判断 —— 它是按次授权
    expect(defaultApproves("read-only", {})).toBe(true);
    expect(defaultApproves("read-only", { write: true })).toBe(false);
    expect(defaultApproves("workspace-write", { write: true })).toBe(true);
    expect(defaultApproves("no-sandbox", { write: true })).toBe(true);
  });

  test("读工作区之外在三档都不需要授权", () => {
    // 档位不限制读：读是自由的，没有 requires 就永远走不到"要不要问"这一步
    for (const mode of MODE_ORDER) {
      expect(defaultApproves(mode, {})).toBe(true);
    }
  });

  test("写工作区之外只有 no-sandbox 默认批准", () => {
    expect(defaultApproves("read-only", { writeOutside: true })).toBe(false);
    expect(defaultApproves("workspace-write", { writeOutside: true })).toBe(false);
    expect(defaultApproves("no-sandbox", { writeOutside: true })).toBe(true);
    expect(minimumModeFor({ writeOutside: true })).toBe("no-sandbox");
  });

  test("isSandboxMode 拒绝非法值", () => {
    expect(isSandboxMode("read-only")).toBe(true);
    expect(isSandboxMode("yolo")).toBe(false);
    expect(isSandboxMode(123)).toBe(false);
  });

  test("minimumModeFor / escalate / describe", () => {
    expect(minimumModeFor({ write: true })).toBe("workspace-write");
    expect(minimumModeFor({})).toBe("read-only");
    expect(escalate("read-only")).toBe("workspace-write");
    expect(escalate("no-sandbox")).toBe("no-sandbox");
    expect(describeRequirement({ write: true })).toContain("写入工作区");
    expect(describeCapability({ network: true })).toContain("网络");
  });
});

describe("档位即授权", () => {
  test("没有规则时默认放行 —— 边界由档位负责", async () => {
    const gate = new PermissionGate({
      policy: new PermissionPolicy(composePolicy(undefined, [])),
      mode: "workspace-write",
    });
    expect(await gate.check(req("bash", "ls"))).toEqual({ allowed: true });
  });

  test("read-only 档下进程内写工具被拒，并说明怎么改", async () => {
    const gate = new PermissionGate({
      policy: new PermissionPolicy({}),
      mode: "read-only",
    });
    const verdict = await gate.check(req("write_file", "a.ts", { write: true }));

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("写入工作区");
    expect(verdict.reason).toContain("workspace-write");
  });

  test("workspace-write 档下写工具直接放行，不打扰用户", async () => {
    const prompter = new ScriptedPrompter([]);
    const gate = new PermissionGate({
      policy: new PermissionPolicy({}),
      mode: "workspace-write",
      prompter,
    });

    expect(await gate.check(req("write_file", "a.ts", { write: true }))).toEqual({ allowed: true });
    expect(prompter.seen).toHaveLength(0);
  });

  test("显式 deny 规则优先于档位放行", async () => {
    const gate = new PermissionGate({
      policy: new PermissionPolicy({
        rules: [{ tool: "bash", resource: "rm *", decision: "deny" }],
      }),
      mode: "no-sandbox",
    });

    const verdict = await gate.check(req("bash", "rm -rf /"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("策略禁止");
  });

  test("批准一次只生效一次 —— 档位不会被改掉", async () => {
    let asked: SandboxMode | undefined;
    let approvals = 0;
    const gate = new PermissionGate({
      policy: new PermissionPolicy({}),
      mode: "read-only",
      onEscalate: async (_request, needed) => {
        asked = needed;
        approvals += 1;
        return "approved" as const;
      },
    });

    expect(await gate.check(req("write_file", "a.ts", { write: true }))).toEqual({
      allowed: true,
      grant: {},
    });
    expect(asked).toBe("workspace-write");
    // 关键：档位没变。变了就意味着"每次写入都要审批"退化成"审批一次之后随便写"
    expect(gate.mode).toBe("read-only");

    // 第二次调用仍然要问 —— 这才是"按次"
    expect(await gate.check(req("write_file", "b.ts", { write: true }))).toEqual({
      allowed: true,
      grant: {},
    });
    expect(approvals).toBe(2);
    expect(gate.mode).toBe("read-only");
  });

  test("获准写工作区外时，授权随本次调用下发", async () => {
    const gate = new PermissionGate({
      policy: new PermissionPolicy({}),
      mode: "workspace-write",
      onEscalate: async () => "approved" as const,
    });

    const verdict = await gate.check(req("write_file", "/etc/hosts", { write: true, writeOutside: true }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.grant).toEqual({ writeOutside: true });
    // 档位仍然没变
    expect(gate.mode).toBe("workspace-write");
  });

  test("逐次批准被拒时给出可操作的提示", async () => {
    const gate = new PermissionGate({
      policy: new PermissionPolicy({}),
      mode: "read-only",
      onEscalate: async () => "denied" as const,
    });

    const verdict = await gate.check(req("write_file", "a.ts", { write: true }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("逐次批准");
    expect(verdict.reason).toContain("--mode workspace-write");
  });
});

describe("档位对工具的实际约束", () => {
  test("read-only 档下 bash 自动放行（内核兜底，不必问）", async () => {
    const setup = createDefaultTools({ mode: "read-only" });
    const prompter = new ScriptedPrompter([]);
    setup.registry.setGate(
      new PermissionGate({ policy: new PermissionPolicy({}), mode: "read-only", prompter }),
    );

    const result = await setup.registry.execute(
      { id: "c1", name: "exec", args: { command: "echo hello" } },
      { cwd: process.cwd(), signal: new AbortController().signal, callId: "c1", sessionId: "s" },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("hello");
    expect(prompter.seen).toHaveLength(0); // 关键：没弹窗
  });

  test("read-only 档下内核挡住一切写文件手法（重定向 / sed / python）", async () => {
    const cwd = await workspace();
    const target = join(cwd, "target.txt");
    const setup = createDefaultTools({ mode: "read-only" });
    const ctx = { cwd, signal: new AbortController().signal, callId: "c1", sessionId: "s" };

    const attempts = [
      "echo hacked > target.txt",
      "sed -i 's/原始/hacked/' target.txt",
      "python3 -c \"open('target.txt','w').write('hacked')\"",
      "echo x | tee target.txt",
    ];

    for (const command of attempts) {
      await Bun.write(target, "原始内容\n");
      await setup.registry.execute({ id: "c1", name: "exec", args: { command } }, ctx);
      // 关键断言：文件内容一个字节都没变 —— 我们没解析命令，是内核挡的
      expect(await readFile(target, "utf8")).toBe("原始内容\n");
    }
  });

  test("workspace-write 档下同样的写法能成功", async () => {
    const cwd = await workspace();
    const target = join(cwd, "target.txt");
    const setup = createDefaultTools({ mode: "workspace-write" });
    const ctx = { cwd, signal: new AbortController().signal, callId: "c1", sessionId: "s" };

    await Bun.write(target, "原始内容\n");
    await setup.registry.execute(
      { id: "c1", name: "exec", args: { command: "sed -i 's/原始/改过/' target.txt" } },
      ctx,
    );

    expect(await readFile(target, "utf8")).toBe("改过内容\n");
  });
});

describe("联网授权的触发判定", () => {
  test("识别常见网络失败文案", () => {
    expect(looksLikeNetworkFailure("curl: (7) Could not connect to server")).toBe(true);
    expect(looksLikeNetworkFailure("bash: connect: Network is unreachable")).toBe(true);
    expect(looksLikeNetworkFailure("getaddrinfo ENOTFOUND registry.npmjs.org")).toBe(true);
    expect(looksLikeNetworkFailure("Could not resolve host: github.com")).toBe(true);
  });

  test("普通报错不误判", () => {
    expect(looksLikeNetworkFailure("syntax error near unexpected token")).toBe(false);
    expect(looksLikeNetworkFailure("No such file or directory")).toBe(false);
    expect(looksLikeNetworkFailure("")).toBe(false);
  });

  test("静态没识别的联网命令：跑失败后，授权请求带上真实命令与报错", async () => {
    const cwd = await workspace();
    const setup = createDefaultTools({ mode: "workspace-write" });

    let captured: { reason: string; details?: readonly string[] } | undefined;
    const ctx = {
      cwd,
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "net",
      onRequestCapability: async (escalation: { reason: string; details?: readonly string[] }) => {
        captured = escalation;
        return "denied" as const; // 拒绝，避免真的去连外网
      },
    };

    // 刻意选一条**静态扫不出来**的联网命令：扫描只认识 curl/git/pip 这类命令名，
    // 解释器里的 socket 调用它看不见 —— 这条路径必须靠"跑失败再问"兜住。
    const command = `python3 -c "import socket; socket.create_connection(('127.0.0.1',9))"`;
    const result = await setup.registry.execute({ id: "c1", name: "exec", args: { command } }, ctx);

    expect(captured).toBeDefined();
    expect(captured?.reason).toContain("断网");
    // 用户必须能看到是哪条命令、因为什么失败
    expect(captured?.details?.join("\n")).toContain(command);
    expect(captured?.details?.join("\n")).toContain("报错");
    // 没批准就不能把那次失败当成结果回给模型
    expect(result.output).toContain("用户拒绝操作");
    expect(result.output).toContain("未执行");
  });

  test("静态识别出的联网命令：执行前就问，命令根本不跑", async () => {
    const cwd = await workspace();
    const setup = createDefaultTools({ mode: "workspace-write" });

    let captured: { capability: { network?: boolean }; reason: string } | undefined;
    const ctx = {
      cwd,
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "net2",
      onRequestCapability: async (escalation: { capability: { network?: boolean }; reason: string }) => {
        captured = escalation;
        return "denied" as const;
      },
    };

    // 用一个会在工作区留下痕迹的命令：如果它真的跑了，文件就会出现。
    const command = `curl -sS -o ${join(cwd, "leak.txt")} http://127.0.0.1:9/nope`;
    const result = await setup.registry.execute({ id: "c1", name: "exec", args: { command } }, ctx);

    expect(captured?.capability.network).toBe(true);
    expect(captured?.reason).toContain("联网");
    // 被拒 = 命令没执行，回传的是明确结论而不是沙箱报错
    expect(result.output).toContain("用户拒绝操作");
    expect(result.output).toContain("未执行");
    expect(await Bun.file(join(cwd, "leak.txt")).exists()).toBe(false);
  });
});
