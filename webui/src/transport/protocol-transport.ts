/**
 * ProtocolTransport —— WebUI v2 的类型化 WS 客户端（spec §3/§4/§8）。
 *
 * 职责：信封编解码、cmd/reply 关联、hello 认证、attach（含 lastSeq 续看）、
 * 指数退避 + 抖动重连、心跳看门狗（70s 无帧强制重连）。领域语义不在这层
 * —— 事件原样上抛，块装配在 state/store.ts。
 */

import { UI_PROTOCOL_VERSION, type SessionSnapshot, type UiEvent, type UiReplyPayload } from "@protocol";

export type TransportState = "idle" | "connecting" | "live" | "reconnecting" | "offline";

export interface Envelope {
  v: number;
  id: string;
  kind: "cmd" | "evt" | "reply";
  type: string;
  sessionId?: string;
  seq?: number;
  payload: Record<string, unknown>;
  ts: number;
}

export interface TransportHandlers {
  onState: (state: TransportState) => void;
  /** 协议层错误帧（evt error）。 */
  onError: (payload: { code: string; message: string; fatal?: boolean }) => void;
  /** 下行事件（heartbeat 已被本层消费，不会到达这里）。 */
  onEvent: (sessionId: string, event: UiEvent, seq: number) => void;
  /** attach reply 的快照。 */
  onSnapshot: (sessionId: string, snapshot: SessionSnapshot) => void;
}

