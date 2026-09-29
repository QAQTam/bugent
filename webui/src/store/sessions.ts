import { create } from 'zustand';
import type { AgentEvent, HistoryMessage, TodoItem } from '../transport/types';
import { createRafBatcher } from '../lib/raf-batcher';

/** 每个标签（session）独立的视图模型。状态互相独立（主 spec §2 末条）。
 *  reducer 采用写时克隆：被修改的 message/block 才换新引用，
 *  未修改的消息保持引用稳定 —— React.memo 的流式性能依赖这一点。 */

export type TodoVM = TodoItem;

export interface PermissionVM {
  description: string;
  allowAlways: boolean;
}

export interface ToolVM {
  kind: 'tool';
  id: string;
  name: string;
  status: 'running' | 'success' | 'error' | 'pending';
  input: unknown;
  output?: string;
  durationMs?: number;
  permission?: PermissionVM;
  open?: boolean; // 失败默认展开 / 用户展开过
}

export interface ToolGroupVM {
  kind: 'group';
  id: string;
  items: ToolVM[];
}

export interface TextBlockVM {
  kind: 'text';
  text: string;
  streaming: boolean;
}

export interface ThinkingBlockVM {
  kind: 'thinking';
  text: string;
  streaming: boolean;
}

export type Block = TextBlockVM | ThinkingBlockVM | ToolVM | ToolGroupVM;

export interface MessageVM {
  id: string;
  role: 'user' | 'assistant';
  blocks: Block[];
}

export type SessionStatus = 'idle' | 'running' | 'waiting' | 'error';

export interface SessionVM {
  id: string;
  title: string;
  status: SessionStatus;
  unread: boolean;
  messages: MessageVM[];
  todos: TodoVM[];
  todoExpanded: boolean;
  draft: string;
  scrollTop: number;
  errorMsg?: string;
  newCount: number; // 离开底部后的新内容条数（回到底部按钮计数）
}

interface Store {
  order: string[];
  sessions: Record<string, SessionVM>;
  activeId: string | null;
  connected: boolean;
  reconnectAttempt: number;
  /** 事件入口（transport.onEvent 回调里调用）。 */
  ingest(sessionId: string, e: AgentEvent): void;
  newSession(id: string): void;
  closeSession(id: string): void;
  setActive(id: string): void;
  rename(id: string, title: string): void;
  setDraft(id: string, draft: string): void;
  toggleTodo(id: string): void;
  saveScroll(id: string, top: number): void;
  clearUnread(id: string): void;
  setConnected(v: boolean, attempt: number): void;
  flush(): void;
}

let counter = 0;
export function genId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

function newSessionVM(id: string): SessionVM {
  return {
    id,
    title: '',
    status: 'idle',
    unread: false,
    messages: [],
    todos: [],
    todoExpanded: false,
    draft: '',
    scrollTop: 0,
    newCount: 0,
  };
}

// ---------- 写时克隆工具 ----------

function cloneBlock(b: Block): Block {
  if (b.kind === 'group') return { ...b, items: b.items.map((t) => ({ ...t })) };
  return { ...b };
}

function cloneMessage(m: MessageVM): MessageVM {
  return { ...m, blocks: m.blocks.map(cloneBlock) };
}

/** 当前 assistant 消息（协议 §11"消息归属"：delta 不带 role，归属到当前 assistant 消息）。 */
function ensureAssistant(s: SessionVM, messageId: string): MessageVM {
  for (let i = s.messages.length - 1; i >= 0; i -= 1) {
    if (s.messages[i]!.id === messageId) {
      const m = cloneMessage(s.messages[i]!);
      s.messages[i] = m;
      return m;
    }
  }
  const msg: MessageVM = { id: messageId, role: 'assistant', blocks: [] };
  s.messages.push(msg);
  return msg;
}

function lastTextBlock(m: MessageVM): TextBlockVM {
  const last = m.blocks[m.blocks.length - 1];
  if (last && last.kind === 'text') return last;
  const b: TextBlockVM = { kind: 'text', text: '', streaming: true };
  m.blocks.push(b);
  return b;
}

/** 连续工具调用合并（主 spec §4.2）：上一个块是工具/分组时并入分组。 */
function pushTool(m: MessageVM, tool: ToolVM): void {
  const last = m.blocks[m.blocks.length - 1];
  if (last && last.kind === 'group') {
    last.items.push(tool);
    return;
  }
  if (last && last.kind === 'tool') {
    m.blocks[m.blocks.length - 1] = { kind: 'group', id: genId('grp'), items: [last, tool] };
    return;
  }
  m.blocks.push({ kind: 'group', id: genId('grp'), items: [tool] });
}

