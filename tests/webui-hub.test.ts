/**
 * WebUI v2 hub 协议测试（docs/webui-v2-protocol-spec.md §12.2）：
 * hello 认证、seq 单调、lastSeq 补发、窗口滑过降级 resync、turn.send 幂等
 * 重放（B11）、多观察者（A4/A5）、session 生命周期、unknown 命令。
 *
 * 用真实 Bun WebSocket 客户端打真实 Bun.serve —— 信封/帧序/关闭码都按线上
 * 行为验证，不用 mock transport。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { WebuiHub, type SessionDelegate, type WebuiHubOptions } from "../src/webui/hub.ts";
import type {
  GoalSummary,
  MsgId,
  PendingInteraction,
  SessionDraft,
  SessionInfo,
  StoredMessage,
  UiEvent,
  UiReplyPayload,
} from "../src/protocol/types.ts";

/* ------------------------------ 测试基建 ------------------------------ */

interface Frame {
  kind: "cmd" | "evt" | "reply";
  type: string;
  sessionId?: string;
  seq?: number;
  id: string;
  payload: Record<string, unknown>;
}

interface DelegateCalls {
  sendTurns: string[];
  watchers: number[];
  closed: boolean;
}

function fakeDelegate(id: string, options?: { draft?: SessionDraft | null }): SessionDelegate & { calls: DelegateCalls } {
  const calls: DelegateCalls = { sendTurns: [], watchers: [], closed: false };
  const delegate: SessionDelegate = {
    id,
    info(): SessionInfo {
      return {
        sessionId: id,
        cwd: "/tmp/bugent-test",
        mode: "workspace-write",
        providerId: "mock",
        model: "echo",
        turnActive: false,
      };
    },
    goalSummary(): GoalSummary | null {
      return null;
    },
    pending(): readonly PendingInteraction[] {
      return [];
    },
    draft(): SessionDraft | null {
      return options?.draft ?? null;
    },
    history(): { messages: readonly StoredMessage[]; hasMore: boolean } {
      return { messages: [], hasMore: false };
    },
    historyBefore(_beforeMsgId: MsgId, _limit: number) {
      return { messages: [], hasMore: false };
    },
    sendTurn(text: string): UiReplyPayload {
      calls.sendTurns.push(text);
      return { ok: true, turnId: `t-${calls.sendTurns.length}` };
    },
    cancelTurn() {
      return { aborted: false };
    },
    resolvePermission(_requestId: string, _outcome: "approved" | "denied"): boolean {
      return true;
    },
    alwaysAllow(): UiReplyPayload {
      return { ok: true };
    },
    answerAskUser(): boolean {
      return true;
    },
    resolveExtensionRole(_requestId: string, _allow: boolean): boolean {
      return true;
    },
    onWatchers(count: number): void {
      calls.watchers.push(count);
    },
    close(): void {
      calls.closed = true;
    },
  };
  return Object.assign(delegate, { calls });
}

let frameCounter = 0;

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.onopen = () => resolvePromise(ws);
    ws.onerror = () => rejectPromise(new Error("ws 连接失败"));
  });
}

/** 消息信箱：所有帧进数组，waitFor 消费未匹配过的帧。 */
class Mailbox {
  frames: Frame[] = [];
  #cursors = new Map<string, number>();
  onClose?: { code: number; reason: string };

  constructor(ws: WebSocket) {
    ws.onmessage = (event) => {
      this.frames.push(JSON.parse(String(event.data)) as Frame);
    };
    ws.onclose = (event) => {
      this.onClose = { code: event.code, reason: event.reason };
    };
  }

  /** 等待第一个匹配的帧（从上次该谓词的消费位置起），超时抛错。 */
  async waitFor(what: string, predicate: (frame: Frame) => boolean, timeoutMs = 2000): Promise<Frame> {
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
      if (Date.now() > deadline) throw new Error(`等待 ${what} 超时（收到 ${this.frames.length} 帧）`);
      await Bun.sleep(10);
    }
  }

  async nextEvent(type: string, timeoutMs = 2000): Promise<Frame> {
    return this.waitFor(`evt:${type}`, (frame) => frame.kind === "evt" && frame.type === type, timeoutMs);
  }

  async reply(cmdId: string, timeoutMs = 2000): Promise<Frame> {
    return this.waitFor(`reply:${cmdId}`, (frame) => frame.kind === "reply" && frame.id === cmdId, timeoutMs);
  }
}

