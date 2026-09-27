import { describe, expect, test } from "bun:test";
import { buildShellArgv, createBashTool, createShellRunner, psEncode, resolveShell } from "../src/tools/bash.ts";
import { ToolRegistry, type ToolCtx } from "../src/tools/types.ts";

function ctx(overrides: Partial<ToolCtx> = {}): ToolCtx {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    callId: "call_1",
    sessionId: "test-session",
    ...overrides,
  };
}

const tool = createBashTool(createShellRunner());

describe("P3 · bash 工具", () => {
  test("正常执行并返回 stdout 与 exit code", async () => {
    const out = await tool.run({ command: "echo hello-bugent" }, ctx());
    expect(out).toContain("hello-bugent");
    expect(out).toContain("[exit code: 0]");
  });

  test("非零退出码被如实报告", async () => {
    const out = await tool.run({ command: "exit 3" }, ctx());
    expect(out).toContain("[exit code: 3]");
  });

  test("stderr 与 stdout 分开呈现", async () => {
    const out = await tool.run({ command: "echo to-stdout; echo to-stderr 1>&2" }, ctx());
    expect(out).toContain("to-stdout");
    expect(out).toContain("--- stderr ---");
    expect(out).toContain("to-stderr");
  });

  test("无输出时给出明确提示", async () => {
    const out = await tool.run({ command: "true" }, ctx());
    expect(out).toContain("(no output)");
    expect(out).toContain("[exit code: 0]");
  });

  test("在 ctx.cwd 指定的目录下执行", async () => {
    const out = await tool.run({ command: "pwd" }, ctx({ cwd: "/tmp" }));
    expect(out).toContain("/tmp");
  });

  test("超时会被强制终止并标注", async () => {
    const started = Date.now();
    const out = await tool.run({ command: "sleep 10", timeoutMs: 300 }, ctx());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out).toContain("[timeout]");
  });

  test("abort 信号能中断正在跑的命令", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const started = Date.now();
    const out = await tool.run({ command: "sleep 10" }, ctx({ signal: controller.signal }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out).toContain("[aborted]");
  });

  test("输出过大时截断，且不会把子进程卡死", async () => {
    const small = createBashTool(createShellRunner(), { maxOutputBytes: 100 });
    const out = await small.run({ command: "yes a | head -c 5000" }, ctx());
    expect(out).toContain("was truncated");
    expect(out.length).toBeLessThan(1000);
    expect(out).toContain("[exit code: 0]");
  });

  test("非法输入被拒绝", async () => {
    await expect(tool.run({ command: "" }, ctx())).rejects.toThrow(/non-empty string/);
    await expect(tool.run({ command: 123 }, ctx())).rejects.toThrow(/non-empty string/);
    await expect(tool.run({ command: "echo x", timeoutMs: -1 }, ctx())).rejects.toThrow(/positive number/);
  });

  test("通过 ToolRegistry 执行时，非法输入转成 ok:false 而不是抛穿", async () => {
    const registry = new ToolRegistry().register(tool);
    const result = await registry.execute({ id: "c1", name: "exec", args: {} }, ctx());
    expect(result.ok).toBe(false);
    expect(result.output).toContain("non-empty string");
  });

  test("工具 schema 与 name 正确", () => {
    expect(tool.name).toBe("exec");
    expect(tool.needsSandbox).toBe(true);
    expect(tool.parameters.required).toEqual(["command"]);
  });

  test("runner 返回原生 signalCode 与 resourceUsage", async () => {
    const runner = createShellRunner();
    const result = await runner.run({
      command: "true",
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      signal: new AbortController().signal,
    });

    expect(result.signalCode).toBeNull();
    expect(result.resourceUsage).toBeDefined();
    expect(result.resourceUsage!.maxRSS).toBeGreaterThan(0);
  });

  test("超时由 Bun.spawn 原生 timeout 终止", async () => {
    const runner = createShellRunner();
    const result = await runner.run({
      command: "sleep 1",
      cwd: process.cwd(),
      timeoutMs: 80,
      maxOutputBytes: 1024,
      signal: new AbortController().signal,
    });

    expect(result.timedOut).toBe(true);
    expect(result.signalCode).toBe("SIGKILL");
    expect(result.exitCode).not.toBe(0);
  });

  test("已经 aborted 的 signal 不启动进程", async () => {
    const runner = createShellRunner();
    const controller = new AbortController();
    controller.abort();

    const result = await runner.run({
      command: "sleep 1",
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBe(0);
  });
});

describe("shell 解析（跨平台）", () => {
  const none = (): null => null;
  const sizeOf = (sizes: Record<string, number>) => (path: string) => sizes[path] ?? null;

  test("优先用 PATH 上的 bash", () => {
    const shell = resolveShell("linux", {}, (name) => (name === "bash" ? "/usr/bin/bash" : null));
    expect(shell).toEqual({ command: "/usr/bin/bash", kind: "posix" });
  });

  test("BUGENT_SHELL 覆盖一切", () => {
    const shell = resolveShell(
      "win32",
      { BUGENT_SHELL: "D:\\Git\\bin\\bash.exe" },
      () => "C:\\Windows\\System32\\bash.exe",
    );
    expect(shell.command).toBe("D:\\Git\\bin\\bash.exe");
    expect(shell.kind).toBe("posix");
    expect(shell.note).toContain("BUGENT_SHELL");
  });

  test("BUGENT_SHELL 指向 pwsh 时 argv 走 pwsh 模式", () => {
    const shell = resolveShell("win32", { BUGENT_SHELL: "C:\\PowerShell\\7\\pwsh.exe" }, none);
    expect(shell.kind).toBe("pwsh");
  });

  test("Windows 上跳过 WSL 的 bash 桩，改用真正的 POSIX shell", () => {
    const found: Record<string, string> = {
      bash: "C:\\Windows\\System32\\bash.exe",
      sh: "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
    };
    const shell = resolveShell(
      "win32",
      { SystemRoot: "C:\\Windows" },
      (name) => found[name] ?? null,
      () => null,
    );
    expect(shell.command).toBe("C:\\Program Files\\Git\\usr\\bin\\sh.exe");
    expect(shell.kind).toBe("posix");
  });

  test("Windows 链：pwsh > powershell 5.1 > bash > cmd", () => {
    const env = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files" };
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

    // pwsh 在 PATH 上（真 exe，非 0 字节）
    const first = resolveShell("win32", env, (name) => (name === "pwsh" ? pwsh : null), sizeOf({ [pwsh]: 291_072 }));
    expect(first).toEqual({ command: pwsh, kind: "pwsh" });

    // PATH 上的 pwsh 是 0 字节 MSIX 别名 ⇒ 跳过，落 powershell 5.1
    const ps51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const second = resolveShell(
      "win32",
      env,
      (name) => (name === "pwsh" ? pwsh : null),
      sizeOf({ [pwsh]: 0, [ps51]: 73_802 }),
    );
    expect(second).toEqual({ command: ps51, kind: "pwsh" });

    // 5.1 也没有 ⇒ bash；bash 也没有 ⇒ cmd 兜底
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const third = resolveShell(
      "win32",
      env,
      (name) => (name === "pwsh" ? pwsh : name === "bash" ? bash : null),
      sizeOf({ [pwsh]: 0, [bash]: 1_234 }),
    );
    expect(third).toEqual({ command: bash, kind: "posix" });

    const fourth = resolveShell("win32", env, none, sizeOf({}));
    expect(fourth.command).toBe("cmd");
    expect(fourth.kind).toBe("cmd");
  });

  test("没有 shell 时不抛错，只给出装什么的提示", () => {
    // 抛错会让 bugent 在没有 shell 的机器上直接起不来 —— 而文件工具根本不需要 shell
    const posix = resolveShell("linux", {}, none);
    expect(posix.command).toBe("/bin/sh");
    expect(posix.kind).toBe("posix");
    expect(posix.note).toContain("bash");
  });
});

describe("buildShellArgv（按 shell 家族派生 argv）", () => {
  test("posix 保持 -lc", () => {
    const argv = buildShellArgv({ command: "/bin/bash", kind: "posix" }, "echo hi");
    expect(argv).toEqual(["/bin/bash", "-lc", "echo hi"]);
  });

  test("pwsh 走 -EncodedCommand，命令字节级保真", () => {
    const command = "Write-Output '中文 \"引号\" $x'";
    const argv = buildShellArgv({ command: "pwsh.exe", kind: "pwsh" }, command);
    expect(argv.slice(1, -1)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-InputFormat",
      "Text",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
    ]);
    const encoded = argv.at(-1)!;
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    expect(decoded).toBe(command);
  });

  test("psEncode 编码 UTF-16LE base64", () => {
    expect(Buffer.from(psEncode("hi"), "base64").toString("utf16le")).toBe("hi");
    // 中文（BMP 外不需要，但代理对要按 code unit 拆）
    expect(Buffer.from(psEncode("中文"), "base64").toString("utf16le")).toBe("中文");
  });

  test("cmd 走 /d /s /c", () => {
    const argv = buildShellArgv({ command: "cmd.exe", kind: "cmd" }, "dir");
    expect(argv).toEqual(["cmd.exe", "/d", "/s", "/c", "dir"]);
  });
});

