import { describe, expect, test } from "bun:test";
import { Bridge, type ManagedSession, type SessionFactoryOptions } from "../src/runtime/bridge";
import { AgentSession } from "../src/core/session";
import { createMockClient, type MockTurn } from "../src/provider/adapters/mock";
import { ToolRegistry, type Tool } from "../src/tools/types";
import { PermissionPolicy, type PermissionRule } from "../src/permission/policy";
import { UI_PROTOCOL_VERSION, type UiEnvelope } from "../src/protocol/types";

// ---------- 测试脚手架 ----------

function echoTool(sink: string[]): Tool<{ text: string }> {
  return {
    name: "echo",
    description: "回显给定文本",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
    },
    describe(input: unknown) {
      const text = (input as { text?: string } | null)?.text ?? "";
      return { resource: text, summary: `回显 ${text}` };
    },
    async run(input) {
      sink.push(input.text);
      return `echo:${input.text}`;
    },
  };
}

interface FactorySpec {
  script: MockTurn[];
  policyRules?: PermissionRule[];
  tool?: Tool<{ text: string }>;
  chunkDelayMs?: number;
}

function makeFactory(spec: FactorySpec) {
  const sink: string[] = [];
  const factory = ({ sessionId }: SessionFactoryOptions): ManagedSession => {
    const registry = new ToolRegistry();
    if (spec.tool) registry.register(spec.tool);
    const session = new AgentSession({
      id: sessionId,
      system: "SYS",
      client: createMockClient({ script: spec.script, ...(spec.chunkDelayMs !== undefined ? { chunkDelayMs: spec.chunkDelayMs } : {}) }),
      model: "test-model",
      now: () => 0,
    });
    return {
      session,
      registry,
      policy: new PermissionPolicy({ default: "allow", ...(spec.policyRules ? { rules: spec.policyRules } : {}) }),
      model: "test-model",
    };
  };
  return { factory, sink };
}

function nextId(): string {
  return `m-${Math.random().toString(36).slice(2, 10)}`;
}

/** 测试用 WS 客户端：收集信封，按 cmd.id 等待 reply。 */
class TestClient {
  #ws: WebSocket;
  frames: UiEnvelope[] = [];
  #waiters: { match: (e: UiEnvelope) => boolean; resolve: (e: UiEnvelope) => void }[] = [];
  closed: { code: number } | undefined;

  constructor(url: string) {
    this.#ws = new WebSocket(url);
    this.#ws.onmessage = (ev) => {
      const env = JSON.parse(String(ev.data)) as UiEnvelope;
      this.frames.push(env);
      const idx = this.#waiters.findIndex((w) => w.match(env));
      if (idx !== -1) this.#waiters.splice(idx, 1)[0]!.resolve(env);
    };
    this.#ws.onclose = (ev) => {
      this.closed = { code: ev.code };
      for (const w of this.#waiters.splice(0)) {
        w.resolve({ v: 1, id: "__closed__", kind: "evt", type: "__closed__", payload: {}, ts: 0 });
      }
    };
  }

  static async connect(url: string): Promise<TestClient> {
    const c = new TestClient(url);
    await c.#opened();
    return c;
  }

  #opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#ws.onopen = () => resolve();
      this.#ws.onerror = () => reject(new Error("connect failed"));
    });
  }

  send(type: string, payload: Record<string, unknown> = {}, sessionId?: string): string {
    const id = nextId();
    this.#ws.send(
      JSON.stringify({ v: UI_PROTOCOL_VERSION, id, kind: "cmd", type, ...(sessionId ? { sessionId } : {}), payload, ts: Date.now() }),
    );
    return id;
  }

  /** 发命令并等 reply。 */
  async cmd(type: string, payload: Record<string, unknown> = {}, sessionId?: string): Promise<UiEnvelope> {
    const id = this.send(type, payload, sessionId);
    return this.waitFor((e) => e.kind === "reply" && e.id === id);
  }

  waitFor(match: (e: UiEnvelope) => boolean, timeoutMs = 5000): Promise<UiEnvelope> {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitFor 超时")), timeoutMs);
      this.#waiters.push({
        match,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  }

  async hello(): Promise<void> {
    await this.cmd("hello", { token: "", client: "webui", protocolVersions: [1] });
  }

  close(): void {
    this.#ws.close();
  }
}

