/**
 * bridge 接线 —— transport ↔ store 的胶水。App 只跟这里拿动作。
 */

import type { AskUserAnswer } from "@protocol";
import { useUiStore } from "./state/store";
import { ProtocolTransport } from "./transport/protocol-transport";

let transport: ProtocolTransport | undefined;
let initialized = false;

export function connectBridge(token: string): void {
  transport?.disconnect();
  initialized = false;
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  const t = new ProtocolTransport(wsUrl, token, {
    onState: (state) => {
      useUiStore.getState().setConn(state);
      // live 后初始化 session：已有列表就 attach 最近的，否则 new（MVP 单 session）
      if (state === "live" && !initialized) {
        initialized = true;
        void initSession(t);
      }
    },
    onError: (payload) => {
      if (payload.fatal === true) {
        useUiStore.getState().setConn("offline", payload.message);
      }
    },
    onEvent: (sessionId, event, seq) => {
      const store = useUiStore.getState();
      store.ensureSession(sessionId);
      store.applyEvent(sessionId, event, seq);
    },
    onSnapshot: (sessionId, snapshot) => {
      const store = useUiStore.getState();
      store.ensureSession(sessionId);
      store.applySnapshot(sessionId, snapshot);
    },
  });
  transport = t;
  t.connect();
}

async function initSession(t: ProtocolTransport): Promise<void> {
  try {
    const list = await t.cmd<{ sessions?: { sessionId: string }[] }>("session.list", {});
    const first = list.sessions?.[0]?.sessionId;
    if (first !== undefined) {
      t.attach(first);
      return;
    }
    const created = await t.newSession();
    if (created.ok === true) {
      const sessionId = (created as unknown as { sessionId: string }).sessionId;
      useUiStore.getState().ensureSession(sessionId);
      t.attach(sessionId);
    }
  } catch {
    // 断线场景：重连后 attach 由 transport 的 wantSessions 自动续
  }
}

export function getTransport(): ProtocolTransport | undefined {
  return transport;
}

export const actions = {
  send(text: string): void {
    const { activeId } = useUiStore.getState();
    if (activeId === undefined || text.trim().length === 0) return;
    void getTransport()?.sendTurn(activeId, text);
  },

  cancel(): void {
    const { activeId } = useUiStore.getState();
    if (activeId === undefined) return;
    void getTransport()?.cancelTurn(activeId);
  },

  resolvePermission(requestId: string, outcome: "approved" | "denied"): void {
    const { activeId } = useUiStore.getState();
    if (activeId === undefined) return;
    void getTransport()?.resolvePermission(activeId, requestId, outcome);
  },

  alwaysAllow(requestId: string): void {
    const { activeId } = useUiStore.getState();
    if (activeId === undefined) return;
    void getTransport()?.alwaysAllow(activeId, requestId);
  },

  answerAskUser(requestId: string, answers: AskUserAnswer[]): void {
    const { activeId } = useUiStore.getState();
    if (activeId === undefined) return;
    void getTransport()?.answerAskUser(activeId, requestId, { answers });
  },

  abortAskUser(requestId: string): void {
    const { activeId } = useUiStore.getState();
    if (activeId === undefined) return;
    void getTransport()?.answerAskUser(activeId, requestId, { abort: true });
  },
};
