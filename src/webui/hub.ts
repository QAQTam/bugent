/**
 * WebUI v2 协议 hub —— 信封路由、seq/事件日志、lastSeq 补发、心跳与慢消费者
 * （docs/webui-v2-protocol-spec.md §3/§8/§9）。
 *
 * hub 不认识 AgentSession：只跟 SessionDelegate 打交道，领域语义全部在
 * session-host（同目录）里。协议机（seq、环形日志、补发、幂等缓存、背压）
 * 因此可以脱离 agent 单独测试。
 *
 * 关键不变量：
 *   - seq 由 publish 分配，先入日志再推送（B1/B2）——推出去的一定已在日志里；
 *   - attach 全程同步（快照 -> reply -> 补发 -> 订阅），publish 无法插进来，
 *     快照 lastSeq 与补发/直播因此无缝（B6）；
 *   - 任何订阅者的发送都不阻塞 agent：超限直接断开（1013）让它重连（A7）。
 */

import type { ServerWebSocket, WebSocketHandler } from "bun";
import type {
  AskUserAnswerPayload,
  GoalSummary,
  MsgId,
  PendingInteraction,
  SessionDraft,
  SessionInfo,
  SessionSnapshot,
  StoredMessage,
  UiEnvelope,
  UiEvent,
  UiReplyPayload,
} from "../protocol/types.ts";
import { UI_PROTOCOL_VERSION } from "../protocol/types.ts";

/** hub 对一个 session 的全部认知；agent 实现见 session-host.ts。 */
export interface SessionDelegate {
  readonly id: string;
  info(): SessionInfo;
  goalSummary(): GoalSummary | null;
  pending(): readonly PendingInteraction[];
  draft(): SessionDraft | null;
  /** 尾部窗口（attach 快照用）。 */
  history(): { messages: readonly StoredMessage[]; hasMore: boolean };
  historyBefore(
    beforeMsgId: MsgId,
    limit: number,
  ): { messages: readonly StoredMessage[]; hasMore: boolean };
  sendTurn(text: string): UiReplyPayload;
  cancelTurn(): { aborted: boolean };
  /** false = 已被解决（hub 回 already_resolved；A5 first-wins）。 */
  resolvePermission(requestId: string, outcome: "approved" | "denied"): boolean;
  /** 回包语义更丰富（not_allowed / already_resolved），host 直接给 reply 载荷。 */
  alwaysAllow(requestId: string): UiReplyPayload;
  answerAskUser(payload: AskUserAnswerPayload): boolean;
  resolveExtensionRole(requestId: string, allow: boolean): boolean;
  /** 订阅者数量变化；0 = 无人再看，host 据此给挂起请求默认结论（§6.3）。 */
  onWatchers(count: number): void;
  close(): void;
}

export interface WebuiHubOptions {
  token: string;
  /** `session.new` 的工厂；缺省时该命令回 not_implemented。 */
  sessionFactory?: (options: { cwd?: string; title?: string }) => Promise<SessionDelegate> | SessionDelegate;
  /** 应用层心跳间隔（ms）；0 关闭（测试用）。 */
  heartbeatMs?: number;
  /** 每 session 事件日志窗口（条）。 */
  logCapacity?: number;
  /** attach 快照尾部消息条数（§7）。 */
  historyTail?: number;
}

interface ConnData {
  hub: WebuiHub;
  authenticated: boolean;
  attached: Set<string>;
}

type Ws = ServerWebSocket<ConnData>;

interface LogEntry {
  seq: number;
  frame: string;
}

const DEFAULT_LOG_CAPACITY = 4096;
const DEFAULT_HISTORY_TAIL = 200;
const DEFAULT_HEARTBEAT_MS = 30_000;
/** 单连接发送缓冲上限（字节）；超过即判慢消费者（A7）。 */
const MAX_BUFFER_BYTES = 1 << 20;
/** turn.send 幂等缓存条数（B11）。 */
const CMD_CACHE_SIZE = 128;
/** history.before 的 limit 上限（§10）。 */
const MAX_HISTORY_PAGE = 200;

