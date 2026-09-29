/** headless echo client（docs/ui-protocol-spec.md §10.3 验收）：
 *  连 ws → hello → session.new → turn.send(mock provider) → 按序收到 §5 事件 → turn.done；
 *  另跑 cancel 路径与 permission denied 路径；多 session 并行 turn 事件不串流。
 *  用法：bun run scripts/protocol-smoke.ts   （自起 bridge，随机端口，跑完退出） */

import { Bridge, type ManagedSession, type SessionFactoryOptions } from "../src/runtime/bridge";
import { AgentSession } from "../src/core/session";
import { createMockClient, type MockTurn } from "../src/provider/adapters/mock";
import { ToolRegistry, type Tool } from "../src/tools/types";
import { PermissionPolicy } from "../src/permission/policy";
import type { UiEnvelope } from "../src/protocol/types";

// ---------- 极简 WS 客户端 ----------

class Client {
  #ws: WebSocket;
  frames: UiEnvelope[] = [];
  #waiters: { match: (e: UiEnvelope) => boolean; resolve: (e: UiEnvelope) => void }[] = [];
  #seq = 0;

  constructor(url: string) {
    this.#ws = new WebSocket(url);
    this.#ws.onmessage = (ev) => {
      const env = JSON.parse(String(ev.data)) as UiEnvelope;
      this.frames.push(env);
      const idx = this.#waiters.findIndex((w) => w.match(env));
      if (idx !== -1) this.#waiters.splice(idx, 1)[0]!.resolve(env);
    };
  }

  static async connect(url: string): Promise<Client> {
    const c = new Client(url);
    await new Promise<void>((resolve, reject) => {
      c.#ws.onopen = () => resolve();
      c.#ws.onerror = () => reject(new Error("连接失败"));
    });
    return c;
  }

  send(type: string, payload: Record<string, unknown> = {}, sessionId?: string): Promise<UiEnvelope> {
    const id = `m-${++this.#seq}`;
    return new Promise((resolve) => {
      this.#waiters.push({ match: (e) => e.kind === "reply" && e.id === id, resolve });
      this.#ws.send(
        JSON.stringify({ v: 1, id, kind: "cmd", type, ...(sessionId ? { sessionId } : {}), payload, ts: Date.now() }),
      );
    });
  }

  waitFor(match: (e: UiEnvelope) => boolean, label: string, timeoutMs = 5000): Promise<UiEnvelope> {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error(`waitFor 超时: ${label}`)), timeoutMs);
      this.#waiters.push({ match, resolve });
    });
  }

  close(): void {
    this.#ws.close();
  }
}

// ---------- 工具与工厂 ----------

function echoTool(): Tool<{ text: string }> {
  return {
    name: "echo",
    description: "回显给定文本",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
    },
    describe: (input) => {
      const text = (input as { text?: string } | null)?.text ?? "";
      return { resource: text, summary: `回显 ${text}` };
    },
    async run(input) {
      return `echo:${input.text}`;
    },
  };
}

function sessionFor(spec: { script: MockTurn[]; askEcho?: boolean; chunkDelayMs?: number }): (o: SessionFactoryOptions) => ManagedSession {
  return ({ sessionId }) => ({
    session: new AgentSession({
      id: sessionId,
      system: "SYS",
      client: createMockClient({
        script: spec.script,
        ...(spec.chunkDelayMs !== undefined ? { chunkDelayMs: spec.chunkDelayMs } : {}),
      }),
      model: "smoke-model",
      now: () => 0,
    }),
    registry: new ToolRegistry().register(echoTool()),
    policy: new PermissionPolicy(spec.askEcho ? { default: "allow", rules: [{ tool: "echo", decision: "ask" }] } : { default: "allow" }),
    model: "smoke-model",
  });
}

// ---------- 场景 ----------

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function echoPath(url: string, token: string): Promise<void> {
  const client = await Client.connect(url);
  const hello = await client.send("hello", { token, client: "webui", protocolVersions: [1] });
  if (hello.payload.ok !== true) throw new Error("hello 失败");
  ok("hello 握手");

  const created = await client.send("session.new", {});
  const sessionId = String(created.payload.sessionId);
  await client.send("session.attach", { sessionId }, sessionId);

  const turn = await client.send("turn.send", { text: "跑一下" }, sessionId);
  if (turn.payload.ok !== true) throw new Error("turn.send 失败");
  await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done" && e.sessionId === sessionId, "turn.done");

  const events = client.frames
    .filter((e) => e.kind === "evt" && e.sessionId === sessionId)
    .map((e) => e.type);
  const order = ["turn.started", "user.message", "text.delta", "tool.call", "tool.result", "turn.done"];
  const picked = order.map((t) => events.indexOf(t));
  if (picked.some((i) => i < 0) || !picked.every((v, i) => i === 0 || v >= picked[i - 1]!)) {
    throw new Error(`事件顺序不对: ${events.join(",")}`);
  }
  ok(`事件按 §5 顺序到达（${events.length} 个事件，含 tool.call/tool.result）`);
  client.close();
}

