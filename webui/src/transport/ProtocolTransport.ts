import type { AgentEvent, AgentTransport, HistoryMessage, ToolDecision } from './types';

/** ProtocolTransport：把 docs/ui-protocol-spec.md 的 WS 协议翻译成 AgentEvent / AgentTransport
 *  （协议 spec §11 的规范性映射）。信封：{ v, id, kind: cmd|evt|reply, type, sessionId, payload, ts }。 */

const PROTOCOL_VERSION = 1;

interface Envelope<T = Record<string, unknown>> {
  v: number;
  id: string;
  kind: 'cmd' | 'evt' | 'reply';
  type: string;
  sessionId?: string;
  payload: T;
  ts: number;
}

export interface ProtocolTransportOptions {
  url: string;
  token: string;
  client?: 'webui' | 'electron';
}

interface SessionState {
  serverId?: string;
  attached: boolean;
  currentAssistantId: string;
  /** toolId -> requestId（权限往返按 toolId 索引，UI 用 toolId 决策）。 */
  permissionByTool: Map<string, string>;
}

export class ProtocolTransport implements AgentTransport {
  private ws: WebSocket | null = null;
  private handlers = new Set<(sessionId: string, e: AgentEvent) => void>();
  /** 本地标签 id -> 状态。 */
  private sessions = new Map<string, SessionState>();
  /** 协议 sessionId -> 本地标签 id（事件按它路由回正确的标签）。 */
  private byServerId = new Map<string, string>();
  private replies = new Map<string, (payload: Record<string, unknown>) => void>();
  /** hello 完成前出站命令排队（WS 未 open 时 send 会抛 InvalidStateError）。 */
  private ready = false;
  private queue: string[] = [];
  private attempt = 0;
  private closedByUser = false;
  private readonly url: string;
  private readonly token: string;
  private readonly client: 'webui' | 'electron';
  private onConnection?: (connected: boolean, attempt: number) => void;

  constructor(options: ProtocolTransportOptions) {
    this.url = options.url;
    this.token = options.token;
    this.client = options.client ?? 'webui';
  }

  /** 连接状态回调（UI 渲染重连提示条）。 */
  onConnectionChange(cb: (connected: boolean, attempt: number) => void): void {
    this.onConnection = cb;
  }

  onEvent(handler: (sessionId: string, e: AgentEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  connect(): void {
    this.closedByUser = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      // hello 直发（不进队列）：队列的清空条件就是 hello 的 reply
      const env: Envelope = {
        v: PROTOCOL_VERSION,
        id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'cmd',
        type: 'hello',
        payload: { token: this.token, client: this.client, protocolVersions: [PROTOCOL_VERSION] },
        ts: Date.now(),
      };
      this.replies.set(env.id, () => {
        this.ready = true;
        for (const data of this.queue.splice(0)) this.ws?.send(data);
        this.attempt = 0;
        this.onConnection?.(true, 0);
      });
      ws.send(JSON.stringify(env));
    };
    ws.onmessage = (ev) => this.handleMessage(String(ev.data));
    ws.onclose = () => {
      this.onConnection?.(false, this.attempt);
      this.ready = false;
      this.queue = [];
      // 断连后服务端已释放 attach（§6）；attached 复位，重连后下一次 send 会重新 attach
      for (const state of this.sessions.values()) {
        state.attached = false;
        state.currentAssistantId = '';
      }
      if (this.closedByUser) return;
      // 指数退避重连（主 spec §8.3）：1s、2s、4s…上限 30s
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt);
      this.attempt += 1;
      setTimeout(() => this.connect(), delay);
    };
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }

