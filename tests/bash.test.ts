import { describe, expect, test } from "bun:test";
import { createBashTool, createShellRunner } from "../src/tools/bash.ts";
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
    expect(out).toContain("(无输出)");
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
    expect(out).toContain("[超时]");
  });

  test("abort 信号能中断正在跑的命令", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const started = Date.now();
    const out = await tool.run({ command: "sleep 10" }, ctx({ signal: controller.signal }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out).toContain("[中断]");
  });

  test("输出过大时截断，且不会把子进程卡死", async () => {
    const small = createBashTool(createShellRunner(), { maxOutputBytes: 100 });
    const out = await small.run({ command: "yes a | head -c 5000" }, ctx());
    expect(out).toContain("已截断");
    expect(out.length).toBeLessThan(1000);
    expect(out).toContain("[exit code: 0]");
  });

  test("非法输入被拒绝", async () => {
    await expect(tool.run({ command: "" }, ctx())).rejects.toThrow(/非空字符串/);
    await expect(tool.run({ command: 123 }, ctx())).rejects.toThrow(/非空字符串/);
    await expect(tool.run({ command: "echo x", timeoutMs: -1 }, ctx())).rejects.toThrow(/正数/);
  });

  test("通过 ToolRegistry 执行时，非法输入转成 ok:false 而不是抛穿", async () => {
    const registry = new ToolRegistry().register(tool);
    const result = await registry.execute({ id: "c1", name: "bash", args: {} }, ctx());
    expect(result.ok).toBe(false);
    expect(result.output).toContain("非空字符串");
  });

  test("工具 schema 与 name 正确", () => {
    expect(tool.name).toBe("bash");
    expect(tool.needsSandbox).toBe(true);
    expect(tool.parameters.required).toEqual(["command"]);
  });
});
