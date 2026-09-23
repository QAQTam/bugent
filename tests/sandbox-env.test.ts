import { describe, expect, test } from "bun:test";
import { sanitizeEnv } from "../src/sandbox/env.ts";
import { createSandboxedShellRunner } from "../src/sandbox/bwrap.ts";
import { createShellRunner } from "../src/tools/bash.ts";
import { isSandboxAvailable } from "../src/sandbox/bwrap.ts";

const sandboxAvailable = isSandboxAvailable();

describe("沙箱环境变量过滤（白名单）", () => {
  test("只保留白名单里的变量", () => {
    const { env } = sanitizeEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      TERM: "xterm-256color",
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
      TZ: "Asia/Shanghai",
    });

    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "TERM", "TZ"]);
  });

  test("剔除各种形态的凭据", () => {
    const { env, stripped } = sanitizeEnv({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-x",
      ANTHROPIC_API_KEY: "sk-y",
      AWS_SECRET_ACCESS_KEY: "aws",
      AWS_SESSION_TOKEN: "tok",
      GITHUB_TOKEN: "ghp",
      NPM_TOKEN: "npm",
      DATABASE_URL: "postgres://u:p@h/db",
      MY_SERVICE_PWD: "hunter2",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });

    // 一个都不该漏
    expect(Object.keys(env)).toEqual(["PATH"]);
    expect(stripped).toContain("OPENAI_API_KEY");
    expect(stripped).toContain("AWS_SECRET_ACCESS_KEY");
    expect(stripped).toContain("GITHUB_TOKEN");
    expect(stripped).toContain("SSH_AUTH_SOCK");
  });

  test("allow 列表可以显式放行", () => {
    const { env } = sanitizeEnv(
      { PATH: "/usr/bin", NPM_TOKEN: "npm", OTHER_SECRET: "x" },
      { allow: ["NPM_TOKEN"] },
    );

    expect(env.NPM_TOKEN).toBe("npm");
    expect(env.OTHER_SECRET).toBeUndefined();
  });

  test("extra 覆盖同名的白名单变量", () => {
    const { env } = sanitizeEnv({ PATH: "/usr/bin" }, { extra: { PATH: "/custom/bin", FOO: "bar" } });
    expect(env.PATH).toBe("/custom/bin");
    expect(env.FOO).toBe("bar");
  });

  test("undefined 的值被跳过", () => {
    const { env } = sanitizeEnv({ PATH: "/usr/bin", HOME: undefined });
    expect(env.HOME).toBeUndefined();
  });
});

describe("沙箱环境变量过滤（真实子进程）", () => {
  const runOptions = (command: string) => ({
    command,
    cwd: "/tmp",
    timeoutMs: 10_000,
    maxOutputBytes: 4096,
    signal: new AbortController().signal,
  });

  test("无沙箱 runner 也过滤 —— 安全默认", async () => {
    const previous = process.env.BUGENT_LEAK_PROBE;
    process.env.BUGENT_LEAK_PROBE = "should-not-leak";

    try {
      const runner = createShellRunner();
      const result = await runner.run(runOptions('echo "[$BUGENT_LEAK_PROBE]"'));

      expect(result.stdout.trim()).toBe("[]");
    } finally {
      if (previous === undefined) delete process.env.BUGENT_LEAK_PROBE;
      else process.env.BUGENT_LEAK_PROBE = previous;
    }
  });

  test("PATH 仍然可用（否则什么都跑不起来）", async () => {
    const runner = createShellRunner();
    const result = await runner.run(runOptions('echo "[${PATH:+ok}]"'));
    expect(result.stdout.trim()).toBe("[ok]");
  });

  test.skipIf(!sandboxAvailable)("沙箱内读不到 API key，但 PATH 正常", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-real-secret";

    try {
      const runner = createSandboxedShellRunner();
      const result = await runner.run(
        runOptions('echo "key=[$OPENAI_API_KEY]"; echo "path=[${PATH:+ok}]"'),
      );

      expect(result.stdout).toContain("key=[]");
      expect(result.stdout).toContain("path=[ok]");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  test.skipIf(!sandboxAvailable)("passEnv 可以显式放行指定变量", async () => {
    const previous = process.env.BUGENT_PASS_PROBE;
    process.env.BUGENT_PASS_PROBE = "visible-now";

    try {
      const runner = createSandboxedShellRunner({}, undefined, { passEnv: ["BUGENT_PASS_PROBE"] });
      const result = await runner.run(runOptions('echo "[$BUGENT_PASS_PROBE]"'));

      expect(result.stdout.trim()).toBe("[visible-now]");
    } finally {
      if (previous === undefined) delete process.env.BUGENT_PASS_PROBE;
      else process.env.BUGENT_PASS_PROBE = previous;
    }
  });
});