interface PendingCmd {
  resolve: (payload: UiReplyPayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CMD_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 15_000;
/** 70s 无任何帧（心跳周期 30s）→ 判死重连（spec §8）。 */
const DEAD_AFTER_MS = 70_000;

export class ProtocolTransport {
  #url: string;
  #token: string;
  #handlers: TransportHandlers;
  #ws: WebSocket | undefined;
  #state: TransportState = "idle";
  #nextId = 1;
  #pending = new Map<string, PendingCmd>();
  /** 每个想看的 session 的最后 seq（重连 attach 用，B3）。 */
  #lastSeqBySession = new Map<string, number>();
  /** attach 过的 session：重连后自动续订。 */
  #wantSessions = new Set<string>();
  #backoffMs = 500;
  #closedByUs = false;
  #lastFrameAt = 0;
  #watchdog: ReturnType<typeof setInterval> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(url: string, token: string, handlers: TransportHandlers) {
    this.#url = url;
    this.#token = token;
    this.#handlers = handlers;
  }

  get state(): TransportState {
    return this.#state;
  }

  connect(): void {
    if (this.#ws !== undefined) return;
    this.#closedByUs = false;
    this.#setState(this.#state === "offline" || this.#state === "reconnecting" ? "reconnecting" : "connecting");
    const ws = new WebSocket(this.#url);
    this.#ws = ws;
    this.#lastFrameAt = Date.now();

    ws.onopen = () => {
      this.#sendRaw({ v: UI_PROTOCOL_VERSION, id: this.#nextCmdId(), kind: "cmd", type: "hello", payload: { token: this.#token, client: "webui", protocolVersions: [UI_PROTOCOL_VERSION] }, ts: Date.now() });
    };
    ws.onmessage = (messageEvent) => {
      this.#lastFrameAt = Date.now();
      let envelope: Envelope;
      try {
        envelope = JSON.parse(String(messageEvent.data)) as Envelope;
      } catch {
        return;
      }
      this.#handleEnvelope(envelope);
    };
    ws.onclose = () => {
      this.#ws = undefined;
      this.#failPending(new Error("连接已断开"));
      if (this.#closedByUs) {
        this.#setState("offline");
        return;
      }
      this.#scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose 会跟着来；这里只兜住永久性错误不打断重连节奏
    };

    if (this.#watchdog === undefined) {
      this.#watchdog = setInterval(() => {
        if (this.#ws !== undefined && this.#state === "live" && Date.now() - this.#lastFrameAt > DEAD_AFTER_MS) {
          // 强制断开 → onclose → 重连补发
          try {
            this.#ws.close();
          } catch {
            /* 已断开 */
          }
        }
      }, 10_000);
    }
  }

  disconnect(): void {
    this.#closedByUs = true;
    if (this.#watchdog !== undefined) clearInterval(this.#watchdog);
    this.#watchdog = undefined;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#ws?.close();
    this.#ws = undefined;
    this.#failPending(new Error("已主动断开"));
    this.#setState("offline");
  }

  /* ------------------------------ 命令封装 ------------------------------ */

  attach(sessionId: string): void {
    this.#wantSessions.add(sessionId);
    void this.cmd("session.attach", { sessionId, lastSeq: this.#lastSeqBySession.get(sessionId) }, sessionId).then(
      (reply) => {
        if (reply.ok === true) {
          const state = (reply as { state?: SessionSnapshot }).state;
          if (state !== undefined) {
            this.#lastSeqBySession.set(sessionId, state.lastSeq);
            this.#handlers.onSnapshot(sessionId, state);
          }
        }
      },
      () => { /* 断线等重连后自动续订 */ },
    );
  }

  sendTurn(sessionId: string, text: string): Promise<UiReplyPayload> {
    return this.cmd("turn.send", { text }, sessionId);
  }

  cancelTurn(sessionId: string): Promise<UiReplyPayload> {
    return this.cmd("turn.cancel", {}, sessionId);
  }

  resolvePermission(sessionId: string, requestId: string, outcome: "approved" | "denied"): Promise<UiReplyPayload> {
    return this.cmd("permission.resolve", { requestId, outcome }, sessionId);
  }

  alwaysAllow(sessionId: string, requestId: string): Promise<UiReplyPayload> {
    return this.cmd("permission.always", { requestId }, sessionId);
  }

  answerAskUser(
    sessionId: string,
    requestId: string,
    payload: { answers?: { question: string; selected: number[]; custom?: string }[]; abort?: boolean },
  ): Promise<UiReplyPayload> {
    return this.cmd("ask_user.answer", { requestId, ...payload }, sessionId);
  }

  historyBefore(sessionId: string, beforeMsgId: number, limit = 100): Promise<UiReplyPayload> {
    return this.cmd("history.before", { sessionId, beforeMsgId, limit }, sessionId);
  }

  newSession(cwd?: string): Promise<UiReplyPayload> {
    return this.cmd("session.new", cwd !== undefined ? { cwd } : {});
  }

  cmd<T extends Record<string, unknown> = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
  ): Promise<UiReplyPayload & T> {
    return new Promise((resolve, reject) => {
      if (this.#ws === undefined || this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error("未连接"));
        return;
      }
      const id = this.#nextCmdId();
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`命令超时：${type}`));
      }, CMD_TIMEOUT_MS);
      this.#pending.set(id, { resolve: resolve as (p: UiReplyPayload) => void, reject, timer });
      this.#sendRaw({
        v: UI_PROTOCOL_VERSION,
        id,
        kind: "cmd",
        type,
        ...(sessionId !== undefined ? { sessionId } : {}),
        payload,
        ts: Date.now(),
      });
    });
  }

  /* ------------------------------ 内部 ------------------------------ */

  #nextCmdId(): string {
    this.#nextId += 1;
    return `ui-${Date.now().toString(36)}-${this.#nextId}`;
  }

  /** 断线时把挂起命令全部判失败（调用方自行重试）。 */
  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #sendRaw(envelope: Envelope): void {
    this.#ws?.send(JSON.stringify(envelope));
  }

  #setState(state: TransportState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#handlers.onState(state);
  }

  #handleEnvelope(envelope: Envelope): void {
    if (envelope.kind === "reply") {
      if (envelope.type === "hello") {
        if (envelope.payload.ok === true) {
          this.#onHelloOk();
        } else {
          // 认证/版本失败：服务端会关连接；停止重连避免打转
          this.#closedByUs = true;
          this.#setState("offline");
        }
        return;
      }
      const pending = this.#pending.get(envelope.id);
      if (pending !== undefined) {
        this.#pending.delete(envelope.id);
        clearTimeout(pending.timer);
        pending.resolve(envelope.payload as UiReplyPayload);
      }
      return;
    }
    if (envelope.kind !== "evt") return;
    const payload = envelope.payload as { type?: string } & Record<string, unknown>;
    if (payload.type === "heartbeat") return;
    if (payload.type === "error") {
      this.#handlers.onError(payload as unknown as { code: string; message: string; fatal?: boolean });
      return;
    }
    if (typeof envelope.sessionId === "string" && typeof envelope.seq === "number") {
      // seq 单调（B1）：乱序到达也按 seq 收敛
      const known = this.#lastSeqBySession.get(envelope.sessionId) ?? 0;
      if (envelope.seq > known) this.#lastSeqBySession.set(envelope.sessionId, envelope.seq);
      this.#handlers.onEvent(envelope.sessionId, payload as unknown as UiEvent, envelope.seq);
    }
  }

  #scheduleReconnect(): void {
    this.#setState("reconnecting");
    const jitter = Math.random() * 0.3 * this.#backoffMs;
    const delay = this.#backoffMs + jitter;
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  /** 重连成功（hello reply 到达）后：状态切 live，并按 lastSeq 续订全部 session。 */
  #onHelloOk(): void {
    this.#backoffMs = 500;
    this.#setState("live");
    for (const sessionId of this.#wantSessions) {
      // 走带关联的 attach：快照照常进 onSnapshot
      this.attach(sessionId);
    }
  }
}