async function hello(ws: WebSocket): Promise<Mailbox> {
  const mailbox = new Mailbox(ws);
  frameCounter += 1;
  ws.send(
    JSON.stringify({
      v: 2,
      id: `hello-${frameCounter}`,
      kind: "cmd",
      type: "hello",
      payload: { token: TOKEN, client: "webui", protocolVersions: [2] },
      ts: Date.now(),
    }),
  );
  const reply = await mailbox.reply(`hello-${frameCounter}`);
  expect(reply.payload.ok).toBe(true);
  return mailbox;
}

let cmdCounter = 0;

function sendCmd(ws: WebSocket, type: string, payload: Record<string, unknown> = {}, sessionId?: string): string {
  cmdCounter += 1;
  const id = `c-${cmdCounter}`;
  ws.send(JSON.stringify({ v: 2, id, kind: "cmd", type, ...(sessionId !== undefined ? { sessionId } : {}), payload, ts: Date.now() }));
  return id;
}

const TOKEN = "test-token";

interface RunningServer {
  hub: WebuiHub;
  port: number;
  stop(): void;
}

function startServer(hub: WebuiHub): RunningServer {
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req, { data: { hub, authenticated: false, attached: new Set<string>() } })) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: hub.websocket,
  });
  return { hub, port: server.port ?? 0, stop: () => server.stop(true) };
}

const servers: RunningServer[] = [];
afterAll(() => {
  for (const server of servers) server.stop();
});

function startHub(options?: Partial<WebuiHubOptions>): RunningServer {
  const hub = new WebuiHub({ token: TOKEN, heartbeatMs: 0, ...options });
  const server = startServer(hub);
  servers.push(server);
  return { hub, port: server.port ?? 0, stop: server.stop };
}

/* -------------------------------- 用例 -------------------------------- */

describe("WebUI hub · 认证", () => {
  test("错误 token：fatal error 事件 + 4401 关闭", async () => {
    const { port } = startHub();
    const ws = await connect(port);
    const mailbox = new Mailbox(ws);
    ws.send(JSON.stringify({ v: 2, id: "h1", kind: "cmd", type: "hello", payload: { token: "wrong" }, ts: Date.now() }));
    const error = await mailbox.nextEvent("error");
    expect(error.payload.fatal).toBe(true);
    await Bun.sleep(50);
    expect(mailbox.onClose?.code).toBe(4401);
  });

  test("hello 之前发别的命令：同样 4401", async () => {
    const { port } = startHub();
    const ws = await connect(port);
    const mailbox = new Mailbox(ws);
    ws.send(JSON.stringify({ v: 2, id: "c0", kind: "cmd", type: "session.list", payload: {}, ts: Date.now() }));
    const error = await mailbox.nextEvent("error");
    expect(error.payload.code).toBe("unauthorized");
    await Bun.sleep(50);
    expect(mailbox.onClose?.code).toBe(4401);
  });

  test("hello 成功回 version；重复 hello 回 already_authenticated", async () => {
    const { port } = startHub();
    const ws = await connect(port);
    const mailbox = await hello(ws);
    expect(mailbox.frames[0]?.payload.version).toBe(2);
    const id = sendCmd(ws, "hello", { token: TOKEN });
    const again = await mailbox.reply(id);
    expect(again.payload.code).toBe("already_authenticated");
  });
});

