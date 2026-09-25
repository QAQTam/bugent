import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compileAgentSandboxSpec } from "../src/agent/sandbox.ts";

const ROOT = "/tmp/bugent-agent-workspace";

describe("P7-A · AgentSandboxSpec compiler", () => {
  test("reviewer defaults to shared read-only with no network", () => {
    const spec = compileAgentSandboxSpec(
      { agentId: "review-1", kind: "reviewer", workspace: { root: ROOT } },
      "linux",
    );

    expect(spec.authority).toBe("read-only");
    expect(spec.workspace.access).toBe("read");
    expect(spec.workspace.isolation).toBe("shared");
    expect(spec.process.isolation).toBe("bwrap");
    expect(spec.network.mode).toBe("none");
    expect(spec.capabilities).toEqual(["fs.read", "process.exec"]);
    expect(spec.maxDepth).toBe(0);
    expect(spec.controlChannel).toBe("supervisor-ipc");
  });

  test("worker defaults to an isolated worktree with no network", () => {
    const spec = compileAgentSandboxSpec(
      { agentId: "worker-1", kind: "worker", workspace: { root: ROOT } },
      "linux",
    );

    expect(spec.workspace.access).toBe("write");
    expect(spec.workspace.isolation).toBe("worktree");
    expect(spec.capabilities).toEqual(["fs.read", "fs.write", "process.exec"]);
    expect(spec.network.mode).toBe("none");
    expect(spec.capabilities).not.toContain("network");
  });

  test("child authority and capabilities cannot exceed the parent", () => {
    expect(() =>
      compileAgentSandboxSpec(
        {
          agentId: "worker-1",
          kind: "worker",
          authority: "workspace-write",
          parent: { authority: "read-only", capabilities: ["fs.read", "process.exec"] },
          workspace: { root: ROOT },
        },
        "linux",
      ),
    ).toThrow(/authority/);

    expect(() =>
      compileAgentSandboxSpec(
        {
          agentId: "review-1",
          kind: "reviewer",
          parent: { authority: "read-only", capabilities: ["fs.read"] },
          workspace: { root: ROOT },
        },
        "linux",
      ),
    ).toThrow(/capability/);
  });

  test("reviewer cannot receive a write or network grant", () => {
    expect(() =>
      compileAgentSandboxSpec(
        {
          agentId: "review-1",
          kind: "reviewer",
          capabilities: ["fs.read", "fs.write"],
          workspace: { root: ROOT, access: "write" },
        },
        "linux",
      ),
    ).toThrow(/does not allow capability fs.write/);

    expect(() =>
      compileAgentSandboxSpec(
        {
          agentId: "review-1",
          kind: "reviewer",
          capabilities: ["fs.read", "network"],
          network: { mode: "all" },
          workspace: { root: ROOT },
        },
        "linux",
      ),
    ).toThrow(/does not allow capability network/);
  });

  test("process.exec fails closed without a process isolation provider", () => {
    expect(() =>
      compileAgentSandboxSpec(
        {
          agentId: "review-1",
          kind: "reviewer",
          process: { isolation: "none" },
          workspace: { root: ROOT },
        },
        "linux",
      ),
    ).toThrow(/no process isolation/);
  });

  test("network capability requires an explicit one-shot grant", () => {
    const base = {
      agentId: "worker-1",
      kind: "worker" as const,
      capabilities: ["fs.read", "fs.write", "process.exec", "network"] as const,
      workspace: { root: ROOT },
    };

    expect(() =>
      compileAgentSandboxSpec(base, "linux"),
    ).toThrow(/network capability/);

    expect(() =>
      compileAgentSandboxSpec(
        { ...base, network: { mode: "one-shot" } },
        "linux",
      ),
    ).toThrow(/oneShotGrantId/);

    const spec = compileAgentSandboxSpec(
      {
        ...base,
        network: { mode: "one-shot", oneShotGrantId: "grant-1" },
      },
      "linux",
    );
    expect(spec.network).toEqual({
      mode: "one-shot",
      allow: [],
      oneShotGrantId: "grant-1",
    });
  });

  test("MCP grants require the mcp.use capability", () => {
    expect(() =>
      compileAgentSandboxSpec(
        {
          agentId: "worker-1",
          kind: "worker",
          mcpServerIds: ["github"],
          workspace: { root: ROOT },
        },
        "linux",
      ),
    ).toThrow(/mcp.use/);
  });

  test("workspace paths cannot escape the root or overlap", () => {
    expect(() =>
      compileAgentSandboxSpec(
        {
          agentId: "worker-1",
          kind: "worker",
          workspace: { root: ROOT, writablePaths: ["../escape"] },
        },
        "linux",
      ),
    ).toThrow(/must stay inside the workspace root/);

    expect(() =>
      compileAgentSandboxSpec(
        {
          agentId: "worker-1",
          kind: "worker",
          workspace: {
            root: ROOT,
            writablePaths: ["src"],
            readonlyPaths: [join(ROOT, "src/generated")],
          },
        },
        "linux",
      ),
    ).toThrow(/overlaps/);
  });

  test("returned spec is deeply frozen", () => {
    const spec = compileAgentSandboxSpec(
      {
        agentId: "worker-1",
        kind: "worker",
        workspace: { root: ROOT, writablePaths: ["src"] },
      },
      "linux",
    );

    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.workspace)).toBe(true);
    expect(Object.isFrozen(spec.workspace.writablePaths)).toBe(true);
    expect(Object.isFrozen(spec.process)).toBe(true);
    expect(Object.isFrozen(spec.capabilities)).toBe(true);
    expect(Object.isFrozen(spec.env.extra)).toBe(true);
  });

  test("limits and environment overrides fail closed", () => {
    expect(() =>
      compileAgentSandboxSpec(
        {
          agentId: "worker-1",
          kind: "worker",
          process: { maxProcesses: 0 },
          workspace: { root: ROOT },
        },
        "linux",
      ),
    ).toThrow(/maxProcesses/);

    expect(() =>
      compileAgentSandboxSpec(
        {
          agentId: "worker-1",
          kind: "worker",
          env: { extra: { HOME: "/tmp/fake-home" } },
          workspace: { root: ROOT },
        },
        "linux",
      ),
    ).toThrow(/reserved variables/);
  });

  test("agent.spawn requires an explicit positive maxDepth", () => {
    expect(() =>
      compileAgentSandboxSpec(
        {
          agentId: "worker-1",
          kind: "worker",
          authority: "full",
          capabilities: ["fs.read", "fs.write", "process.exec", "agent.spawn"],
          workspace: { root: ROOT },
        },
        "linux",
      ),
    ).toThrow(/maxDepth/);

    const spec = compileAgentSandboxSpec(
      {
        agentId: "worker-1",
        kind: "worker",
        authority: "full",
        capabilities: ["fs.read", "fs.write", "process.exec", "agent.spawn"],
        maxDepth: 1,
        workspace: { root: ROOT },
      },
      "linux",
    );
    expect(spec.maxDepth).toBe(1);
  });
});