describe("exec 工具（bash 改名）", () => {
  test("工具名是 exec，老权限规则 { tool: \"bash\" } 通过别名继续生效", async () => {
    const { PermissionPolicy } = await import("../src/permission/policy.ts");
    const policy = new PermissionPolicy({
      rules: [{ tool: "bash", resource: "rm -rf /*", decision: "deny" }],
    });
    expect(policy.evaluate({ tool: "exec", resource: "rm -rf /", summary: "" }).decision).toBe("deny");
    expect(policy.evaluate({ tool: "exec", resource: "ls", summary: "" }).decision).toBe("allow");
    expect(policy.evaluate({ tool: "bash", resource: "rm -rf /", summary: "" }).decision).toBe("deny");
  });

  test("per-call shell：BUGENT_SHELL 钉死时明确拒绝", async () => {
    const previous = process.env.BUGENT_SHELL;
    process.env.BUGENT_SHELL = "C:\\Program Files\\Git\\bin\\bash.exe";
    try {
      const { createBashTool, createShellRunner } = await import("../src/tools/bash.ts");
      const tool = createBashTool(createShellRunner({ command: "bash.exe", kind: "posix" }));
      await expect(
        tool.run({ command: "echo hi", shell: "pwsh" }, {
          cwd: process.cwd(),
          signal: new AbortController().signal,
          callId: "c1",
          sessionId: "s",
        } as never),
      ).rejects.toThrow("pinned via BUGENT_SHELL");
    } finally {
      if (previous === undefined) delete process.env.BUGENT_SHELL;
      else process.env.BUGENT_SHELL = previous;
    }
  });

  test("resolveShellByName：已知名字与路径", async () => {
    const { resolveShellByName } = await import("../src/tools/bash.ts");
    const none = (): null => null;
    // 未知名字报错（不静默猜）
    expect(() => resolveShellByName("fish", {}, none, () => null)).toThrow("unknown shell");
    // 路径形式：不存在报错；存在按可执行名认家族
    expect(() => resolveShellByName("C:\\nope\\shell.exe", {}, none, () => null)).toThrow("not found");
    const pwshPath = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    expect(
      resolveShellByName(pwshPath, {}, none, (p) => (p === pwshPath ? 100_000 : null)).kind,
    ).toBe("pwsh");
  });
});
