/**
 * SessionHost 测试（spec §12.3）：LoopHooks → UiEvent 的映射、blockId 分配、
 * request-id 往返（permission / always / 断连默认 denied）、draft 与历史窗口。
 *
 * 用真实 createSessionRuntime（mock provider + 内存 session）驱动，事件经
 * 注入的 publish 回调收集 —— hub 机器不参与，领域语义单独验证。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHost } from "../src/webui/session-host.ts";
import { createSessionRuntime, type SessionRuntime } from "../src/core/runtime.ts";
import type { SessionInteraction } from "../src/core/runtime.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import type { MockTurn } from "../src/provider/adapters/mock.ts";
import { PermissionPolicy, type PermissionRequest } from "../src/permission/policy.ts";
import type { Tool } from "../src/tools/types.ts";
import type { UiEvent } from "../src/protocol/types.ts";

/* ------------------------------ 测试基建 ------------------------------ */

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-webui-host-"));
  dirs.push(dir);
  return dir;
}

const pingTool: Tool = {
  name: "ping",
  description: "测试工具",
  parameters: { type: "object", properties: {} },
  async run() {
    return { ok: true, output: "pong" };
  },
  describe: () => ({ resource: "ping", summary: "ping 一下" }),
};

const interaction: SessionInteraction = {
  askPermission: async () => "denied",
  confirmModeChange: async () => "denied",
};

function buildRuntime(script: MockTurn[], chunkDelayMs?: number): SessionRuntime {
  const client = createMockClient({
    id: "mock/test",
    script,
    ...(chunkDelayMs !== undefined ? { chunkDelayMs } : {}),
  });
  return createSessionRuntime({
    sessionId: `s-${crypto.randomUUID().slice(0, 8)}`,
    client,
    model: "echo",
    providerId: "mock",
    systemPrompt: "SYS",
    cwd: dirs.at(-1) ?? ".",
    store: undefined,
    policy: new PermissionPolicy({ default: "allow" }),
    interaction,
  });
}

function buildHost(runtime: SessionRuntime): { host: SessionHost; events: UiEvent[] } {
  const events: UiEvent[] = [];
  const host = new SessionHost({
    runtime,
    cwd: runtime.session.id,
    historyTail: 3,
    policy: new PermissionPolicy({ default: "ask" }),
    publish: (event) => events.push(event),
  });
  runtime.tools.register(pingTool);
  return { host, events };
}

