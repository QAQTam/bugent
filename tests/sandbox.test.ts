import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSandboxArgv,
  createSandboxedShellRunner,
  isSandboxAvailable,
  SANDBOX_BINARY,
} from "../src/sandbox/bwrap.ts";
import type { ShellRunOptions } from "../src/tools/bash.ts";

const sandboxAvailable = isSandboxAvailable();
const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function makeWorkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-sandbox-"));
  dirs.push(dir);
  return dir;
}

function runOptions(cwd: string, command: string): ShellRunOptions {
  return {
    command,
    cwd,
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    signal: new AbortController().signal,
  };
}

describe("P6 · bwrap argv 构造", () => {
  const options = runOptions("/work", "echo hi");

  test("默认：只读根 + 私有 /tmp + 断网 + PID 隔离", () => {
    const argv = buildSandboxArgv(options, {}, { command: "/bin/bash", kind: "posix" });

    expect(argv[0]).toBe(SANDBOX_BINARY);
    expect(argv).toContain("--ro-bind");
    expect(argv).toContain("--tmpfs");
    expect(argv).toContain("--unshare-net");
    expect(argv).toContain("--unshare-pid");
    expect(argv).toContain("--die-with-parent");
    expect(argv).toContain("--chdir");
  });

  test("工作目录始终被挂成可写", () => {
    const argv = buildSandboxArgv(options, {}, { command: "/bin/bash", kind: "posix" });
    const bindIndex = argv.indexOf("--bind");
    expect(bindIndex).toBeGreaterThan(-1);
    expect(argv.slice(bindIndex, bindIndex + 3)).toEqual(["--bind", "/work", "/work"]);
  });

  test("allowNetwork 时不加 --unshare-net", () => {
    const argv = buildSandboxArgv(options, { allowNetwork: true }, { command: "/bin/bash", kind: "posix" });
    expect(argv).not.toContain("--unshare-net");
  });

  test("额外可写路径排在基础策略之后（后挂载的才能覆盖先挂载的）", () => {
    const argv = buildSandboxArgv(options, { writablePaths: ["/a", "/b"] }, { command: "/bin/bash", kind: "posix" });
    const workspaceBind = argv.findIndex(
      (value, at) => value === "--bind" && argv[at + 1] === "/work",
    );
    expect(workspaceBind).toBeGreaterThan(-1);
    // /a /b 必须挂在工作区那条基础策略**之后**，否则会被它盖掉
    expect(argv.indexOf("/a")).toBeGreaterThan(workspaceBind);
    expect(argv.indexOf("/b")).toBeGreaterThan(workspaceBind);
  });

  test("read-only 档：工作区被绑成只读，但仍存在（/tmp 被 tmpfs 遮掉时不至于 chdir 失败）", () => {
    const argv = buildSandboxArgv(options, { workspaceWrite: false }, { command: "/bin/bash", kind: "posix" });
    const index = argv.findIndex(
      (value, at) => value === "--ro-bind" && argv[at + 1] === "/work",
    );
    expect(index).toBeGreaterThan(-1);
    expect(argv[index + 2]).toBe("/work");
  });

  test("命令被放在 -- 之后，作为 shell -lc 的参数", () => {
    const argv = buildSandboxArgv(options, {}, { command: "/bin/bash", kind: "posix" });
    const separator = argv.indexOf("--");
    expect(argv.slice(separator + 1)).toEqual(["/bin/bash", "-lc", "echo hi"]);
  });
});

describe("P6 · 真实沙箱行为", () => {
  const runner = createSandboxedShellRunner();

  test.skipIf(!sandboxAvailable)("工作目录内可写", async () => {
    const cwd = await makeWorkdir();
    const result = await runner.run(runOptions(cwd, "echo hello > out.txt && cat out.txt"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(await readdir(cwd)).toContain("out.txt");
  });

  test.skipIf(!sandboxAvailable)("工作目录之外不可写（只读根）", async () => {
    const cwd = await makeWorkdir();
    const result = await runner.run(runOptions(cwd, "touch /bugent-should-not-exist"));

    expect(result.exitCode).not.toBe(0);
    // 断言"没写成功"本身，而不是报错文案 —— 后者随 locale 变化
    // （英文 "read-only file system" / 中文 "只读文件系统"）。
    expect(() => statSync("/bugent-should-not-exist")).toThrow();
  });

  test.skipIf(!sandboxAvailable)("默认断网", async () => {
    const cwd = await makeWorkdir();
    const result = await runner.run(
      runOptions(cwd, "timeout 3 bash -c 'echo > /dev/tcp/1.1.1.1/80' 2>&1 || echo NETWORK-BLOCKED"),
    );

    expect(result.stdout).toContain("NETWORK-BLOCKED");
  });

  test.skipIf(!sandboxAvailable)("允许联网时不会加 --unshare-net", () => {
    const argv = buildSandboxArgv(runOptions("/work", "echo"), { allowNetwork: true }, { command: "/bin/bash", kind: "posix" });
    expect(argv).not.toContain("--unshare-net");
  });
});

describe("P6 · 沙箱降级", () => {
  test("bwrap 可用性检测返回布尔值", () => {
    expect(typeof isSandboxAvailable()).toBe("boolean");
  });

  test("指定不存在的 binary 时检测为不可用", () => {
    expect(isSandboxAvailable("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});