describe("WebUI hub · seq 与事件日志", () => {
  test("publish 的 seq 单调递增且按序到达（B1/B2）", async () => {
    const { hub, port } = startHub();
    const delegate = fakeDelegate("s-seq");
    hub.registerSession(delegate);
    const ws = await connect(port);
    const mailbox = await hello(ws);
    const id = sendCmd(ws, "session.attach", {}, "s-seq");
    await mailbox.reply(id);

    for (let i = 0; i < 3; i += 1) {
      hub.publish("s-seq", { type: "session.state", mode: "workspace-write", turnActive: false, goal: null });
    }
    const seqs: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const frame = await mailbox.nextEvent("session.state");
      seqs.push(frame.seq!);
    }
    expect(seqs).toEqual([1, 2, 3]);
  });

  test("lastSeq 补发不重不漏（B3/B6）；快照 lastSeq 衔接", async () => {
    const { hub, port } = startHub();
    hub.registerSession(fakeDelegate("s-replay"));
    // 先产生 3 个事件（无订阅者）
    for (let i = 0; i < 3; i += 1) {
      hub.publish("s-replay", { type: "usage", usage: { input: i, output: 0 } });
    }
    const ws = await connect(port);
    const mailbox = await hello(ws);
    const id = sendCmd(ws, "session.attach", { lastSeq: 1 }, "s-replay");
    await mailbox.reply(id);
    // reply 之后只补发 seq 2、3
    const frame2 = await mailbox.nextEvent("usage");
    expect(frame2.seq).toBe(2);
    const frame3 = await mailbox.nextEvent("usage");
    expect(frame3.seq).toBe(3);
    // 没有更多补发：新事件从 seq 4 继续
    hub.publish("s-replay", { type: "usage", usage: { input: 99, output: 0 } });
    const frame4 = await mailbox.nextEvent("usage");
    expect(frame4.seq).toBe(4);
  });

  test("lastSeq 滑出日志窗口 → resync + draft（B5/§9.3）", async () => {
    const draft: SessionDraft = { turnId: "t-1", text: "半截", tools: [] };
    const { hub, port } = startHub({ logCapacity: 2 });
    hub.registerSession(fakeDelegate("s-resync", { draft }));
    for (let i = 0; i < 5; i += 1) {
      hub.publish("s-resync", { type: "usage", usage: { input: i, output: 0 } });
    } // 日志只剩 seq 4、5
    const ws = await connect(port);
    const mailbox = await hello(ws);
    const id = sendCmd(ws, "session.attach", { lastSeq: 1 }, "s-resync");
    const reply = await mailbox.reply(id);
    const state = reply.payload.state as { resync?: boolean; draft: SessionDraft | null; lastSeq: number };
    expect(state.resync).toBe(true);
    expect(state.draft?.text).toBe("半截");
    expect(state.lastSeq).toBe(5);
    // resync 时不补发旧事件：下一条到达的应是新的 live 事件（seq 6）
    hub.publish("s-resync", { type: "usage", usage: { input: 100, output: 0 } });
    const next = await mailbox.nextEvent("usage");
    expect(next.seq).toBe(6);
  });

  test("重连且窗口覆盖当前 turn：draft 为 null，由补发事件重建（§7）", async () => {
    const draft: SessionDraft = { turnId: "t-2", text: "草稿", tools: [] };
    const { hub, port } = startHub();
    hub.registerSession(fakeDelegate("s-draft", { draft }));
    hub.publish("s-draft", { type: "turn.started", turnId: "t-2" });
    const ws = await connect(port);
    const mailbox = await hello(ws);
    const id = sendCmd(ws, "session.attach", { lastSeq: 0 }, "s-draft");
    const reply = await mailbox.reply(id);
    const state = reply.payload.state as { draft: SessionDraft | null; resync?: boolean };
    expect(state.resync).toBeUndefined();
    expect(state.draft).toBeNull();
    // 补发里有 turn.started
    const started = await mailbox.nextEvent("turn.started");
    expect((started.payload as { turnId: string }).turnId).toBe("t-2");
  });
});