async function smoke(): Promise<number> {
  console.log("bugent protocol smoke");

  // 场景 1：echo 事件顺序
  const bridgeEcho = new Bridge({ createSession: sessionFor({ script: [
    { text: "我来调用工具", toolCalls: [{ id: "c1", name: "echo", args: { text: "hi" } }] },
    { text: "完成" },
  ] }) });
  const echoInfo = await bridgeEcho.start();
  await echoPath(echoInfo.url, echoInfo.token);
  bridgeEcho.stop();

  // 场景 2：cancel 路径
  const bridgeCancel = new Bridge({ createSession: sessionFor({ script: [
    { chunks: [{ type: "text", delta: "开始" }, { type: "text", delta: "继续" }, { type: "done", reason: "stop" }] },
  ], chunkDelayMs: 150 }) });
  const cancelInfo = await bridgeCancel.start();
  {
    const client = await Client.connect(cancelInfo.url);
    await client.send("hello", { token: cancelInfo.token, client: "webui", protocolVersions: [1] });
    const created = await client.send("session.new", {});
    const sessionId = String(created.payload.sessionId);
    await client.send("session.attach", { sessionId }, sessionId);
    await client.send("turn.send", { text: "长任务" }, sessionId);
    const cancel = await client.send("turn.cancel", {}, sessionId);
    if (cancel.payload.ok !== true || cancel.payload.aborted !== true) throw new Error("turn.cancel 语义不对");
    await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done", "turn.done(cancel)");
    ok("turn.cancel → aborted:true → turn.done 收尾");
    client.close();
  }
  bridgeCancel.stop();

  // 场景 3：permission denied 路径
  const bridgePerm = new Bridge({ createSession: sessionFor({
    script: [
      { text: "调用", toolCalls: [{ id: "c1", name: "echo", args: { text: "x" } }] },
      { text: "结束" },
    ],
    askEcho: true,
  }) });
  const permInfo = await bridgePerm.start();
  {
    const client = await Client.connect(permInfo.url);
    await client.send("hello", { token: permInfo.token, client: "webui", protocolVersions: [1] });
    const created = await client.send("session.new", {});
    const sessionId = String(created.payload.sessionId);
    await client.send("session.attach", { sessionId }, sessionId);
    await client.send("turn.send", { text: "go" }, sessionId);
    const req = await client.waitFor((e) => e.kind === "evt" && e.type === "permission.request", "permission.request");
    await client.send("permission.resolve", { requestId: (req.payload as { requestId: string }).requestId, outcome: "denied" });
    await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done", "turn.done(denied)");
    ok("permission.request → denied → turn 正常收尾");
    client.close();
  }
  bridgePerm.stop();

  // 场景 4：多 session 并行不串流
  let counter = 0;
  const bridgeMulti = new Bridge({
    createSession: ({ sessionId }) => {
      counter += 1;
      const text = counter === 1 ? "AAA" : "BBB";
      return {
        session: new AgentSession({
          id: sessionId, system: "SYS",
          client: createMockClient({ script: [{ text }] }), model: "m", now: () => 0,
        }),
        registry: new ToolRegistry(),
        policy: new PermissionPolicy({ default: "allow" }),
        model: "m",
      };
    },
  });
  const multiInfo = await bridgeMulti.start();
  {
    const client = await Client.connect(multiInfo.url);
    await client.send("hello", { token: multiInfo.token, client: "webui", protocolVersions: [1] });
    const a = String((await client.send("session.new", {})).payload.sessionId);
    const b = String((await client.send("session.new", {})).payload.sessionId);
    await client.send("session.attach", { sessionId: a }, a);
    await client.send("session.attach", { sessionId: b }, b);
    await client.send("turn.send", { text: "x" }, a);
    await client.send("turn.send", { text: "y" }, b);
    await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done" && e.sessionId === a, "done a");
    await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done" && e.sessionId === b, "done b");
    const da = client.frames
      .filter((e) => e.kind === "evt" && e.type === "text.delta" && e.sessionId === a)
      .map((e) => (e.payload as { delta: string }).delta)
      .join("");
    const db = client.frames
      .filter((e) => e.kind === "evt" && e.type === "text.delta" && e.sessionId === b)
      .map((e) => (e.payload as { delta: string }).delta)
      .join("");
    if (da !== "AAA" || db !== "BBB") throw new Error("多 session 事件串流");
    ok("多 session 并行，事件按 sessionId 路由不串流");
    client.close();
  }
  bridgeMulti.stop();

  console.log(`\nsmoke 通过：${passed} 项检查`);
  return 0;
}

smoke()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("smoke 失败:", err);
    process.exit(1);
  });