  private handleMessage(raw: string): void {
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      return; // 非法帧静默丢弃
    }
    if (env.kind === 'reply') {
      this.replies.get(env.id)?.(env.payload);
      this.replies.delete(env.id);
      return;
    }
    if (env.kind !== 'evt') return;
    this.handleEvent(env);
  }

  private cmd(type: string, payload: Record<string, unknown>, onReply?: (p: Record<string, unknown>) => void, sessionId?: string): void {
    const env: Envelope = {
      v: PROTOCOL_VERSION,
      id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'cmd',
      type,
      ...(sessionId !== undefined ? { sessionId } : {}),
      payload,
      ts: Date.now(),
    };
    if (onReply) this.replies.set(env.id, onReply);
    const data = JSON.stringify(env);
    if (!this.ready) {
      this.queue.push(data);
      return;
    }
    this.ws?.send(data);
  }

  // ---------- AgentTransport ----------
  // 会话 id 翻译：UI 用本地标签 id（App 生成），协议侧 session id 由服务端生成。
  // 首次 send 时 session.new → attach → turn.send；之后事件按 server→local 反查回本地 id。

  /** 确保 serverId 已建立（session.new + attach）；attach 失败（含 session_taken）emit error。 */
  private ensureSession(localId: string, ready: (serverId: string) => void): void {
    const state = this.session(localId);
    if (state.serverId !== undefined) {
      ready(state.serverId);
      return;
    }
    this.cmd('session.new', {}, (p) => {
      if (p.ok !== true) {
        this.emit(localId, { type: 'error', message: String(p.message ?? p.code ?? '创建会话失败') });
        return;
      }
      const serverId = String(p.sessionId);
      state.serverId = serverId;
      this.byServerId.set(serverId, localId);
      this.cmd('session.attach', { sessionId: serverId }, (p2) => {
        if (p2.ok !== true) {
          this.emit(localId, { type: 'error', message: String(p2.message ?? p2.code ?? '附加会话失败') });
          return;
        }
        state.attached = true;
        state.currentAssistantId = '';
        this.emit(localId, { type: 'history', messages: projectHistory((p2.messages ?? []) as Record<string, unknown>[]) });
        ready(serverId);
      }, serverId);
    });
  }

  send(sessionId: string, text: string): void {
    this.ensureSession(sessionId, (serverId) => {
      this.cmd('turn.send', { text }, (p) => {
        if (p.ok !== true) {
          this.emit(sessionId, { type: 'error', message: String(p.message ?? p.code ?? '发送失败') });
        }
      }, serverId);
    });
  }

  stop(sessionId: string): void {
    const serverId = this.session(sessionId).serverId;
    if (serverId === undefined) return; // 尚未建立，无可取消
    this.cmd('turn.cancel', {}, undefined, serverId);
  }

  approveTool(toolId: string, decision: ToolDecision): void {
    for (const [localId, state] of this.sessions) {
      const requestId = state.permissionByTool.get(toolId);
      if (requestId === undefined) continue;
      state.permissionByTool.delete(toolId);
      const serverId = state.serverId;
      if (decision === 'always') {
        this.cmd('permission.always', { requestId }, undefined, serverId);
      } else {
        this.cmd(
          'permission.resolve',
          { requestId, outcome: decision === 'allow' ? 'approved' : 'denied' },
          undefined,
          serverId,
        );
      }
      void localId;
      return;
    }
  }

  // ---------- 协议事件 → AgentEvent（协议 spec §11 映射表，规范性） ----------

  private session(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { attached: false, currentAssistantId: '', permissionByTool: new Map() };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private handleEvent(env: Envelope): void {
    const serverId = env.sessionId ?? '';
    if (!serverId) return; // 协议层消息不属于任何 session
    const localId = this.byServerId.get(serverId);
    if (localId === undefined) return; // 未知 session（如其他连接新建的），静默丢弃
    const state = this.session(localId);
    const sessionId = localId;
    const p = env.payload as Record<string, unknown>;
    switch (env.type) {
      case 'turn.started': {
        this.emit(localId, { type: 'turn_running' });
        break;
      }
      case 'user.message': {
        const msg = p.message as Record<string, unknown>;
        const id = `m-${String(msg.msgid)}`;
        this.emit(sessionId, { type: 'message_start', messageId: id, role: 'user' });
        this.emit(sessionId, { type: 'text_delta', messageId: id, text: storedText(msg) });
        this.emit(sessionId, { type: 'message_end', messageId: id });
        break;
      }
      case 'text.delta': {
        this.emit(sessionId, { type: 'text_delta', messageId: state.currentAssistantId, text: String(p.delta) });
        break;
      }
      case 'reasoning.delta': {
        // 不落库（协议 §5），UI 不持久化
        this.emit(sessionId, { type: 'thinking_delta', messageId: state.currentAssistantId, text: String(p.delta) });
        break;
      }
      case 'assistant.message': {
        const msg = p.message as Record<string, unknown>;
        state.currentAssistantId = `m-${String(msg.msgid)}`;
        this.emit(sessionId, { type: 'message_start', messageId: state.currentAssistantId, role: 'assistant' });
        break;
      }
      case 'tool.call': {
        const call = p.call as Record<string, unknown>;
        this.emit(sessionId, {
          type: 'tool_call_start',
          messageId: state.currentAssistantId,
          toolId: String(call.id),
          name: String(call.name),
          input: call.args,
        });
        break;
      }
      case 'tool.result': {
        const call = p.call as Record<string, unknown>;
        const result = p.result as Record<string, unknown>;
        this.emit(sessionId, {
          type: 'tool_call_end',
          toolId: String(call.id),
          status: result.ok === true ? 'success' : 'error',
          output: String(result.output ?? ''),
          durationMs: Number(result.durationMs ?? 0),
        });
        break;
      }
      case 'permission.request': {
        const requestId = String(p.requestId);
        const request = p.request as Record<string, unknown>;
        const toolId = `perm-${requestId}`;
        state.permissionByTool.set(toolId, requestId);
        this.emit(sessionId, {
          type: 'tool_call_start',
          messageId: state.currentAssistantId,
          toolId,
          name: String(request.tool),
          input: request.resource,
        });
        this.emit(sessionId, { type: 'tool_permission_request', toolId, description: String(request.summary), allowAlways: true });
        break;
      }
      case 'capability.request': {
        // capability 不支持"总是允许"（协议 §6.1）
        const requestId = String(p.requestId);
        const call = p.call as Record<string, unknown>;
        const escalation = p.escalation as Record<string, unknown>;
        const toolId = `cap-${requestId}`;
        state.permissionByTool.set(toolId, requestId);
        this.emit(sessionId, {
          type: 'tool_call_start', messageId: state.currentAssistantId, toolId,
          name: String(call.name), input: call.args,
        });
        this.emit(sessionId, {
          type: 'tool_permission_request',
          toolId,
          description: String(escalation.reason ?? '需要越界能力'),
          allowAlways: false,
        });
        break;
      }
      case 'ask_user.request': {
        const requestId = String(p.requestId);
        const questions = (p.questions ?? []) as { question: string; options: string[] }[];
        const toolId = `ask-${requestId}`;
        state.permissionByTool.set(toolId, requestId);
        this.emit(sessionId, {
          type: 'tool_call_start', messageId: state.currentAssistantId, toolId, name: 'ask_user', input: questions,
        });
        this.emit(sessionId, {
          type: 'tool_permission_request',
          toolId,
          description: questions.map((q) => q.question).join(' / '),
          allowAlways: false,
        });
        break;
      }
      case 'todo.state': {
        const todos = (p.todos ?? []) as { id: string; content: string; status: string }[];
        this.emit(sessionId, {
          type: 'todo_update',
          todos: todos.map((t) => ({
            id: t.id,
            text: t.content,
            status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in_progress' : 'pending',
          })),
        });
        break;
      }
      case 'turn.done': {
        if (state.currentAssistantId) this.emit(sessionId, { type: 'message_end', messageId: state.currentAssistantId });
        break;
      }
      case 'turn.error':
      case 'error': {
        this.emit(sessionId, { type: 'error', message: String(p.message ?? '未知错误') });
        break;
      }
      default:
        break; // 未知 evt 静默丢弃（协议 §9）
    }
  }

  private emit(sessionId: string, e: AgentEvent): void {
    for (const h of this.handlers) h(sessionId, e);
  }
}