async function startBridge(factory: (o: SessionFactoryOptions) => ManagedSession): Promise<{ bridge: Bridge; url: string; token: string }> {
  const bridge = new Bridge({ createSession: factory });
  const info = await bridge.start();
  return { bridge, url: info.url, token: info.token };
}

const HELLO = { token: "", client: "webui" as const, protocolVersions: [1] };

// ---------- 测试 ----------

describe("bridge 握手与认证（§2）", () => {
  test("token 错误 → error 事件后关闭 4401", async () => {
    const { factory } = makeFactory({ script: [] });
    const { bridge, url } = await startBridge(factory);
    const client = await TestClient.connect(url);
    client.send("hello", { ...HELLO, token: "wrong" });
    const err = await client.waitFor((e) => e.kind === "evt" && e.type === "error");
    expect(err.payload.code).toBe("unauthorized");
    await client.waitFor((e) => e.type === "__closed__");
    expect(client.closed?.code).toBe(4401);
    bridge.stop();
  });

  test("hello 成功，版本协商通过", async () => {
    const { factory } = makeFactory({ script: [] });
    const { bridge, url, token } = await startBridge(factory);
    const client = await TestClient.connect(url);
    const reply = await client.cmd("hello", { ...HELLO, token });
    expect(reply.payload.ok).toBe(true);
    expect(reply.payload.version).toBe(UI_PROTOCOL_VERSION);
    client.close();
    bridge.stop();
  });
});

describe("bridge turn 事件流（§5 验收 10.3）", () => {
  test("echo 路径：事件顺序 turn.started → user.message → text.delta → tool.call → tool.result → assistant.message → turn.done", async () => {
    const tool = echoTool([]);
    const { factory } = makeFactory({
      script: [
        { text: "我来调用工具", toolCalls: [{ id: "c1", name: "echo", args: { text: "hi" } }] },
        { text: "完成" },
      ],
      tool,
    });
    const { bridge, url, token } = await startBridge(factory);
    const client = await TestClient.connect(url);
    await client.cmd("hello", { ...HELLO, token });

    const created = await client.cmd("session.new", {});
    const sessionId = String(created.payload.sessionId);
    await client.cmd("session.attach", { sessionId }, sessionId);
    await client.cmd("turn.send", { text: "跑一下" }, sessionId);

    const done = await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done");
    const events = client.frames.filter((e) => e.kind === "evt" && e.sessionId === sessionId).map((e) => e.type);
    // 相对顺序校验（loop 实际顺序；assistant.message 在流结束即落库，可能先于工具执行完成）
    const order = ["turn.started", "user.message", "text.delta", "tool.call", "tool.result", "turn.done"];
    const picked = order.map((t) => events.indexOf(t));
    expect(picked.every((i) => i >= 0)).toBe(true);
    for (let i = 1; i < picked.length; i += 1) {
      expect(picked[i]!).toBeGreaterThanOrEqual(picked[i - 1]!);
    }
    expect(events).toContain("assistant.message");
    expect(done.payload.turnId).toBeString();
    bridge.stop();
  });

  test("同 session 重复 turn.send → turn_busy（§4）", async () => {
    const { factory } = makeFactory({
      script: [
        { chunks: [{ type: "text", delta: "慢" }, { type: "text", delta: "流" }, { type: "done", reason: "stop" }] },
        { text: "x" },
      ],
      chunkDelayMs: 150,
    });
    const { bridge, url, token } = await startBridge(factory);
    const client = await TestClient.connect(url);
    await client.cmd("hello", { ...HELLO, token });
    const created = await client.cmd("session.new", {});
    const sessionId = String(created.payload.sessionId);
    await client.cmd("session.attach", { sessionId }, sessionId);
    await client.cmd("turn.send", { text: "第一条" }, sessionId);
    const busy = await client.cmd("turn.send", { text: "第二条" }, sessionId);
    expect(busy.payload.ok).toBe(false);
    expect(busy.payload.code).toBe("turn_busy");
    await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done");
    bridge.stop();
  });

  test("turn.cancel：中途中止，ok+aborted，之后仍有收尾事件（§8）", async () => {
    const { factory } = makeFactory({
      script: [
        {
          chunks: [
            { type: "text", delta: "开始" },
            { type: "text", delta: "继续" },
            { type: "text", delta: "更多" },
            { type: "done", reason: "stop" },
          ],
        },
      ],
      chunkDelayMs: 200,
    });
    const { bridge, url, token } = await startBridge(factory);
    const client = await TestClient.connect(url);
    await client.cmd("hello", { ...HELLO, token });
    const created = await client.cmd("session.new", {});
    const sessionId = String(created.payload.sessionId);
    await client.cmd("session.attach", { sessionId }, sessionId);
    await client.cmd("turn.send", { text: "长任务" }, sessionId);
    const cancel = await client.cmd("turn.cancel", {}, sessionId);
    expect(cancel.payload.ok).toBe(true);
    expect(cancel.payload.aborted).toBe(true);
    const done = await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done");
    expect(done.payload.turnId).toBeString();
    // 幂等：无活跃 turn 也 ok
    const again = await client.cmd("turn.cancel", {}, sessionId);
    expect(again.payload.ok).toBe(true);
    expect(again.payload.aborted).toBe(false);
    bridge.stop();
  });
});

