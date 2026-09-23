import { describe, expect, test } from "bun:test";
import {
  globToRegExp,
  PermissionPolicy,
  type PermissionRequest,
} from "../src/permission/policy.ts";
import { PermissionGate } from "../src/permission/gate.ts";
import { ScriptedPrompter } from "../src/permission/prompt.ts";
import { ToolRegistry, type Tool } from "../src/tools/types.ts";
import type { ToolCall } from "../src/provider/types.ts";

const req = (tool: string, resource: string): PermissionRequest => ({
  tool,
  resource,
  summary: `${tool}: ${resource}`,
});

describe("P6 · glob 匹配", () => {
  test("星号匹配任意字符（含斜杠）", () => {
    expect(globToRegExp("ls*").test("ls -la")).toBe(true);
    expect(globToRegExp("git *").test("git add /etc/passwd")).toBe(true);
    expect(globToRegExp("*").test("任何东西")).toBe(true);
  });

  test("普通字符按字面量处理（正则元字符不生效）", () => {
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("a+b").test("a+b")).toBe(true);
    expect(globToRegExp("a+b").test("aab")).toBe(false);
  });

  test("问号匹配单个字符", () => {
    expect(globToRegExp("ls?").test("lsa")).toBe(true);
    expect(globToRegExp("ls?").test("lsab")).toBe(false);
  });

  test("是整串匹配而不是子串匹配", () => {
    expect(globToRegExp("ls").test("ls -la")).toBe(false);
  });
});

describe("P6 · 权限策略", () => {
  test("默认决策在没有规则命中时生效", () => {
    const policy = new PermissionPolicy({ default: "ask" });
    expect(policy.evaluate(req("bash", "rm -rf /"))).toBe("ask");
  });

  test("规则按顺序匹配，第一条命中即生效", () => {
    const policy = new PermissionPolicy({
      default: "deny",
      rules: [
        { tool: "bash", resource: "rm *", decision: "deny" },
        { tool: "bash", resource: "*", decision: "allow" },
      ],
    });
    expect(policy.evaluate(req("bash", "rm -rf /"))).toBe("deny");
    expect(policy.evaluate(req("bash", "ls"))).toBe("allow");
    expect(policy.evaluate(req("read_file", "x"))).toBe("deny");
  });

  test("省略 resource 时匹配该工具的所有调用", () => {
    const policy = new PermissionPolicy({
      default: "ask",
      rules: [{ tool: "read_file", decision: "allow" }],
    });
    expect(policy.evaluate(req("read_file", "/any/path"))).toBe("allow");
    expect(policy.evaluate(req("write_file", "/any/path"))).toBe("ask");
  });

  test("tool 支持通配", () => {
    const policy = new PermissionPolicy({
      default: "deny",
      rules: [{ tool: "*", decision: "allow" }],
    });
    expect(policy.evaluate(req("anything", "x"))).toBe("allow");
  });
});

describe("P6 · 权限闸门", () => {
  test("allow 直接放行，不打扰用户", async () => {
    const prompter = new ScriptedPrompter([]);
    const gate = new PermissionGate(new PermissionPolicy({ default: "allow" }), prompter);
    expect(await gate.check(req("bash", "ls"))).toEqual({ allowed: true });
    expect(prompter.seen).toHaveLength(0);
  });

  test("deny 直接拒绝并给出原因", async () => {
    const gate = new PermissionGate(new PermissionPolicy({ default: "deny" }));
    const verdict = await gate.check(req("bash", "ls"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("策略禁止");
  });

  test("ask + 用户同意 -> 放行", async () => {
    const prompter = new ScriptedPrompter([true]);
    const gate = new PermissionGate(new PermissionPolicy({ default: "ask" }), prompter);
    expect(await gate.check(req("bash", "ls"))).toEqual({ allowed: true });
    expect(prompter.seen[0]?.resource).toBe("ls");
  });

  test("ask + 用户拒绝 -> 拒绝并给出原因", async () => {
    const prompter = new ScriptedPrompter([false]);
    const gate = new PermissionGate(new PermissionPolicy({ default: "ask" }), prompter);
    const verdict = await gate.check(req("bash", "ls"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("用户拒绝");
  });

  test("ask 但没有交互入口时，安全侧失败（拒绝）", async () => {
    const gate = new PermissionGate(new PermissionPolicy({ default: "ask" }));
    const verdict = await gate.check(req("bash", "ls"));
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("没有可交互的确认入口");
  });
});

describe("P6 · 闸门接入 ToolRegistry", () => {
  function spyTool(ran: string[]): Tool<{ value?: string }> {
    return {
      name: "spy",
      description: "记录被调用",
      parameters: { type: "object", properties: {} },
      describe(input) {
        const value = (input as { value?: string } | null)?.value ?? "";
        return { resource: value, summary: `spy ${value}` };
      },
      async run(input) {
        ran.push(input.value ?? "");
        return "done";
      },
    };
  }

  const call: ToolCall = { id: "c1", name: "spy", args: { value: "hello" } };
  const ctx = {
    cwd: "/tmp",
    signal: new AbortController().signal,
    callId: "c1",
    sessionId: "test-session",
  };

  test("被拒绝的工具根本不会执行，且拒绝理由回流给模型", async () => {
    const ran: string[] = [];
    const registry = new ToolRegistry().register(spyTool(ran));
    registry.setGate(new PermissionGate(new PermissionPolicy({ default: "deny" })));

    const result = await registry.execute(call, ctx);

    expect(ran).toEqual([]); // 关键：没执行
    expect(result.ok).toBe(false);
    expect(result.output).toContain("策略禁止");
    expect(result.output).toContain("spy hello");
  });

  test("用户同意后才真正执行", async () => {
    const ran: string[] = [];
    const registry = new ToolRegistry().register(spyTool(ran));
    registry.setGate(
      new PermissionGate(new PermissionPolicy({ default: "ask" }), new ScriptedPrompter([true])),
    );

    const result = await registry.execute(call, ctx);

    expect(ran).toEqual(["hello"]);
    expect(result.ok).toBe(true);
    expect(result.output).toBe("done");
  });

  test("没有设置闸门时行为不变（向后兼容）", async () => {
    const ran: string[] = [];
    const registry = new ToolRegistry().register(spyTool(ran));
    const result = await registry.execute(call, ctx);
    expect(ran).toEqual(["hello"]);
    expect(result.ok).toBe(true);
  });
});