let frameCounter = 0;
function nextFrameId(): string {
  frameCounter += 1;
  return `m-${Date.now().toString(36)}-${frameCounter}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 信封必须带 sessionId 的命令集合（其余要么是协议级命令，要么 unknown_command）。 */
const SESSION_COMMANDS = new Set([
  "session.attach",
  "session.close",
  "turn.send",
  "turn.cancel",
  "permission.resolve",
  "permission.always",
  "ask_user.answer",
  "extension_role.fallback",
  "history.before",
]);

export class WebuiHub {
  /** 直接展开进 Bun.serve 的 websocket 配置。 */
  readonly websocket: WebSocketHandler<ConnData>;

  #token: string;
  #sessionFactory: WebuiHubOptions["sessionFactory"];
  #heartbeatMs: number;
  #logCapacity: number;
  #historyTail: number;
  #sessions = new Map<string, SessionDelegate>();
  #seq = new Map<string, number>();
  #log = new Map<string, LogEntry[]>();
  #subs = new Map<string, Set<Ws>>();
  #cmdCache = new Map<string, Map<string, UiReplyPayload>>();
  #conns = new Set<Ws>();
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: WebuiHubOptions) {
    this.#token = options.token;
    this.#sessionFactory = options.sessionFactory;
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#logCapacity = options.logCapacity ?? DEFAULT_LOG_CAPACITY;
    this.#historyTail = options.historyTail ?? DEFAULT_HISTORY_TAIL;
    this.websocket = {
      open: (ws) => {
        this.#conns.add(ws);
      },
      message: (ws, message) => {
        void this.#onMessage(ws, typeof message === "string" ? message : message.toString("utf8"));
      },
      close: (ws) => {
        this.#onClose(ws);
      },
    };
    if (this.#heartbeatMs > 0) {
      this.#heartbeatTimer = setInterval(() => this.#beat(), this.#heartbeatMs);
      this.#heartbeatTimer.unref?.();
    }
  }

  stop(): void {
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  registerSession(delegate: SessionDelegate): void {
    if (this.#sessions.has(delegate.id)) throw new Error(`session 已注册：${delegate.id}`);
    this.#sessions.set(delegate.id, delegate);
    this.#seq.set(delegate.id, 0);
    this.#log.set(delegate.id, []);
    this.#subs.set(delegate.id, new Set());
    this.#cmdCache.set(delegate.id, new Map());
  }

  /** session.close / 释放后的协议状态清理（连接本身不断开）。 */
  releaseSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
    this.#seq.delete(sessionId);
    this.#log.delete(sessionId);
    this.#subs.delete(sessionId);
    this.#cmdCache.delete(sessionId);
  }

  sessionIds(): string[] {
    return [...this.#sessions.keys()];
  }

  /* ------------------------------ 事件出口 ------------------------------ */

  /**
   * 事件入日志再推送（B2）；seq 在这里分配（B1）。
   * 领域代码只管"有事件"，排序/日志/分发全是 hub 的事。
   */
  publish(sessionId: string, event: UiEvent): void {
    const seq = (this.#seq.get(sessionId) ?? 0) + 1;
    this.#seq.set(sessionId, seq);
    const frame = JSON.stringify({
      v: UI_PROTOCOL_VERSION,
      id: nextFrameId(),
      kind: "evt",
      type: event.type,
      sessionId,
      seq,
      payload: event,
      ts: Date.now(),
    } satisfies UiEnvelope);
    const log = this.#log.get(sessionId);
    if (log !== undefined) {
      log.push({ seq, frame });
      if (log.length > this.#logCapacity) log.splice(0, log.length - this.#logCapacity);
    }
    for (const ws of this.#subs.get(sessionId) ?? []) this.#send(ws, frame);
  }

  /** 测试钩子：当前已分配的最大 seq。 */
  currentSeq(sessionId: string): number {
    return this.#seq.get(sessionId) ?? 0;
  }

  /* ------------------------------ 连接处理 ------------------------------ */

  async #onMessage(ws: Ws, text: string): Promise<void> {
    let env: UiEnvelope;
    try {
      env = JSON.parse(text) as UiEnvelope;
    } catch {
      this.#sendError(ws, "bad_json", "消息不是合法 JSON");
      return;
    }
    if (env?.v !== UI_PROTOCOL_VERSION) {
      this.#sendError(ws, "version_mismatch", `协议版本不符：期望 ${UI_PROTOCOL_VERSION}`, true);
      ws.close(4401, "version mismatch");
      return;
    }
    if (env.kind !== "cmd") {
      this.#sendError(ws, "bad_kind", "客户端只能发 cmd");
      return;
    }
    if (typeof env.id !== "string" || typeof env.type !== "string") {
      this.#sendError(ws, "bad_envelope", "缺少 id / type");
      return;
    }

    if (!ws.data.authenticated) {
      if (env.type !== "hello") {
        this.#sendError(ws, "unauthorized", "首条消息必须是 hello", true);
        ws.close(4401, "unauthorized");
        return;
      }
      const payload = env.payload as { token?: unknown } | undefined;
      if (payload?.token !== this.#token) {
        this.#sendError(ws, "unauthorized", "token 不正确", true);
        ws.close(4401, "unauthorized");
        return;
      }
      ws.data.authenticated = true;
      this.#reply(ws, env, { ok: true, version: UI_PROTOCOL_VERSION });
      return;
    }

    const reply = await this.#dispatch(ws, env);
    // attach 自己已经回过（reply -> 补发 -> 订阅的顺序不能倒）
    if (reply !== undefined) this.#reply(ws, env, reply);
  }

  #onClose(ws: Ws): void {
    this.#conns.delete(ws);
    for (const sessionId of ws.data.attached) {
      const subs = this.#subs.get(sessionId);
      if (subs !== undefined) {
        subs.delete(ws);
        this.#sessions.get(sessionId)?.onWatchers(subs.size);
      }
    }
    ws.data.attached.clear();
  }

  async #dispatch(ws: Ws, env: UiEnvelope): Promise<UiReplyPayload | undefined> {
    switch (env.type) {
      case "hello":
        return { ok: false, code: "already_authenticated", message: "已通过认证" };

      case "session.list":
        return {
          ok: true,
          sessions: this.sessionIds().map((id) => this.#sessions.get(id)!.info()),
        };

      case "session.new": {
        if (this.#sessionFactory === undefined) {
          return { ok: false, code: "not_implemented", message: "本 hub 未配置 session 工厂" };
        }
        const payload = env.payload as { cwd?: unknown; title?: unknown } | undefined;
        try {
          const delegate = await this.#sessionFactory({
            ...(typeof payload?.cwd === "string" ? { cwd: payload.cwd } : {}),
            ...(typeof payload?.title === "string" ? { title: payload.title } : {}),
          });
          // 工厂产出由 hub 统一登记（工厂内部不要再 registerSession）
          this.registerSession(delegate);
          const info = delegate.info();
          return { ok: true, ...info };
        } catch (error) {
          return { ok: false, code: "session_create_failed", message: errorMessage(error) };
        }
      }
    }

    // ---- 以下都是 session 级命令：先认 type 再要 sessionId（未知命令如实上报）----
    if (!SESSION_COMMANDS.has(env.type)) {
      return { ok: false, code: "unknown_command", message: `未知命令：${env.type}` };
    }
    const sessionId = env.sessionId;
    if (typeof sessionId !== "string") {
      return { ok: false, code: "missing_session", message: `${env.type} 需要sessionId` };
    }
    const delegate = this.#sessions.get(sessionId);
    if (delegate === undefined) {
      return { ok: false, code: "unknown_session", message: `未知 session：${sessionId}` };
    }

    switch (env.type) {
      case "session.attach": {
        const payload = env.payload as { lastSeq?: unknown } | undefined;
        this.#attach(ws, delegate, env, payload);
        return undefined; // #attach 内部已回
      }

      case "session.close": {
        delegate.close();
        this.releaseSession(sessionId);
        return { ok: true };
      }

      case "turn.send": {
        // 幂等（B11）：相同 cmd id 重放缓存的 reply，不触发新 turn
        const cache = this.#cmdCache.get(sessionId)!;
        const cached = cache.get(env.id);
        if (cached !== undefined) return cached;
        const payload = env.payload as { text?: unknown; attachments?: unknown } | undefined;
        if (typeof payload?.text !== "string" || payload.text.length === 0) {
          return { ok: false, code: "bad_payload", message: "text 必须是非空字符串" };
        }
        if (payload.attachments !== undefined) {
          return { ok: false, code: "not_implemented", message: "附件通道未实现（spec §4 预留表）" };
        }
        const reply = delegate.sendTurn(payload.text);
        cache.set(env.id, reply);
        if (cache.size > CMD_CACHE_SIZE) {
          const oldest = cache.keys().next();
          if (oldest.done !== true) cache.delete(oldest.value);
        }
        return reply;
      }

      case "turn.cancel":
        return { ok: true, ...delegate.cancelTurn() };

      case "permission.resolve": {
        const payload = env.payload as { requestId?: unknown; outcome?: unknown } | undefined;
        if (
          typeof payload?.requestId !== "string" ||
          (payload.outcome !== "approved" && payload.outcome !== "denied")
        ) {
          return { ok: false, code: "bad_payload", message: "需要 requestId 与 outcome(approved|denied)" };
        }
        return delegate.resolvePermission(payload.requestId, payload.outcome)
          ? { ok: true }
          : { ok: false, code: "already_resolved", message: "该请求已被解决" };
      }

      case "permission.always": {
        const payload = env.payload as { requestId?: unknown } | undefined;
        if (typeof payload?.requestId !== "string") {
          return { ok: false, code: "bad_payload", message: "需要 requestId" };
        }
        return delegate.alwaysAllow(payload.requestId);
      }

      case "ask_user.answer": {
        const payload = env.payload as unknown as AskUserAnswerPayload | undefined;
        if (typeof payload?.requestId !== "string") {
          return { ok: false, code: "bad_payload", message: "需要 requestId" };
        }
        if (payload.abort !== true && !Array.isArray(payload.answers)) {
          return { ok: false, code: "bad_payload", message: "需要 answers 数组或 abort: true" };
        }
        return delegate.answerAskUser(payload)
          ? { ok: true }
          : { ok: false, code: "already_resolved", message: "该请求已被解决" };
      }

      case "extension_role.fallback": {
        const payload = env.payload as { requestId?: unknown; allow?: unknown } | undefined;
        if (typeof payload?.requestId !== "string" || typeof payload.allow !== "boolean") {
          return { ok: false, code: "bad_payload", message: "需要 requestId 与 allow(boolean)" };
        }
        return delegate.resolveExtensionRole(payload.requestId, payload.allow)
          ? { ok: true }
          : { ok: false, code: "already_resolved", message: "该请求已被解决" };
      }

      case "history.before": {
        const payload = env.payload as { beforeMsgId?: unknown; limit?: unknown } | undefined;
        if (typeof payload?.beforeMsgId !== "number" || !Number.isInteger(payload.beforeMsgId)) {
          return { ok: false, code: "bad_payload", message: "beforeMsgId 必须是整数 msgid" };
        }
        const limit =
          typeof payload.limit === "number" && Number.isFinite(payload.limit)
            ? Math.min(Math.max(1, Math.floor(payload.limit)), MAX_HISTORY_PAGE)
            : 100;
        const page = delegate.historyBefore(payload.beforeMsgId, limit);
        return { ok: true, messages: page.messages, hasMore: page.hasMore };
      }

      default:
        return { ok: false, code: "unknown_command", message: `未知命令：${env.type}` };
    }
  }

  /**
   * attach（§7/§9.2）：快照 -> reply -> 按 lastSeq 补发 -> 订阅。
   * 全程同步，publish 无法插队 —— 快照 lastSeq 与补发/直播无缝衔接（B6）。
   */
  #attach(ws: Ws, delegate: SessionDelegate, cmd: UiEnvelope, payload?: { lastSeq?: unknown }): void {
    if (ws.data.attached.has(delegate.id)) {
      this.#reply(ws, cmd, { ok: false, code: "already_attached", message: "本连接已 attach 该 session" });
      return;
    }
    const { messages, hasMore } = delegate.history();
    const current = this.#seq.get(delegate.id) ?? 0;
    const log = this.#log.get(delegate.id) ?? [];
    const oldest = log[0]?.seq ?? current + 1;
    const lastSeq = typeof payload?.lastSeq === "number" ? Math.floor(payload.lastSeq) : undefined;
    // lastSeq 滑出日志窗口（进程重启 / 过旧）→ 快照即真相（B5/§9.3）
    const resync = lastSeq !== undefined && lastSeq < oldest - 1;
    const info = delegate.info();
    const snapshot: SessionSnapshot = {
      sessionId: delegate.id,
      info,
      goal: delegate.goalSummary(),
      messages,
      hasMoreHistory: hasMore,
      replay: true,
      turnActive: info.turnActive,
      // 重连且补发窗口覆盖当前 turn 时 draft 为 null：前端用补发事件重建（§7）
      draft: lastSeq === undefined || resync ? delegate.draft() : null,
      pending: delegate.pending(),
      lastSeq: current,
      ...(resync ? { resync: true } : {}),
    };
    this.#reply(ws, cmd, { ok: true, state: snapshot });
    if (lastSeq !== undefined && !resync) {
      for (const entry of log) {
        if (entry.seq > lastSeq) this.#send(ws, entry.frame);
      }
    }
    this.#subs.get(delegate.id)!.add(ws);
    ws.data.attached.add(delegate.id);
    delegate.onWatchers(this.#subs.get(delegate.id)!.size);
  }

  /* ------------------------------ 帧发送 ------------------------------ */

  #reply(ws: Ws, cmd: UiEnvelope, payload: UiReplyPayload): void {
    this.#send(
      ws,
      JSON.stringify({
        v: UI_PROTOCOL_VERSION,
        id: cmd.id,
        kind: "reply",
        type: cmd.type,
        sessionId: cmd.sessionId,
        payload,
        ts: Date.now(),
      } satisfies UiEnvelope),
    );
  }

  #sendError(ws: Ws, code: string, message: string, fatal = false): void {
    this.#send(
      ws,
      JSON.stringify({
        v: UI_PROTOCOL_VERSION,
        id: nextFrameId(),
        kind: "evt",
        type: "error",
        payload: { code, message, ...(fatal ? { fatal: true } : {}) },
        ts: Date.now(),
      } satisfies UiEnvelope),
    );
  }

  #send(ws: Ws, frame: string): void {
    if (ws.getBufferedAmount() > MAX_BUFFER_BYTES) {
      // 慢消费者：绝不阻塞 agent loop，断开让它走重连补发（A7/§8）
      try {
        ws.close(1013, "slow consumer");
      } catch {
        /* 已断开 */
      }
      this.#onClose(ws);
      return;
    }
    ws.send(frame);
  }

  /** 应用层心跳（B10）：不入日志、不占 seq；前端 70s 无帧即重连。 */
  #beat(): void {
    const frame = JSON.stringify({
      v: UI_PROTOCOL_VERSION,
      id: nextFrameId(),
      kind: "evt",
      type: "heartbeat",
      payload: {},
      ts: Date.now(),
    } satisfies UiEnvelope);
    for (const ws of this.#conns) {
      if (ws.data.authenticated) this.#send(ws, frame);
    }
  }
}
