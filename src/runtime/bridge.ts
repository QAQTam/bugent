/** bugent headless runtime bridge（docs/ui-protocol-spec.md §2-§8）。
 *  单一 WebSocket 端点 ws://127.0.0.1:<port>/ws，Bun.serve 承载；一个连接承载多个 session。
 *  LoopHooks → 协议事件的映射是 §5 注册表的规范性实现（不改 loop）。
 *
 *  会话组装通过 createSession 工厂注入：Electron / CLI 侧按 src/index.ts 的完整装配
 *  （provider、default tools、store）提供工厂；缺省工厂用 mock provider（headless 演示/测试）。 */

import {
  combineHooks,
  runUserTurn,
  type LoopHooks,
  type TurnResult,
} from "../core/loop";
import { AgentSession, type SessionInit } from "../core/session";
import type { StoredMessage } from "../core/message";
import { storedText } from "../core/message";
import { createMockClient } from "../provider/adapters/mock";
import type { ToolRegistry } from "../tools/types";
import type { ToolCall } from "../provider/types";
import { PermissionGate } from "../permission/gate";
import { PermissionPolicy } from "../permission/policy";
import type { PermissionRequest } from "../permission/policy";
import type { AskUserAnswer } from "../tui/ask-user";
import type { AuthorizationOutcome } from "../permission/authorization";
import type { SandboxMode } from "../permission/mode";
import { join } from "node:path";
import { UI_PROTOCOL_VERSION, type UiEnvelope, type UiReplyPayload } from "../protocol/types";

// ---------- 会话工厂（协议侧接入点） ----------

/** 工厂返回组装好的一个会话。gate 由 bridge 统一构造（prompter 走协议往返），
 *  工厂不要自己 setGate。 */
export interface ManagedSession {
  session: AgentSession;
  registry?: ToolRegistry;
  /** bridge 会用它构造 PermissionGate；缺省 ALLOW_ALL 语义（default: "allow"）。 */
  policy?: PermissionPolicy;
  mode?: SandboxMode;
  hooks?: LoopHooks;
  title?: string;
  model?: string;
  providerId?: string;
}

export interface SessionFactoryOptions {
  sessionId: string;
  cwd: string;
}

export type SessionFactory = (options: SessionFactoryOptions) => ManagedSession | Promise<ManagedSession>;

export interface BridgeOptions {
  port?: number;
  /** 服务端 token（§2）；缺省随机生成，通过 BridgeInfo 返回给宿主（Electron / dev stdout）。 */
  token?: string;
  cwd?: string;
  createSession?: SessionFactory;
  /** 非升级请求时按 SPA 静态目录伺服（webui/dist）；缺省不伺服，仅返回 426。 */
  staticDir?: string;
}

export interface BridgeInfo {
  port: number;
  url: string;
  token: string;
}

// ---------- 内部结构 ----------

interface PendingPermission {
  resolve: (outcome: AuthorizationOutcome) => void;
  request: PermissionRequest;
}

interface BridgeSession {
  id: string;
  cwd: string;
  title?: string | undefined;
  model: string;
  providerId?: string | undefined;
  session: AgentSession;
  registry?: ToolRegistry | undefined;
  policy: PermissionPolicy;
  activeTurn: boolean;
  turnId?: string | undefined;
  abort?: AbortController | undefined;
  pendingPermission: Map<string, PendingPermission>;
  pendingAsk: Map<string, (answers: AskUserAnswer[] | undefined) => void>;
  pendingFallback: Map<string, (allow: boolean) => void>;
  /** 已 attach 的连接序号集合（每个 session 同时只允许一个连接 attach，§7）。 */
  attachedTo: Set<number>;
}

interface BridgeConn {
  serial: number;
  ws: { send(data: string): void; close(code?: number): void };
  authorized: boolean;
  attached: Set<string>;
}

type WsData = string | Uint8Array;

export class Bridge {
  #sessions = new Map<string, BridgeSession>();
  #conns = new Map<number, BridgeConn>();
  #server: ReturnType<typeof Bun.serve> | undefined;
  #serial = 0;
  readonly token: string;
  readonly cwd: string;
  readonly #factory: SessionFactory;
  readonly #staticDir: string | undefined;
  readonly #port: number;

  constructor(options: BridgeOptions = {}) {
    this.token = options.token ?? crypto.randomUUID().replaceAll("-", "");
    this.cwd = options.cwd ?? process.cwd();
    this.#factory = options.createSession ?? defaultSessionFactory;
    this.#staticDir = options.staticDir;
    this.#port = options.port ?? 0;
  }