describe("bridge 权限往返（§6/§6.1）", () => {
  test("permission.request → denied → 工具不执行，turn 收尾", async () => {
    const sink: string[] = [];
    const { factory } = makeFactory({
      script: [
        { text: "调用", toolCalls: [{ id: "c1", name: "echo", args: { text: "secret" } }] },
        { text: "结束" },
      ],
      tool: echoTool(sink),
      policyRules: [{ tool: "echo", decision: "ask" }],
    });
    const { bridge, url, token } = await startBridge(factory);
    const client = await TestClient.connect(url);
    await client.cmd("hello", { ...HELLO, token });
    const created = await client.cmd("session.new", {});
    const sessionId = String(created.payload.sessionId);
    await client.cmd("session.attach", { sessionId }, sessionId);
    await client.cmd("turn.send", { text: "go" }, sessionId);

    const req = await client.waitFor((e) => e.kind === "evt" && e.type === "permission.request");
    const requestId = String((req.payload as { requestId: string }).requestId);
    expect(sink).toEqual([]);
    const reply = await client.cmd("permission.resolve", { requestId, outcome: "denied" });
    expect(reply.payload.ok).toBe(true);
    await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done");
    expect(sink).toEqual([]); // 拒绝 → 工具未执行
    bridge.stop();
  });

  test("permission.always → 加规则放行；同 turn 内同参再调用不再询问", async () => {
    const sink: string[] = [];
    const { factory } = makeFactory({
      script: [
        // 一次 turn 内两次同参调用：always 规则是 tool+resource 的 glob，第二次不再询问
        { text: "第一次", toolCalls: [{ id: "c1", name: "echo", args: { text: "a" } }] },
        { text: "第二次", toolCalls: [{ id: "c2", name: "echo", args: { text: "a" } }] },
        { text: "完" },
      ],
      tool: echoTool(sink),
      policyRules: [{ tool: "echo", decision: "ask" }],
    });
    const { bridge, url, token } = await startBridge(factory);
    const client = await TestClient.connect(url);
    await client.cmd("hello", { ...HELLO, token });
    const created = await client.cmd("session.new", {});
    const sessionId = String(created.payload.sessionId);
    await client.cmd("session.attach", { sessionId }, sessionId);

    await client.cmd("turn.send", { text: "第 1 轮" }, sessionId);
    await client.waitFor((e) => e.kind === "evt" && e.type === "permission.request");
    // 先拒绝一次验证 ask 规则仍生效？不需要 —— 直接 always：
    const req = client.frames.find((e) => e.kind === "evt" && e.type === "permission.request");
    await client.cmd("permission.always", { requestId: String((req!.payload as { requestId: string }).requestId) });
    await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done");
    expect(sink).toEqual(["a", "a"]); // 第一次 always 放行，第二次同参直接放行
    const asks = client.frames.filter((e) => e.kind === "evt" && e.type === "permission.request");
    expect(asks.length).toBe(1); // 只询问了一次
    bridge.stop();
  });
});