/** StoredMessage → 文本（webui 侧的最小结构性提取，不依赖后端类型）。 */
function storedText(msg: Record<string, unknown>): string {
  const parts = msg.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => {
      if (part && typeof part === 'object' && 'text' in (part as Record<string, unknown>)) {
        return String((part as Record<string, unknown>).text ?? '');
      }
      return '';
    })
    .join('');
}

/** attach 回放的 StoredMessage[] → HistoryMessage[]（store 的 history reducer 只认这个投影）。 */
function projectHistory(messages: Record<string, unknown>[]): HistoryMessage[] {
  return messages.map((m) => {
    const role = String(m.role) as HistoryMessage['role'];
    const toolCalls = Array.isArray(m.toolCalls)
      ? (m.toolCalls as Record<string, unknown>[]).map((c) => ({
          id: String(c.id ?? ''),
          name: String(c.name ?? ''),
          args: c.args,
        }))
      : undefined;
    return {
      msgid: Number(m.msgid ?? 0),
      role,
      text: storedText(m),
      ...(typeof m.reasoning === 'string' && m.reasoning !== '' ? { reasoning: m.reasoning } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(typeof m.toolCallId === 'string' ? { toolCallId: m.toolCallId } : {}),
      ...(role === 'tool' ? { output: storedText(m), ok: true } : {}),
    };
  });
}
