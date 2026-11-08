/**
 * Zustand 状态层 —— 把协议事件装配成"有序块序列"（spec §5.1，C6/C7）。
 *
 * 块模型：一个 turn 内是 文本块 → 工具块 → 文本块… 的有序序列；块按事件到达
 * 顺序追加、按 blockId/callId 去重更新。`assistant.message` 到达时把本 turn
 * 的流式文本块定格为落库消息块。历史/快照重建走 applySnapshot。
 *
 * 虚拟化（D7，TanStack Virtual）在 Transcript 组件接入；本层只负责数据。
 */

import { create } from "zustand";
import type {
  AskUserQuestion,
  GoalSummary,
  PendingInteraction,
  SessionInfo,
  SessionSnapshot,
  StoredMessage,
  TodoItem,
  ToolPresentation,
  UiEvent,
} from "@protocol";
import type { TransportState } from "../transport/protocol-transport";

/** store 侧的待决交互：ask_user 需要问题详情来渲染表单。 */
export interface PendingView extends PendingInteraction {
  questions?: readonly AskUserQuestion[];
}

export type UiBlock =
  | { kind: "message"; id: string; message: StoredMessage }
  | { kind: "text"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string }
  | {
      kind: "tool";
      /** 用 call.id 作 key：同一调用的 delta/call/result 收敛到一块。 */
      id: string;
      name: string;
      argsText: string;
      status: "running" | "done" | "error";
      output?: string;
      presentation?: ToolPresentation;
      progress?: string;
    }
  | { kind: "error"; id: string; code: string; message: string };

export interface SessionView {
  info?: SessionInfo;
  goal: GoalSummary | null;
  mode?: string;
  turnActive: boolean;
  blocks: UiBlock[];
  pending: readonly PendingView[];
  todos: readonly TodoItem[];
  lastSeq: number;
  hasMoreHistory: boolean;
}

function emptySession(): SessionView {
  return {
    goal: null,
    turnActive: false,
    blocks: [],
    pending: [],
    todos: [],
    lastSeq: 0,
    hasMoreHistory: false,
  };
}

interface UiStoreData {
  conn: TransportState;
  connNote?: string;
  activeId?: string;
  sessions: Record<string, SessionView>;
}

export interface UiStore extends UiStoreData {
  setConn: (conn: TransportState, note?: string) => void;
  setActive: (sessionId: string | undefined) => void;
  ensureSession: (sessionId: string) => void;
  applySnapshot: (sessionId: string, snapshot: SessionSnapshot) => void;
  applyEvent: (sessionId: string, event: UiEvent, seq: number) => void;
  dropUnsettledDraft: (sessionId: string) => void;
}

function upsertBlock(blocks: UiBlock[], block: UiBlock, keyOf: (b: UiBlock) => string, key: string): UiBlock[] {
  const index = blocks.findIndex((b) => keyOf(b) === key);
  if (index === -1) return [...blocks, block];
  const next = [...blocks];
  next[index] = block;
  return next;
}

const toolKey = (b: UiBlock) => (b.kind === "tool" ? b.id : "");