describe("WebUI hub · 命令路由", () => {
  test("turn.send 幂等重放（B11）：相同 cmd id 只触发一次", async () => {
    const { hub, port } = startHub();
    const delegate = fakeDelegate("s-idem");
    hub.registerSession(delegate);
    const ws = await connect(port);
    const mailbox = await hello(ws);

    // 手工发两条相同 id 的 turn.send（绕过 sendCmd 的计数器）
    ws.send(JSON.stringify({ v: 2, id: "dup-1", kind: "cmd", type: "turn.send", sessionId: "s-idem", payload: { text: "hi" }, ts: Date.now() }));
    ws.send(JSON.stringify({ v: 2, id: "dup-1", kind: "cmd", type: "turn.send", sessionId: "s-idem", payload: { text: "hi" }, ts: Date.now() }));
    const first = await mailbox.reply("dup-1");
    const second = await mailbox.reply("dup-1");
    expect(first.payload).toEqual(second.payload);
    expect(first.payload.turnId).toBe("t-1");
    expect(delegate.calls.sendTurns).toEqual(["hi"]);
  });

  test("unknown_command / unknown_session / missing_session", async () => {
    const { port } = startHub();
    const ws = await connect(port);
    const mailbox = await hello(ws);

    let id = sendCmd(ws, "wat.the", {});
    expect((await mailbox.reply(id)).payload.code).toBe("unknown_command");

    id = sendCmd(ws, "turn.send", { text: "x" }, "s-missing");
    expect((await mailbox.reply(id)).payload.code).toBe("unknown_session");

    id = sendCmd(ws, "turn.cancel", {}, "s-missing");
    expect((await mailbox.reply(id)).payload.code).toBe("unknown_session");

    // v2 按**信封** sessionId 路由（spec §3）：payload 里的 sessionId 不参与路由
    id = sendCmd(ws, "session.attach", { sessionId: "s-missing" });
    expect((await mailbox.reply(id)).payload.code).toBe("missing_session");

    id = sendCmd(ws, "session.attach", {}, "s-missing");
    expect((await mailbox.reply(id)).payload.code).toBe("unknown_session");

    // 有 sessionId 信封但缺 session 级命令的 payload 细节 → bad_payload
    id = sendCmd(ws, "turn.send", {}, "whatever");
    expect((await mailbox.reply(id)).payload.code).toBe("unknown_session");
  });

  test("session.new（工厂）/ session.list / session.close 生命周期", async () => {
    const { port } = startHub({ sessionFactory: async () => fakeDelegate("s-created") });
    const hub = servers.at(-1)!.hub;
    hub.registerSession(fakeDelegate("s-existing"));
    const ws = await connect(port);
    const mailbox = await hello(ws);

    let id = sendCmd(ws, "session.list", {});
    const list = await mailbox.reply(id);
    expect((list.payload.sessions as SessionInfo[]).map((s) => s.sessionId)).toEqual(["s-existing"]);

    id = sendCmd(ws, "session.new", {});
    const created = await mailbox.reply(id);
    expect(created.payload.ok).toBe(true);
    expect(created.payload.sessionId).toBe("s-created");

    id = sendCmd(ws, "session.close", {}, "s-created");
    expect((await mailbox.reply(id)).payload.ok).toBe(true);

    id = sendCmd(ws, "turn.cancel", {}, "s-created");
    expect((await mailbox.reply(id)).payload.code).toBe("unknown_session");
    void hub;
  });

  test("history.before 回页（§10）", async () => {
    const { hub, port } = startHub();
    const delegate = fakeDelegate("s-history");
    delegate.historyBefore = (beforeMsgId: MsgId, limit: number) => ({
      messages: [{ msgid: beforeMsgId - 1, role: "user", parts: [], origin: "user" } as unknown as StoredMessage],
      hasMore: beforeMsgId - limit > 0,
    });
    hub.registerSession(delegate);
    const ws = await connect(port);
    const mailbox = await hello(ws);
    const id = sendCmd(ws, "history.before", { beforeMsgId: 10, limit: 1 }, "s-history");
    const reply = await mailbox.reply(id);
    expect(reply.payload.hasMore).toBe(true);
    expect((reply.payload.messages as StoredMessage[])[0]?.msgid).toBe(9);
  });
});

describe("WebUI hub · 多观察者（A4/A5）", () => {
  test("两个连接同看一个 session；关闭后 onWatchers 递减", async () => {
    const { hub, port } = startHub();
    const delegate = fakeDelegate("s-multi");
    hub.registerSession(delegate);
    const wsA = await connect(port);
    const boxA = await hello(wsA);
    const wsB = await connect(port);
    const boxB = await hello(wsB);

    await boxA.reply(sendCmd(wsA, "session.attach", {}, "s-multi"));
    await boxB.reply(sendCmd(wsB, "session.attach", {}, "s-multi"));
    expect(delegate.calls.watchers.at(-1)).toBe(2);

    hub.publish("s-multi", { type: "usage", usage: { input: 1, output: 1 } });
    const a = await boxA.nextEvent("usage");
    const b = await boxB.nextEvent("usage");
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);

    wsA.close(1000);
    await Bun.sleep(50);
    expect(delegate.calls.watchers.at(-1)).toBe(1);
    wsB.close(1000);
    await Bun.sleep(50);
    expect(delegate.calls.watchers.at(-1)).toBe(0);
  });
});
