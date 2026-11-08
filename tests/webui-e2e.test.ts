/**
 * WebUI v2 端到端（spec §12.4）：真实 Bun WebSocket ↔ Bun.serve ↔ hub ↔
 * SessionHost ↔ createSessionRuntime（mock provider）。
 *
 * 覆盖：hello → session.new（工厂装配真 runtime）→ attach 快照（落库消息 +
 * draft 规则）→ turn.send → §5 事件按 seq 到齐 → turn.done → 重连快照含
 * 落库历史 → turn.cancel 路径。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebuiHub } from "../src/webui/hub.ts";
import { SessionHost } from "../src/webui/session-host.ts";
import { createSessionRuntime, type SessionRuntime } from "../src/core/runtime.ts";
import type { SessionInteraction } from "../src/core/runtime.ts";
import { createMockClient, type MockTurn } from "../src/provider/adapters/mock.ts";
import { PermissionPolicy } from "../src/permission/policy.ts";
import type { UiEvent } from "../src/protocol/types.ts";

const TOKEN = "e2e-token";

interface Frame {
  kind: "cmd" | "evt" | "reply";
  type: string;
  seq?: number;
  id: string;
  payload: Record<string, unknown>;
}

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const interaction: SessionInteraction = {
  askPermission: async () => "denied",
  confirmModeChange: async () => "denied",
};

function buildRuntime(script: MockTurn[]): SessionRuntime {
  const dir = mkdtempSync(join(tmpdir(), "bugent-webui-e2e-"));
  dirs.push(dir);
  return createSessionRuntime({
    sessionId: `s-${crypto.randomUUID().slice(0, 8)}`,
    client: createMockClient({ id: "mock/e2e", script }),
    model: "echo",
    providerId: "mock",
    systemPrompt: "SYS",
    cwd: dir,
    store: undefined,
    policy: new PermissionPolicy({ default: "allow" }),
    interaction,
  });
}

let cmdCounter = 0;

function sendCmd(ws: WebSocket, type: string, payload: Record<string, unknown> = {}, sessionId?: string): string {
  cmdCounter += 1;
  const id = `e-${cmdCounter}`;
  ws.send(JSON.stringify({ v: 2, id, kind: "cmd", type, ...(sessionId !== undefined ? { sessionId } : {}), payload, ts: Date.now() }));
  return id;
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.onopen = () => resolvePromise(ws);
    ws.onerror = () => rejectPromise(new Error("ws 连接失败"));
  });
}

class Mailbox {
  frames: Frame[] = [];
  #cursors = new Map<string, number>();

  constructor(ws: WebSocket) {
    ws.onmessage = (event) => this.frames.push(JSON.parse(String(event.data)) as Frame);
  }

  async waitFor(what: string, predicate: (frame: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    let cursor = this.#cursors.get(what) ?? 0;
    for (;;) {
      while (cursor < this.frames.length) {
        const frame = this.frames[cursor]!;
        cursor += 1;
        if (predicate(frame)) {
          this.#cursors.set(what, cursor);
          return frame;
        }
      }
      this.#cursors.set(what, cursor);
      if (Date.now() > deadline) throw new Error(`等待 ${what} 超时`);
      await Bun.sleep(5);
    }
  }

  reply(cmdId: string): Promise<Frame> {
    return this.waitFor(`reply:${cmdId}`, (f) => f.kind === "reply" && f.id === cmdId);
  }

  nextEvent(type: string): Promise<Frame> {
    return this.waitFor(`evt:${type}`, (f) => f.kind === "evt" && f.type === type);
  }
}

async function hello(ws: WebSocket): Promise<Mailbox> {
  const mailbox = new Mailbox(ws);
  cmdCounter += 1;
  ws.send(JSON.stringify({ v: 2, id: `h-${cmdCounter}`, kind: "cmd", type: "hello", payload: { token: TOKEN, client: "webui", protocolVersions: [2] }, ts: Date.now() }));
  await mailbox.reply(`h-${cmdCounter}`);
  return mailbox;
}

async function attach(ws: WebSocket, mailbox: Mailbox, sessionId: string, lastSeq?: number): Promise<void> {
  const id = sendCmd(ws, "session.attach", lastSeq !== undefined ? { lastSeq } : {}, sessionId);
  await mailbox.reply(id);
}

describe("WebUI e2e · hub + SessionHost + 真 runtime", () => {
  const runtime = buildRuntime([{ text: "你好，世界" }, { text: "第二条" }]);
  const events: UiEvent[] = [];
  const hub = new WebuiHub({ token: TOKEN, heartbeatMs: 0 });
  const host = new SessionHost({
    runtime,
    cwd: runtime.session.id,
    historyTail: 50,
    policy: new PermissionPolicy({ default: "allow" }),
    // 与 entry-webui 相同的装配：host 事件同时进本地数组（断言用）与 hub（分发用）
    publish: (event) => {
      events.push(event);
      hub.publish(host.id, event);
    },
  });
  hub.registerSession(host);
  const wsServer = Bun.serve({
    port: 0,
    fetch(req, bunServer) {
      if (bunServer.upgrade(req, { data: { hub, authenticated: false, attached: new Set<string>() } })) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: hub.websocket,
  });

  afterAll(() => {
    wsServer.stop(true);
  });

  test("hello → session.list 含已注册 session；未注册 session 报 unknown_session", async () => {
    const ws = await connect(wsServer.port ?? 0);
    const mailbox = await hello(ws);
    const id = sendCmd(ws, "session.list", {});
    const list = await mailbox.reply(id);
    expect((list.payload.sessions as { sessionId: string }[]).map((s) => s.sessionId)).toContain(host.id);

    const closeId = sendCmd(ws, "session.close", {}, "s-unknown");
    expect((await mailbox.reply(closeId)).payload.code).toBe("unknown_session");
    ws.close();
  });

  test("turn.send → 事件按 seq 到齐 → turn.done；重连快照含落库历史且无 draft", async () => {
    const ws = await connect(wsServer.port ?? 0);
    const mailbox = await hello(ws);
    await attach(ws, mailbox, host.id);

    const id = sendCmd(ws, "turn.send", { text: "打个招呼" }, host.id);
    const sent = await mailbox.reply(id);
    expect(typeof sent.payload.turnId).toBe("string");

    await mailbox.nextEvent("turn.done");

    // 事件流（host 视角）：核心事件齐全且有序
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("turn.started");
    expect(types.indexOf("user.message")).toBeGreaterThan(0);
    expect(types).toContain("text.delta");
    expect(types).toContain("assistant.message");
    expect(types).toContain("usage");
    expect(types).toContain("turn.done");

    // 第二个连接带 lastSeq=0 重连：补发窗口覆盖全部事件 → draft 为 null（§7）
    const ws2 = await connect(wsServer.port ?? 0);
    const box2 = await hello(ws2);
    await attach(ws2, box2, host.id, 0);
    const attachReply = box2.frames.find((f) => f.kind === "reply" && f.type === "session.attach")!;
    const state = attachReply.payload.state as {
      messages: { msgid: number; role: string }[];
      draft: unknown;
      lastSeq: number;
    };
    expect(state.draft).toBeNull();
    expect(state.lastSeq).toBe(hub.currentSeq(host.id));
    // 落库历史：system 三件套 + user + assistant = 5 条
    expect(state.messages.length).toBe(5);
    expect(state.messages.at(-1)?.role).toBe("assistant");
    ws2.close();
  });

  test("第二个 turn（断线重连后）照常推进", async () => {
    const ws = await connect(wsServer.port ?? 0);
    const mailbox = await hello(ws);
    await attach(ws, mailbox, host.id);
    const id = sendCmd(ws, "turn.send", { text: "再来一条" }, host.id);
    await mailbox.reply(id);
    const done = await mailbox.nextEvent("turn.done");
    expect((done.payload as { result: { text: string } }).result.text).toBe("第二条");
    ws.close();
  });

  test("turn.cancel：活跃 turn 中断后 turn.done 收尾、无 turn.error", async () => {
    const slowRuntime = buildRuntime([
      { chunks: [{ type: "text", delta: "a" }, { type: "text", delta: "b" }, { type: "done", reason: "stop" }] },
    ]);
    const slowEvents: UiEvent[] = [];
    const slowHost = new SessionHost({
      runtime: slowRuntime,
      cwd: slowRuntime.session.id,
      historyTail: 10,
      policy: new PermissionPolicy({ default: "allow" }),
      publish: (event) => {
        slowEvents.push(event);
        hub.publish(slowHost.id, event);
      },
    });
    hub.registerSession(slowHost);

    const ws = await connect(wsServer.port ?? 0);
    const mailbox = await hello(ws);
    await attach(ws, mailbox, slowHost.id);
    sendCmd(ws, "turn.send", { text: "慢慢说" }, slowHost.id);
    await Bun.sleep(40);
    await mailbox.reply(sendCmd(ws, "turn.cancel", {}, slowHost.id));
    const done = await mailbox.nextEvent("turn.done");
    expect(slowEvents.some((e) => e.type === "turn.error")).toBe(false);
    expect(done.seq).toBeGreaterThan(0);
    ws.close();
  });
});
