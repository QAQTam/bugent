/** 数据层接口（主 spec §9）。前端只依赖这组事件/接口，后端对接只需实现适配器。
 *  与 docs/ui-protocol-spec.md §11 的翻译关系见 transport/ProtocolTransport.ts。
 *  对 spec 的最小扩展（非破坏，均带默认值）：
 *  - message_start 增加 role：协议侧 user.message / assistant.message 天然区分，mock 侧用于渲染；
 *  - tool_permission_request 增加 allowAlways：协议 §6.1 规定只有 permission.request 可"总是允许"，
 *    capability / ask_user 卡片不得渲染该按钮，UI 需要这个区分。 */

export type ToolStatus = 'running' | 'success' | 'error';

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export type AgentEvent =
  | { type: 'message_start'; messageId: string; role?: 'user' | 'assistant' }
  | { type: 'text_delta'; messageId: string; text: string }
  | { type: 'thinking_delta'; messageId: string; text: string }
  | { type: 'tool_call_start'; messageId: string; toolId: string; name: string; input: unknown }
  | {
      type: 'tool_call_end';
      toolId: string;
      status: 'success' | 'error';
      output: string;
      durationMs: number;
    }
  | { type: 'tool_permission_request'; toolId: string; description: string; allowAlways?: boolean }
  | {
      type: 'todo_update';
      todos: { id: string; text: string; status: 'pending' | 'in_progress' | 'done' }[];
    }
  | { type: 'message_end'; messageId: string }
  | { type: 'history'; messages: HistoryMessage[] }
  | { type: 'turn_running' }
  | { type: 'error'; message: string };

/** 回放消息的最小结构（协议 StoredMessage 的结构性投影，不引入后端类型依赖）。 */
export interface HistoryMessage {
  msgid: number;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'inject';
  text?: string;
  reasoning?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolCallId?: string;
  output?: string;
  ok?: boolean;
}

export type ToolDecision = 'allow' | 'deny' | 'always';

export interface AgentTransport {
  send(sessionId: string, text: string, attachments?: File[]): void;
  stop(sessionId: string): void;
  approveTool(toolId: string, decision: ToolDecision): void;
  /** 返回解订阅函数。 */
  onEvent(handler: (sessionId: string, e: AgentEvent) => void): () => void;
}