interface ToolRef {
  msg: MessageVM;
  tool: ToolVM;
}

function findTool(s: SessionVM, toolId: string): ToolRef | undefined {
  for (let i = s.messages.length - 1; i >= 0; i -= 1) {
    const m = s.messages[i]!;
    for (let j = 0; j < m.blocks.length; j += 1) {
      const b = m.blocks[j]!;
      if (b.kind === 'tool' && b.id === toolId) {
        const cm = cloneMessage(m);
        s.messages[i] = cm;
        return { msg: cm, tool: cm.blocks[j] as ToolVM };
      }
      if (b.kind === 'group') {
        const k = b.items.findIndex((t) => t.id === toolId);
        if (k !== -1) {
          const cm = cloneMessage(m);
          s.messages[i] = cm;
          const group = cm.blocks[j] as ToolGroupVM;
          return { msg: cm, tool: group.items[k]! };
        }
      }
    }
  }
  return undefined;
}

function applyHistory(s: SessionVM, messages: HistoryMessage[]): void {
  s.messages = [];
  for (const h of messages) {
    if (h.role === 'user') {
      s.messages.push({
        id: `m-${h.msgid}`,
        role: 'user',
        blocks: [{ kind: 'text', text: h.text ?? '', streaming: false }],
      });
    } else if (h.role === 'assistant') {
      const blocks: Block[] = [];
      if (h.reasoning) blocks.push({ kind: 'thinking', text: h.reasoning, streaming: false });
      if (h.text) blocks.push({ kind: 'text', text: h.text, streaming: false });
      for (const c of h.toolCalls ?? []) {
        blocks.push({
          kind: 'tool', id: c.id, name: c.name, status: 'success',
          input: c.args, output: '', durationMs: 0,
        });
      }
      if (blocks.length > 0) s.messages.push({ id: `m-${h.msgid}`, role: 'assistant', blocks });
    } else if (h.role === 'tool') {
      // 工具结果回填到对应工具块（presentation 在历史里从 message 取，协议 §7）
      const ref = findTool(s, h.toolCallId ?? '');
      if (ref) {
        ref.tool.status = h.ok === false ? 'error' : 'success';
        ref.tool.output = h.output ?? '';
        if (h.ok === false) ref.tool.open = true; // 失败默认展开
      }
    }
    // system / inject 消息不渲染（克制：无触发条件的文案不出现）
  }
}

/** 纯 reducer：把一个 AgentEvent 应用到 session 视图上（写时克隆）。 */
export function reduceSession(prev: SessionVM, e: AgentEvent): SessionVM {
  const s: SessionVM = { ...prev, messages: [...prev.messages] };
  switch (e.type) {
    case 'message_start': {
      if ((e.role ?? 'assistant') === 'user') {
        s.messages.push({
          id: e.messageId,
          role: 'user',
          blocks: [{ kind: 'text', text: '', streaming: true }],
        });
      } else {
        ensureAssistant(s, e.messageId);
      }
      s.newCount += 1;
      break;
    }
    case 'text_delta': {
      const m = ensureAssistant(s, e.messageId);
      const b = lastTextBlock(m);
      b.text += e.text;
      break;
    }
    case 'thinking_delta': {
      const m = ensureAssistant(s, e.messageId);
      const last = m.blocks[m.blocks.length - 1];
      if (last && last.kind === 'thinking') last.text += e.text;
      else m.blocks.push({ kind: 'thinking', text: e.text, streaming: true });
      s.newCount += 1;
      break;
    }
    case 'tool_call_start': {
      const m = ensureAssistant(s, e.messageId);
      const lastText = m.blocks[m.blocks.length - 1];
      if (lastText && lastText.kind === 'text') lastText.streaming = false;
      pushTool(m, { kind: 'tool', id: e.toolId, name: e.name, status: 'running', input: e.input });
      s.newCount += 1;
      break;
    }
    case 'tool_call_end': {
      const ref = findTool(s, e.toolId);
      if (ref) {
        ref.tool.status = e.status;
        ref.tool.output = e.output;
        ref.tool.durationMs = e.durationMs;
        ref.tool.open = e.status === 'error'; // 失败默认展开，成功默认折叠（主 spec §4.1）
        delete ref.tool.permission; // 决策已提交，权限卡消失
      }
      if (s.status === 'waiting') s.status = 'running';
      break;
    }
    case 'tool_permission_request': {
      const ref = findTool(s, e.toolId);
      if (ref) {
        ref.tool.status = 'pending';
        ref.tool.permission = { description: e.description, allowAlways: e.allowAlways ?? false };
      }
      s.status = 'waiting';
      break;
    }
    case 'todo_update': {
      s.todos = e.todos;
      break;
    }
    case 'message_end': {
      const m = ensureAssistant(s, e.messageId);
      for (const b of m.blocks) if (b.kind === 'text' || b.kind === 'thinking') b.streaming = false;
      // 只有 assistant 消息结束才算 turn 收尾（用户消息回显在 turn 中途到达）
      if (m.role === 'assistant' && s.status === 'running') s.status = 'idle';
      break;
    }
    case 'history': {
      applyHistory(s, e.messages);
      break;
    }
    case 'error': {
      s.errorMsg = e.message;
      s.status = 'error';
      break;
    }
    case 'turn_running': {
      s.status = 'running';
      break;
    }
  }
  // 标题：第一条用户消息前 20 字（主 spec §2）
  if (!s.title) {
    const first = s.messages.find((m) => m.role === 'user');
    if (first) {
      const text = first.blocks.find((b): b is TextBlockVM => b.kind === 'text')?.text ?? '';
      s.title = text.slice(0, 20);
    }
  }
  return s;
}