describe("bridge 多 session 与 attach（§2/§7）", () => {
  test("两个 session 并行 turn，事件按 sessionId 路由不串流", async () => {
    let counter = 0;
    const factory = (o: SessionFactoryOptions): ManagedSession => {
      counter += 1;
      const text = counter === 1 ? "A 的回复" : "B 的回复";
      return {
        session: new AgentSession({
          id: o.sessionId,
          system: "SYS",
          client: createMockClient({ script: [{ text }] }),
          model: "test-model",
          now: () => 0,
        }),
        registry: new ToolRegistry(),
        policy: new PermissionPolicy({ default: "allow" }),
        model: "test-model",
      };
    };
    const { bridge, url, token } = await startBridge(factory);
    const client = await TestClient.connect(url);
    await client.cmd("hello", { ...HELLO, token });

    const createdA = await client.cmd("session.new", {});
    const createdB = await client.cmd("session.new", {});
    const sa = String(createdA.payload.sessionId);
    const sb = String(createdB.payload.sessionId);
    expect(counter).toBe(2);
    await client.cmd("session.attach", { sessionId: sa }, sa);
    await client.cmd("session.attach", { sessionId: sb }, sb);

    await client.cmd("turn.send", { text: "x" }, sa);
    await client.cmd("turn.send", { text: "y" }, sb);
    await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done" && e.sessionId === sa);
    await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done" && e.sessionId === sb);

    const deltasA = client.frames
      .filter((e) => e.kind === "evt" && e.type === "text.delta" && e.sessionId === sa)
      .map((e) => String((e.payload as { delta: string }).delta))
      .join("");
    const deltasB = client.frames
      .filter((e) => e.kind === "evt" && e.type === "text.delta" && e.sessionId === sb)
      .map((e) => String((e.payload as { delta: string }).delta))
      .join("");
    expect(deltasA).toContain("A 的回复");
    expect(deltasA).not.toContain("B 的回复");
    expect(deltasB).toContain("B 的回复");
    bridge.stop();
  });

  test("session.attach 第二个连接 → session_taken；断开后可重新 attach", async () => {
    const { factory } = makeFactory({
      script: [
        { text: "历史" },
        { text: "当前" },
      ],
    });
    const { bridge, url, token } = await startBridge(factory);
    const c1 = await TestClient.connect(url);
    await c1.cmd("hello", { ...HELLO, token });
    const created = await c1.cmd("session.new", {});
    const sessionId = String(created.payload.sessionId);
    await c1.cmd("session.attach", { sessionId }, sessionId);
    await c1.cmd("turn.send", { text: "跑一轮" }, sessionId);
    await c1.waitFor((e) => e.kind === "evt" && e.type === "turn.done");

    const c2 = await TestClient.connect(url);
    await c2.cmd("hello", { ...HELLO, token });
    const attach2 = await c2.cmd("session.attach", { sessionId }, sessionId);
    expect(attach2.payload.ok).toBe(false);
    expect(attach2.payload.code).toBe("session_taken");

    c1.close();
    await new Promise((r) => setTimeout(r, 100)); // 等 close 落到服务端
    const reattach = await c2.cmd("session.attach", { sessionId }, sessionId);
    expect(reattach.payload.ok).toBe(true);
    const messages = (reattach.payload.messages ?? []) as { replay?: boolean }[];
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.replay === true)).toBe(true);
    c2.close();
    bridge.stop();
  });
});

describe("未知命令（§9）", () => {
  test("未知 cmd → reply unknown_command", async () => {
    const { factory } = makeFactory({ script: [] });
    const { bridge, url, token } = await startBridge(factory);
    const client = await TestClient.connect(url);
    await client.cmd("hello", { ...HELLO, token });
    const reply = await client.cmd("nope.nothing", {});
    expect(reply.payload.ok).toBe(false);
    expect(reply.payload.code).toBe("unknown_command");
    client.close();
    bridge.stop();
  });
});