  async start(): Promise<BridgeInfo> {
    const bridge = this;
    const server = Bun.serve<{ serial: number }>({
      port: this.#port, // 0 = 随机端口；WebUI 入口默认随机，避免 dev 冲突
      hostname: "127.0.0.1", // 仅绑定回环（§2）
      fetch(req, server) {
        // WebSocket 升级：把连接序号放进 ws.data，供 open/message/close 定位连接
        if (server.upgrade(req, { data: { serial: ++bridge.#serial } })) return;
        if (bridge.#staticDir !== undefined) return bridge.#serveStatic(req);
        return new Response("bugent bridge: WebSocket only", { status: 426 });
      },
      websocket: {
        open(ws) {
          const { serial } = ws.data as { serial: number };
          bridge.#conns.set(serial, {
            serial,
            ws,
            authorized: false,
            attached: new Set(),
          });
        },
        message(ws, raw) {
          const conn = bridge.#conns.get((ws.data as { serial: number }).serial);
          if (conn) bridge.#handleMessage(conn, raw as WsData);
        },
        close(ws) {
          const conn = bridge.#conns.get((ws.data as { serial: number }).serial);
          if (conn) bridge.#dropConn(conn);
        },
      },
    });
    this.#server = server;
    return { port: server.port ?? 0, url: `ws://127.0.0.1:${server.port ?? 0}/ws`, token: this.token };
  }

  stop(): void {
    this.#server?.stop(true);
    this.#conns.clear();
    this.#sessions.clear();
  }

  /** 供测试/宿主检查运行中的 session。 */
  getSession(sessionId: string): BridgeSession | undefined {
    return this.#sessions.get(sessionId);
  }

  /** SPA 静态伺服：命中文件直接回，未命中回 index.html（前端路由/刷新不 404）。 */
  async #serveStatic(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/ws" && url.pathname.startsWith("/ws")) {
      return new Response("WebSocket endpoint is /ws", { status: 426 });
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const root = this.#staticDir!;
    const candidate = rel === "" ? "index.html" : rel;
    const resolved = join(root, candidate);
    if (resolved.startsWith(root) && (await Bun.file(resolved).exists())) {
      return new Response(Bun.file(resolved));
    }
    const index = join(root, "index.html");
    if (await Bun.file(index).exists()) return new Response(Bun.file(index));
    return new Response("webui 未构建：先运行 `bun run webui:build`", { status: 404 });
  }

  // ---------- 连接生命周期 ----------

  #dropConn(conn: BridgeConn): void {
    for (const sessionId of conn.attached) {
      this.#sessions.get(sessionId)?.attachedTo.delete(conn.serial);
    }
    // 断连：挂起的 permission/ask_user Promise 以 denied 处理（§6），比永久挂起安全
    for (const session of this.#sessions.values()) {
      for (const pending of session.pendingPermission.values()) pending.resolve("denied");
      session.pendingPermission.clear();
      for (const resolve of session.pendingAsk.values()) resolve(undefined);
      session.pendingAsk.clear();
      for (const resolve of session.pendingFallback.values()) resolve(false);
      session.pendingFallback.clear();
    }
    this.#conns.delete(conn.serial);
  }

  // ---------- 消息处理 ----------

  #handleMessage(conn: BridgeConn, raw: WsData): void {
    let env: UiEnvelope;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      env = JSON.parse(text) as UiEnvelope;
    } catch {
      this.#sendError(conn, { code: "bad_frame", message: "消息不是合法 JSON" }, true);
      return;
    }
    // 握手：必须是首条消息（§2）
    if (!conn.authorized) {
      this.#handleHello(conn, env);
      return;
    }
    if (env.kind !== "cmd") return; // UI 不该发 evt/reply；静默忽略
    const payload = (env.payload ?? {}) as Record<string, unknown>;
    switch (env.type) {
      case "hello":
        this.#reply(conn, env, { ok: true, version: UI_PROTOCOL_VERSION });
        return;
      case "session.list":
        this.#reply(conn, env, { ok: true, sessions: this.#listSessions() });
        return;
      case "session.new":
        void this.#cmdSessionNew(conn, env, payload);
        return;
      case "session.attach":
        this.#cmdSessionAttach(conn, env, payload);
        return;
      case "session.close":
        this.#cmdSessionClose(conn, env, payload);
        return;
      case "turn.send":
        this.#cmdTurnSend(conn, env, payload);
        return;
      case "turn.cancel":
        this.#cmdTurnCancel(conn, env);
        return;
      case "permission.resolve":
        this.#cmdPermissionResolve(conn, env, payload);
        return;
      case "permission.always":
        this.#cmdPermissionAlways(conn, env, payload);
        return;
      case "ask_user.answer":
        this.#cmdAskUserAnswer(conn, env, payload);
        return;
      case "extension_role.fallback":
        this.#cmdExtensionRoleFallback(conn, env, payload);
        return;
      default:
        this.#reply(conn, env, { ok: false, code: "unknown_command", message: `未知命令 ${env.type}` } satisfies UiReplyPayload);
    }
  }

  #handleHello(conn: BridgeConn, env: UiEnvelope): void {
    if (env.kind !== "cmd" || env.type !== "hello") {
      this.#sendError(conn, { code: "unauthorized", message: "首条消息必须是 hello" }, true);
      return;
    }
    const payload = (env.payload ?? {}) as { token?: string; protocolVersions?: number[] };
    if (payload.token !== this.token) {
      this.#sendError(conn, { code: "unauthorized", message: "token 错误" }, true);
      return;
    }
    const versions = (payload.protocolVersions ?? []).filter((v) => v === UI_PROTOCOL_VERSION);
    if (versions.length === 0) {
      this.#sendError(conn, { code: "version_mismatch", message: "协议版本无交集" }, true);
      return;
    }
    conn.authorized = true;
    this.#reply(conn, env, { ok: true, version: UI_PROTOCOL_VERSION });
  }

  // ---------- 命令实现 ----------

  #listSessions(): Record<string, unknown>[] {
    return [...this.#sessions.values()].map((s) => ({
      sessionId: s.id,
      title: s.title ?? firstUserText(s.session) ?? "",
      cwd: s.cwd,
      mode: s.registry ? "sandboxed" : "none",
      providerId: s.providerId,
      model: s.model,
      activeTurn: s.activeTurn,
    }));
  }

  async #cmdSessionNew(conn: BridgeConn, env: UiEnvelope, payload: Record<string, unknown>): Promise<void> {
    const sessionId = `s-${crypto.randomUUID()}`;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : this.cwd;
    const managed = await this.#factory({ sessionId, cwd });
    const bs = this.#adopt(sessionId, cwd, managed, typeof payload.title === "string" ? payload.title : undefined);
    this.#reply(conn, env, {
      ok: true,
      sessionId,
      ...this.#sessionItem(bs),
    });
  }

  #adopt(sessionId: string, cwd: string, managed: ManagedSession, title?: string): BridgeSession {
    const policy = managed.policy ?? new PermissionPolicy({ default: "allow" });
    const bs: BridgeSession = {
      id: sessionId,
      cwd,
      title,
      model: managed.model ?? managed.session.model,
      providerId: managed.providerId,
      session: managed.session,
      registry: managed.registry,
      policy,
      activeTurn: false,
      pendingPermission: new Map(),
      pendingAsk: new Map(),
      pendingFallback: new Map(),
      attachedTo: new Set(),
    };
    // gate 由 bridge 统一构造：prompter / 升档都走协议往返（§6 往返语义）
    if (managed.registry) {
      const gate = new PermissionGate({
        policy,
        mode: managed.mode ?? "workspace-write",
        prompter: { ask: (request) => this.#askPermission(bs, request) },
        onEscalate: (request) => this.#askPermission(bs, request),
      });
      managed.registry.setGate(gate);
    }
    if (managed.hooks !== undefined) managedHooksCache.set(bs, managed.hooks);
    this.#sessions.set(sessionId, bs);
    return bs;
  }

  /** 权限往返（§6）：发 permission.request，挂起 Promise；超时结论 v0 不做。 */
  #askPermission(bs: BridgeSession, request: PermissionRequest): Promise<AuthorizationOutcome> {
    const requestId = `r-${crypto.randomUUID()}`;
    return new Promise<AuthorizationOutcome>((resolve) => {
      bs.pendingPermission.set(requestId, { resolve, request });
      this.#evt(bs, "permission.request", { requestId, request });
    }).finally(() => {
      bs.pendingPermission.delete(requestId);
    });
  }

  #cmdSessionAttach(conn: BridgeConn, env: UiEnvelope, payload: Record<string, unknown>): void {
    const sessionId = String(payload.sessionId ?? "");
    const bs = this.#sessions.get(sessionId);
    if (!bs) {
      this.#reply(conn, env, { ok: false, code: "no_session", message: `session 不存在: ${sessionId}` });
      return;
    }
    if (bs.attachedTo.size > 0 && !bs.attachedTo.has(conn.serial)) {
      this.#reply(conn, env, { ok: false, code: "session_taken", message: "该 session 已被其他连接 attach" });
      return;
    }
    bs.attachedTo.add(conn.serial);
    conn.attached.add(sessionId);
    // 全量历史 + replay 标记（§7）：回放消息不触发动画/音效，UI 从 message 里取 presentation
    const messages = bs.session.messages.map((m) => ({ ...m, replay: true }));
    this.#reply(conn, env, { ok: true, messages, replay: true });
  }

  #cmdSessionClose(conn: BridgeConn, env: UiEnvelope, payload: Record<string, unknown>): void {
    const sessionId = String(payload.sessionId ?? "");
    const bs = this.#sessions.get(sessionId);
    if (bs) {
      if (bs.activeTurn) bs.abort?.abort(); // 活跃 turn 先 cancel 再释放（§4）
      for (const pending of bs.pendingPermission.values()) pending.resolve("denied");
      bs.pendingPermission.clear();
      bs.attachedTo.clear();
      this.#sessions.delete(sessionId);
    }
    conn.attached.delete(sessionId);
    this.#reply(conn, env, { ok: true });
  }

  #cmdTurnSend(conn: BridgeConn, env: UiEnvelope, payload: Record<string, unknown>): void {
    const bs = this.#requireSession(conn, env);
    if (!bs) return;
    if (payload.attachments !== undefined) {
      this.#reply(conn, env, { ok: false, code: "not_implemented", message: "附件通道未实现" });
      return;
    }
    if (bs.activeTurn) {
      this.#reply(conn, env, { ok: false, code: "turn_busy", message: "当前会话已有活跃 turn" });
      return;
    }
    const text = String(payload.text ?? "");
    const turnId = `t-${crypto.randomUUID()}`;
    const abort = new AbortController();
    bs.activeTurn = true;
    bs.turnId = turnId;
    bs.abort = abort;
    this.#reply(conn, env, { ok: true, turnId });
    this.#evt(bs, "turn.started", { turnId });
    const hooks = this.#buildHooks(bs, turnId);
    void runUserTurn(bs.session, text, {
      ...(bs.registry ? { tools: bs.registry } : {}),
      hooks: combineHooks(hooks, managedHooksCache.get(bs) ?? {}),
      cwd: bs.cwd,
      signal: abort.signal,
    })
      .then((result: TurnResult) => {
        this.#evt(bs, "turn.done", { turnId, result });
      })
      .catch((err: unknown) => {
        this.#evt(bs, "turn.error", { turnId, message: err instanceof Error ? err.message : String(err) });
        // §5：turn.error 之后必须有 turn.done 或连接级 error
        this.#evt(bs, "turn.done", {
          turnId,
          result: { text: "", toolCalls: [], steps: 0, reason: "error", usage: null },
        });
      })
      .finally(() => {
        bs.activeTurn = false;
        bs.turnId = undefined;
      });
  }

  #cmdTurnCancel(conn: BridgeConn, env: UiEnvelope): void {
    const bs = this.#requireSession(conn, env);
    if (!bs) return;
    const aborted = bs.activeTurn;
    bs.abort?.abort(); // 幂等：无活跃 turn 也返回 ok（§4）
    this.#reply(conn, env, { ok: true, aborted });
  }

  #cmdPermissionResolve(conn: BridgeConn, env: UiEnvelope, payload: Record<string, unknown>): void {
    const requestId = String(payload.requestId ?? "");
    const outcome = payload.outcome === "approved" ? "approved" : "denied";
    for (const bs of this.#sessions.values()) {
      const pending = bs.pendingPermission.get(requestId);
      if (pending) {
        pending.resolve(outcome);
        this.#reply(conn, env, { ok: true });
        return;
      }
      // capability / ask_user 的往返复用 permission.resolve（§6：同一模式）
      if (bs.pendingAsk.has(requestId)) {
        bs.pendingAsk.get(requestId)!(undefined);
        bs.pendingAsk.delete(requestId);
        this.#reply(conn, env, { ok: true });
        return;
      }
      if (bs.pendingFallback.has(requestId)) {
        bs.pendingFallback.get(requestId)!(outcome === "approved");
        bs.pendingFallback.delete(requestId);
        this.#reply(conn, env, { ok: true });
        return;
      }
    }
    this.#reply(conn, env, { ok: false, code: "no_request", message: `requestId 不存在: ${requestId}` });
  }

  /** "总是允许"（§6.1）：把该 request 的 tool(+resource) 追加为 session 级 allow 规则，
   *  然后按 approved 继续本次调用。规则只活在当前 session 进程内。 */
  #cmdPermissionAlways(conn: BridgeConn, env: UiEnvelope, payload: Record<string, unknown>): void {
    const requestId = String(payload.requestId ?? "");
    for (const bs of this.#sessions.values()) {
      const pending = bs.pendingPermission.get(requestId);
      if (pending) {
        bs.policy.addRule({
          tool: pending.request.tool,
          ...(pending.request.resource !== undefined ? { resource: pending.request.resource } : {}),
          decision: "allow",
        });
        pending.resolve("approved");
        this.#reply(conn, env, { ok: true });
        return;
      }
    }
    this.#reply(conn, env, { ok: false, code: "no_request", message: `requestId 不存在: ${requestId}` });
  }

  #cmdAskUserAnswer(conn: BridgeConn, env: UiEnvelope, payload: Record<string, unknown>): void {
    const requestId = String(payload.requestId ?? "");
    for (const bs of this.#sessions.values()) {
      const resolve = bs.pendingAsk.get(requestId);
      if (resolve) {
        bs.pendingAsk.delete(requestId);
        resolve(payload.abort === true ? undefined : ((payload.answers ?? []) as AskUserAnswer[]));
        this.#reply(conn, env, { ok: true });
        return;
      }
    }
    this.#reply(conn, env, { ok: false, code: "no_request", message: `requestId 不存在: ${requestId}` });
  }

  #cmdExtensionRoleFallback(conn: BridgeConn, env: UiEnvelope, payload: Record<string, unknown>): void {
    const requestId = String(payload.requestId ?? "");
    for (const bs of this.#sessions.values()) {
      const resolve = bs.pendingFallback.get(requestId);
      if (resolve) {
        bs.pendingFallback.delete(requestId);
        resolve(payload.allow === true);
        this.#reply(conn, env, { ok: true });
        return;
      }
    }
    this.#reply(conn, env, { ok: false, code: "no_request", message: `requestId 不存在: ${requestId}` });
  }

  // ---------- LoopHooks → 协议事件（§5 注册表，规范性映射） ----------

  #buildHooks(bs: BridgeSession, turnId: string): LoopHooks {
    const managed = managedHooksCache.get(bs);
    return {
      onUser: (message) => this.#evt(bs, "user.message", { message: plainMessage(message) }),
      onText: (delta) => this.#evt(bs, "text.delta", { delta }),
      onReasoning: (delta) => this.#evt(bs, "reasoning.delta", { delta }), // 不落库，UI 不得持久化
      onAssistant: (message) => this.#evt(bs, "assistant.message", { message: plainMessage(message) }),
      onToolCallDelta: (delta) => this.#evt(bs, "tool.call_delta", { ...delta }),
      onToolCall: (call) => {
        this.#evt(bs, "tool.call", { call });
        this.#deriveTodoState(bs, call);
      },
      onToolProgress: (call, chunk, stream) => this.#evt(bs, "tool.progress", { call, chunk, stream }),
      onToolResult: (call, result, message) => {
        this.#evt(bs, "tool.result", {
          call,
          result,
          ...(message !== undefined ? { message: plainMessage(message) } : {}),
        });
        // workspace.change：ToolCtx.onWorkspaceChange 的等价投影 —— 从 ToolExecution.workspace
        // 取本次修改（undo 输入），UI 只做"已修改"标记（§5）
        const edits = result.workspace;
        if (edits !== undefined && edits.length > 0) {
          this.#evt(bs, "workspace.change", { edit: edits[edits.length - 1] });
        }
      },
      onRequestCapability: (call, escalation) => {
        const requestId = `r-${crypto.randomUUID()}`;
        return new Promise<AuthorizationOutcome>((resolve) => {
          bs.pendingPermission.set(requestId, {
            resolve,
            request: { tool: call.name, resource: "", summary: escalation.reason },
          });
          this.#evt(bs, "capability.request", { requestId, call, escalation });
        }).finally(() => {
          bs.pendingPermission.delete(requestId);
        });
      },
      onAskUser: (call, questions) => {
        const requestId = `r-${crypto.randomUUID()}`;
        return new Promise<AskUserAnswer[] | undefined>((resolve) => {
          bs.pendingAsk.set(requestId, resolve);
          this.#evt(bs, "ask_user.request", { requestId, call, questions });
        }).finally(() => {
          bs.pendingAsk.delete(requestId);
        });
      },
      onUsage: (usage) => this.#evt(bs, "usage", { usage }),
      onExtensionRoleFallback: (error) => {
        const requestId = `r-${crypto.randomUUID()}`;
        return new Promise<boolean>((resolve) => {
          bs.pendingFallback.set(requestId, resolve);
          this.#evt(bs, "extension_role.fallback_request", { requestId, error: error instanceof Error ? error.message : String(error) });
        }).finally(() => {
          bs.pendingFallback.delete(requestId);
        });
      },
      ...(managed ?? {}),
    };
  }

  /** §5 todo.state：非独立 hook，从 todo_write 工具调用的入参派生。 */
  #deriveTodoState(bs: BridgeSession, call: ToolCall): void {
    if (call.name !== "todo_write") return;
    const args = call.args as { todos?: { id?: string; content?: string; status?: string }[] } | null;
    const todos = Array.isArray(args?.todos) ? args!.todos! : [];
    this.#evt(bs, "todo.state", {
      todos: todos.map((t, i) => ({
        id: typeof t.id === "string" ? t.id : `t-${i}`,
        content: String(t.content ?? ""),
        status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending",
      })),
    });
  }

  // ---------- 基础设施 ----------

  #requireSession(conn: BridgeConn, env: UiEnvelope): BridgeSession | undefined {
    const sessionId = env.sessionId ?? "";
    const bs = this.#sessions.get(sessionId);
    if (!bs) {
      this.#reply(conn, env, { ok: false, code: "no_session", message: `session 不存在: ${sessionId}` });
      return undefined;
    }
    return bs;
  }

  #evt(bs: BridgeSession, type: string, payload: Record<string, unknown>): void {
    const env: UiEnvelope = {
      v: UI_PROTOCOL_VERSION,
      id: `e-${crypto.randomUUID()}`,
      kind: "evt",
      type,
      sessionId: bs.id,
      payload,
      ts: Date.now(),
    };
    const data = JSON.stringify(env);
    for (const conn of this.#conns.values()) {
      if (conn.authorized && conn.attached.has(bs.id)) conn.ws.send(data);
    }
  }

  #reply(conn: BridgeConn, cmd: UiEnvelope, payload: UiReplyPayload): void {
    const env: UiEnvelope = {
      v: UI_PROTOCOL_VERSION,
      id: cmd.id,
      kind: "reply",
      type: cmd.type,
      sessionId: cmd.sessionId,
      payload,
      ts: Date.now(),
    };
    conn.ws.send(JSON.stringify(env));
  }

  #sendError(
    conn: BridgeConn,
    payload: { code: string; message: string; fatal?: boolean },
    close: boolean,
  ): void {
    const env: UiEnvelope = {
      v: UI_PROTOCOL_VERSION,
      id: `e-${crypto.randomUUID()}`,
      kind: "evt",
      type: "error",
      payload,
      ts: Date.now(),
    };
    try {
      conn.ws.send(JSON.stringify(env));
    } catch {
      /* 连接已坏 */
    }
    if (close) conn.ws.close(4401);
  }

  #sessionItem(bs: BridgeSession): Record<string, unknown> {
    return {
      title: bs.title ?? firstUserText(bs.session) ?? "",
      cwd: bs.cwd,
      mode: bs.registry ? "sandboxed" : "none",
      providerId: bs.providerId,
      model: bs.model,
      activeTurn: bs.activeTurn,
    };
  }
}

/** 工厂 hooks 的临时寄存处（bridge 构造 hooks 时并入，display 类广播、交互类以 bridge 为准）。 */
const managedHooksCache = new WeakMap<BridgeSession, LoopHooks>();

function plainMessage(m: StoredMessage): StoredMessage {
  return m; // StoredMessage 是冻结的纯数据结构，可直接序列化
}

function firstUserText(session: AgentSession): string | undefined {
  for (const m of session.messages) {
    if (m.role === "user") return storedText(m).slice(0, 20);
  }
  return undefined;
}

/** 缺省会话工厂：mock provider + 空工具集（headless 演示与测试用）。 */
export const defaultSessionFactory: SessionFactory = ({ sessionId }) => {
  const session = new AgentSession({
    id: sessionId,
    system: "You are a helpful assistant.",
    client: createMockClient({ script: [] }),
    model: "mock",
  } satisfies SessionInit);
  return { session, model: "mock", providerId: "mock" };
};