const raf = createRafBatcher(() => useSessions.getState().flush());

/** 待应用的增量缓冲（每帧最多一次 setState，主 spec §7.2）。 */
const pending = new Map<string, AgentEvent[]>();

function applyOne(sessionId: string, e: AgentEvent): void {
  const st = useSessions.getState();
  const cur = st.sessions[sessionId];
  if (!cur) return;
  const next = reduceSession(cur, e);
  useSessions.setState((s) => ({ sessions: { ...s.sessions, [sessionId]: next } }));
}

export const useSessions = create<Store>((set, get) => ({
  order: [],
  sessions: {},
  activeId: null,
  connected: true,
  reconnectAttempt: 0,
  ingest(sessionId, e) {
    const isDelta = e.type === 'text_delta' || e.type === 'thinking_delta' || e.type === 'tool_call_end';
    if (isDelta) {
      const list = pending.get(sessionId) ?? [];
      list.push(e);
      pending.set(sessionId, list);
      raf.schedule();
      return;
    }
    applyOne(sessionId, e);
  },
  flush() {
    for (const [sessionId, list] of pending) {
      for (const e of list) applyOne(sessionId, e);
    }
    pending.clear();
  },
  newSession(id) {
    set((st) => ({
      order: [...st.order, id],
      sessions: { ...st.sessions, [id]: newSessionVM(id) },
      activeId: id,
    }));
  },
  closeSession(id) {
    set((st) => {
      const order = st.order.filter((x) => x !== id);
      const sessions = { ...st.sessions };
      delete sessions[id];
      const activeId = st.activeId === id ? (order[order.length - 1] ?? null) : st.activeId;
      return { order, sessions, activeId };
    });
  },
  setActive(id) {
    set((st) => ({
      activeId: id,
      sessions: st.sessions[id]
        ? { ...st.sessions, [id]: { ...st.sessions[id]!, unread: false, newCount: 0 } }
        : st.sessions,
    }));
  },
  rename(id, title) {
    set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: { ...st.sessions[id]!, title } } } : st));
  },
  setDraft(id, draft) {
    set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: { ...st.sessions[id]!, draft } } } : st));
  },
  toggleTodo(id) {
    set((st) =>
      st.sessions[id]
        ? { sessions: { ...st.sessions, [id]: { ...st.sessions[id]!, todoExpanded: !st.sessions[id]!.todoExpanded } } }
        : st,
    );
  },
  saveScroll(id, top) {
    set((st) => (st.sessions[id] ? { sessions: { ...st.sessions, [id]: { ...st.sessions[id]!, scrollTop: top } } } : st));
  },
  clearUnread(id) {
    set((st) =>
      st.sessions[id] ? { sessions: { ...st.sessions, [id]: { ...st.sessions[id]!, unread: false, newCount: 0 } } } : st,
    );
  },
  setConnected(v, attempt) {
    set({ connected: v, reconnectAttempt: attempt });
  },
}));

/** 供测试/headless 立即刷出缓冲区。 */
export function flushNow(): void {
  raf.flushNow();
  useSessions.getState().flush();
}