async function until<T>(what: string, fn: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待 ${what} 超时`);
    await Bun.sleep(5);
  }
}

const TOOL_REQUEST: PermissionRequest = {
  tool: "exec",
  resource: "npm install",
  summary: "执行 npm install",
};

/* -------------------------------- 用例 -------------------------------- */

describe("SessionHost · LoopHooks → UiEvent 映射", () => {
  test("turn 全程事件序与 blockId 分配（工具块打断文本块）", async () => {
    const runtime = buildRuntime([{ toolCalls: [{ id: "c1", name: "ping", args: {} }] }, { text: "done" }]);
    const { host, events } = buildHost(runtime);

    const reply = host.sendTurn("跑一下");
    expect(reply).toEqual({ ok: true, turnId: expect.any(String) });
    const turnId = (reply as { ok: true; turnId: string }).turnId;

    await until("turn.done", () => events.find((e) => e.type === "turn.done"));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn.started");
    expect(types.indexOf("user.message")).toBeGreaterThan(types.indexOf("turn.started"));
    expect(types).toContain("tool.call_delta");
    expect(types).toContain("tool.call");
    expect(types).toContain("tool.result");
    expect(types).toContain("text.delta");
    expect(types).toContain("assistant.message");
    expect(types.at(-1)).toBe("session.state");

    // blockId：同一工具调用的 delta/call/result 同块；文本 delta 是另一块
    const callDelta = events.find((e) => e.type === "tool.call_delta") as Extract<UiEvent, { type: "tool.call_delta" }>;
    const call = events.find((e) => e.type === "tool.call") as Extract<UiEvent, { type: "tool.call" }>;
    const result = events.find((e) => e.type === "tool.result") as Extract<UiEvent, { type: "tool.result" }>;
    expect(callDelta.blockId).toBe(call.blockId);
    expect(call.blockId).toBe(result.blockId);
    expect(callDelta.turnId).toBe(turnId);
    const text = events.find((e) => e.type === "text.delta") as Extract<UiEvent, { type: "text.delta" }>;
    expect(text.blockId).not.toBe(call.blockId);
    expect(text.blockId.startsWith(turnId)).toBe(true);

    // tool.result 带执行结果；turn.done 带最终文本
    expect(result.result.ok).toBe(true);
    const done = events.find((e) => e.type === "turn.done") as Extract<UiEvent, { type: "turn.done" }>;
    expect(done.result.text).toBe("done");
    expect(done.turnId).toBe(turnId);

    // 收尾后 draft 清空
    expect(host.draft()).toBeNull();
  });

  test("cancel：无 turn.error，turn.done 收尾（§8）", async () => {
    const runtime = buildRuntime(
      [{ chunks: [{ type: "text", delta: "慢" }, { type: "text", delta: "慢" }, { type: "done", reason: "stop" }] }],
      80,
    );
    const { host, events } = buildHost(runtime);
    host.sendTurn("慢慢说");
    await Bun.sleep(30);
    expect(host.cancelTurn().aborted).toBe(true);
    const done = await until("turn.done", () => events.find((e) => e.type === "turn.done")) as Extract<UiEvent, { type: "turn.done" }>;
    expect(events.some((e) => e.type === "turn.error")).toBe(false);
    expect(done.turnId).toBe((events[0] as Extract<UiEvent, { type: "turn.started" }>).turnId);
  });

  test("turn_busy：活跃 turn 期间重复 sendTurn", async () => {
    const runtime = buildRuntime([{ chunks: [{ type: "text", delta: "x" }, { type: "done", reason: "stop" }] }], 60);
    const { host } = buildHost(runtime);
    host.sendTurn("第一条");
    expect(host.sendTurn("第二条")).toMatchObject({ ok: false, code: "turn_busy" });
    await until("settled", () => (host.draft() === null ? true : undefined));
  });

  test("流式中段 draft 可续看（B7）；落库后清空", async () => {
    const runtime = buildRuntime([{ chunks: [{ type: "text", delta: "第一" }, { type: "text", delta: "段" }, { type: "done", reason: "stop" }] }], 40);
    const { host, events } = buildHost(runtime);
    host.sendTurn("讲讲");
    await until("first text.delta", () => events.find((e) => e.type === "text.delta"));
    const draft = host.draft();
    expect(draft).not.toBeNull();
    expect(draft?.text.length).toBeGreaterThan(0);
    expect(draft?.turnId).toBe((events[0] as Extract<UiEvent, { type: "turn.started" }>).turnId);
    await until("turn.done", () => events.find((e) => e.type === "turn.done"));
    expect(host.draft()).toBeNull();
  });
});

describe("SessionHost · request-id 往返（§6）", () => {
  test("permission.request → resolve approved；二次 resolve false；广播 interaction.resolved", async () => {
    const runtime = buildRuntime([{ text: "ok" }]);
    const { host, events } = buildHost(runtime);

    host.onWatchers(1); // 先模拟观察者在线：watcher 检查发生在请求创建的同一同步步
    const pending = host.askPermission(TOOL_REQUEST);
    const request = await until("permission.request", () => events.find((e) => e.type === "permission.request")) as Extract<UiEvent, { type: "permission.request" }>;
    expect(request.request.summary).toBe("执行 npm install");
    expect(host.pending().map((p) => p.requestId)).toContain(request.requestId);

    expect(host.resolvePermission(request.requestId, "approved")).toBe(true);
    await expect(pending).resolves.toBe("approved");

    const resolved = await until("interaction.resolved", () => events.find((e) => e.type === "interaction.resolved")) as Extract<UiEvent, { type: "interaction.resolved" }>;
    expect(resolved.requestId).toBe(request.requestId);
    expect(resolved.outcome).toBe("approved");
    expect(host.resolvePermission(request.requestId, "denied")).toBe(false);
  });

  test("always：写字面量 allow 规则并按 approved 继续；档位升级拒绝 always（§6.4）", async () => {
    const runtime = buildRuntime([{ text: "ok" }]);
    const events: UiEvent[] = [];
    const policy = new PermissionPolicy({ default: "ask" });
    const host = new SessionHost({
      runtime,
      cwd: runtime.session.id,
      historyTail: 10,
      policy,
      publish: (event) => events.push(event),
    });

    expect(policy.evaluate(TOOL_REQUEST).decision).toBe("ask");
    host.onWatchers(1);
    const pending = host.askPermission(TOOL_REQUEST);
    const request = await until("p2", () => events.find((e) => e.type === "permission.request")) as Extract<UiEvent, { type: "permission.request" }>;
    expect(host.alwaysAllow(request.requestId)).toEqual({ ok: true });
    await expect(pending).resolves.toBe("approved");
    const after = policy.evaluate(TOOL_REQUEST);
    expect(after.decision).toBe("allow");
    expect(after.matched).toBe(true);

    // 档位升级不是工具放行：不支持「总是允许」
    const events2: UiEvent[] = [];
    const host2 = new SessionHost({
      runtime,
      cwd: runtime.session.id,
      historyTail: 10,
      policy,
      publish: (event) => events2.push(event),
    });
    host2.onWatchers(1);
    const modePending = host2.confirmModeChange(TOOL_REQUEST, "no-sandbox");
    const modeRequest = await until("p3", () => events2.find((e) => e.type === "permission.request")) as Extract<UiEvent, { type: "permission.request" }>;
    expect(host2.alwaysAllow(modeRequest.requestId)).toMatchObject({ ok: false, code: "not_allowed" });
    expect(host2.resolvePermission(modeRequest.requestId, "denied")).toBe(true);
    await expect(modePending).resolves.toBe("denied");
  });
});

describe("SessionHost · 断连默认结论与历史窗口", () => {
  test("onWatchers(0)：挂起的 permission 被拒绝（§6.3）", async () => {
    const runtime = buildRuntime([{ text: "ok" }]);
    const { host, events } = buildHost(runtime);
    const pending = host.askPermission(TOOL_REQUEST);
    await until("pre", () => events.find((e) => e.type === "permission.request"));
    host.onWatchers(1);
    host.onWatchers(0);
    await expect(pending).resolves.toBe("denied");
  });

  test("history() 尾部窗口与 hasMore；historyBefore 游标翻页（§10）", async () => {
    const runtime = buildRuntime([{ text: "历史" }]);
    const { host } = buildHost(runtime);
    host.sendTurn("生成几条消息");
    await until("h-done", () => (runtime.session.turnActive ? undefined : true));
    // historyTail = 3：session 消息比窗口多
    const page = host.history();
    expect(page.messages.length).toBe(3);
    expect(page.hasMore).toBe(true);
    // 游标 = 窗口最旧一条之前
    const oldest = page.messages[0]!;
    const older = host.historyBefore(oldest.msgid, 2);
    expect(older.messages.every((m) => m.msgid < oldest.msgid)).toBe(true);
    expect(older.hasMore).toBe(older.messages[0]!.msgid > 0);
  });

  test("goalSummary：无 goal 时为 null（GoalController 未装配）", () => {
    const runtime = buildRuntime([{ text: "ok" }]);
    const { host } = buildHost(runtime);
    expect(host.goalSummary()).toBeNull();
  });
});