export const useUiStore = create<UiStore>()((set, get) => ({
  conn: "idle",
  sessions: {},

  setConn: (conn, note) => set((s) => ({ conn, ...(note !== undefined ? { connNote: note } : {}) })),

  setActive: (sessionId) => set((s) => ({ ...(sessionId !== undefined ? { activeId: sessionId } : {}) })),

  ensureSession: (sessionId) =>
    set((s) => ({
      sessions: s.sessions[sessionId] !== undefined ? s.sessions : { ...s.sessions, [sessionId]: emptySession() },
      ...(s.activeId === undefined ? { activeId: sessionId } : {}),
    })),

  applySnapshot: (sessionId, snapshot) =>
    set((s) => {
      // 快照即真相（§7）：落库消息 → 消息块；draft → 流式块
      const blocks: UiBlock[] = snapshot.messages
        .filter((message) => message.role !== "system" || message.origin === "inject")
        .map((message) => ({ kind: "message", id: `m-${message.msgid}`, message }) satisfies UiBlock);
      const draft = snapshot.draft;
      if (draft !== null) {
        if (draft.text.length > 0) blocks.push({ kind: "text", id: draft.turnId ? `${draft.turnId}-draft-text` : "draft-text", text: draft.text });
        if (draft.reasoning !== undefined && draft.reasoning.length > 0) {
          blocks.push({ kind: "reasoning", id: draft.turnId ? `${draft.turnId}-draft-reasoning` : "draft-reasoning", text: draft.reasoning });
        }
        for (const tool of draft.tools) {
          blocks.push({
            kind: "tool",
            id: tool.call.id,
            name: tool.call.name,
            argsText: tool.argsSoFar,
            status: "running",
          });
        }
      }
      const view = emptySession();
      view.info = snapshot.info;
      view.goal = snapshot.goal;
      view.mode = snapshot.info.mode;
      view.turnActive = snapshot.turnActive;
      view.blocks = blocks;
      view.pending = snapshot.pending;
      view.lastSeq = snapshot.lastSeq;
      view.hasMoreHistory = snapshot.hasMoreHistory;
      return { sessions: { ...s.sessions, [sessionId]: view }, ...(s.activeId === undefined ? { activeId: sessionId } : {}) };
    }),

  applyEvent: (sessionId, event, seq) =>
    set((s) => {
      const view = s.sessions[sessionId] ?? emptySession();
      // seq 去重（B6）：补发与直播重叠时只应用一次
      if (seq <= view.lastSeq) return {};
      const next: SessionView = { ...view, lastSeq: seq };

      switch (event.type) {
        case "user.message":
          next.blocks = [...view.blocks, { kind: "message", id: `m-${event.message.msgid}`, message: event.message }];
          break;

        case "text.delta":
          next.blocks = upsertText(next.blocks, "text", event.blockId, event.delta);
          break;

        case "reasoning.delta":
          next.blocks = upsertText(next.blocks, "reasoning", event.blockId, event.delta);
          break;

        case "assistant.message": {
          // 定格：本 turn 的流式 text/reasoning 块收敛为落库消息块
          const firstDraft = view.blocks.findIndex((b) => b.kind === "text" || b.kind === "reasoning");
          const kept = view.blocks.filter((b) => b.kind !== "text" && b.kind !== "reasoning");
          const text = event.message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          if (text.length > 0 || firstDraft >= 0) {
            const messageBlock: UiBlock = { kind: "message", id: `m-${event.message.msgid}`, message: event.message };
            if (firstDraft >= 0) {
              // 保持在原第一个草稿块的位置
              const before = kept.slice(0, firstDraft);
              const after = kept.slice(firstDraft);
              next.blocks = [...before, messageBlock, ...after];
            } else {
              next.blocks = [...kept, messageBlock];
            }
          } else {
            next.blocks = kept;
          }
          break;
        }

        case "tool.call_delta":
          next.blocks = upsertBlock(
            next.blocks,
            {
              kind: "tool",
              id: event.call.id,
              name: event.call.name,
              argsText: event.rawArgs,
              status: "running",
              ...(event.reset === true ? {} : {}),
            },
            toolKey,
            event.call.id,
          );
          break;

        case "tool.call":
          next.blocks = upsertBlock(
            next.blocks,
            {
              kind: "tool",
              id: event.call.id,
              name: event.call.name,
              argsText: typeof event.call.args === "string" ? event.call.args : JSON.stringify(event.call.args ?? {}),
              status: "running",
            },
            toolKey,
            event.call.id,
          );
          break;

        case "tool.progress": {
          const existing = next.blocks.find((b) => b.kind === "tool" && b.id === event.call.id);
          const base: UiBlock =
            existing ??
            ({ kind: "tool", id: event.call.id, name: "", argsText: "", status: "running" } satisfies UiBlock);
          const progress = `${(base.kind === "tool" ? base.progress : "") ?? ""}${event.chunk}`.slice(-4000);
          next.blocks = upsertBlock(
            next.blocks,
            base.kind === "tool" ? { ...base, progress, name: base.name || event.call.id } : base,
            toolKey,
            event.call.id,
          );
          break;
        }

        case "tool.result":
          next.blocks = upsertBlock(
            next.blocks,
            {
              kind: "tool",
              id: event.call.id,
              name: event.call.name,
              argsText: typeof event.call.args === "string" ? event.call.args : JSON.stringify(event.call.args ?? {}),
              status: event.result.ok ? "done" : "error",
              output: event.result.output,
              ...(event.result.presentation !== undefined ? { presentation: event.result.presentation } : {}),
            },
            toolKey,
            event.call.id,
          );
          break;

        case "workspace.change":
          // MVP：不做“已修改”徽标（spec 预留）
          break;

        case "permission.request":
          next.pending = [...view.pending, { kind: "permission", requestId: event.requestId, summary: event.request.summary }];
          break;

        case "capability.request":
          next.pending = [...view.pending, { kind: "capability", requestId: event.requestId, summary: event.escalation.reason }];
          break;

        case "ask_user.request":
          next.pending = [
            ...view.pending,
            {
              kind: "ask_user",
              requestId: event.requestId,
              summary: event.questions[0]?.question ?? "ask_user",
              questions: event.questions,
            },
          ];
          break;

        case "extension_role.fallback_request":
          next.pending = [...view.pending, { kind: "extension_role", requestId: event.requestId, summary: "provider 协议角色回退确认" }];
          break;

        case "interaction.resolved":
          next.pending = view.pending.filter((p) => p.requestId !== event.requestId);
          break;

        case "usage":
          break;

        case "session.state":
          next.mode = event.mode;
          next.turnActive = event.turnActive;
          next.goal = event.goal;
          break;

        case "todo.state":
          next.todos = [...event.todos];
          break;

        case "turn.started":
          next.turnActive = true;
          break;

        case "turn.done":
          next.turnActive = false;
          break;

        case "turn.error":
          next.turnActive = false;
          next.blocks = [...next.blocks, { kind: "error", id: `err-${seq}`, code: "turn_error", message: event.message }];
          break;

        case "error":
          next.blocks = [...next.blocks, { kind: "error", id: `err-${seq}`, code: event.code, message: event.message }];
          break;

        default:
          break;
      }
      return { sessions: { ...s.sessions, [sessionId]: next } };
    }),

  dropUnsettledDraft: (sessionId) =>
    set((s) => {
      const view = s.sessions[sessionId];
      if (view === undefined) return {};
      // resync：丢弃未定格草稿，快照重建（§9.3）
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...view, blocks: view.blocks.filter((b) => b.kind !== "text" && b.kind !== "reasoning") },
        },
      };
    }),
}));

function upsertText(blocks: UiBlock[], kind: "text" | "reasoning", blockId: string, delta: string): UiBlock[] {
  const index = blocks.findIndex((b) => (b.kind === "text" || b.kind === "reasoning") && b.id === blockId);
  if (index === -1) {
    return [...blocks, kind === "text" ? { kind: "text", id: blockId, text: delta } : { kind: "reasoning", id: blockId, text: delta }];
  }
  const existing = blocks[index]!;
  if (existing.kind !== kind) return blocks; // 不可能，防御
  const updated: UiBlock = kind === "text" ? { kind: "text", id: blockId, text: existing.text + delta } : { kind: "reasoning", id: blockId, text: existing.text + delta };
  const next = [...blocks];
  next[index] = updated;
  return next;
}
