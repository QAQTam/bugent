/** 纯 reducer 逻辑测试（无 DOM，快速验证数据层设计规则）。 */
import { describe, expect, test } from 'bun:test';
import { reduceSession, type SessionVM } from '../src/store/sessions';
import type { AgentEvent } from '../src/transport/types';

function empty(): SessionVM {
  return {
    id: 's1',
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

function userMsg(id: string, text: string): AgentEvent[] {
  return [
    { type: 'message_start', messageId: id, role: 'user' },
    { type: 'text_delta', messageId: id, text },
    { type: 'message_end', messageId: id },
  ];
}

function applyAll(s: SessionVM, events: AgentEvent[]): SessionVM {
  return events.reduce((acc, e) => reduceSession(acc, e), s);
}

describe('reduceSession', () => {
  test('连续 5 个工具调用合并为一个分组（spec §4.2）', () => {
    const events: AgentEvent[] = [
      ...userMsg('u1', '工具'),
      { type: 'message_start', messageId: 'a1', role: 'assistant' },
      ...[1, 2, 3, 4, 5].map((i) => ({
        type: 'tool_call_start' as const,
        messageId: 'a1',
        toolId: `t${i}`,
        name: 'exec',
        input: { command: `cmd ${i}` },
      })),
      ...[1, 2, 3, 4, 5].map((i) => ({
        type: 'tool_call_end' as const,
        toolId: `t${i}`,
        status: 'success' as const,
        output: 'ok',
        durationMs: 100,
      })),
    ];
    const s = applyAll(empty(), events);
    expect(s.messages).toHaveLength(2);
    const blocks = s.messages[1]!.blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe('group');
    if (blocks[0]!.kind === 'group') expect(blocks[0]!.items).toHaveLength(5);
  });

  test('文本会打断工具分组：text → tool → text → tool 产生两个分组', () => {
    const events: AgentEvent[] = [
      { type: 'message_start', messageId: 'a1', role: 'assistant' },
      { type: 'text_delta', messageId: 'a1', text: '前' },
      { type: 'tool_call_start', messageId: 'a1', toolId: 't1', name: 'exec', input: {} },
      { type: 'text_delta', messageId: 'a1', text: '中' },
      { type: 'tool_call_start', messageId: 'a1', toolId: 't2', name: 'exec', input: {} },
    ];
    const s = applyAll(empty(), events);
    const kinds = s.messages[0]!.blocks.map((b) => b.kind);
    expect(kinds).toEqual(['text', 'group', 'text', 'group']);
  });

  test('失败的工具默认展开，成功的默认折叠（spec §4.1）', () => {
    let s = applyAll(empty(), [
      { type: 'message_start', messageId: 'a1', role: 'assistant' },
      { type: 'tool_call_start', messageId: 'a1', toolId: 't1', name: 'exec', input: {} },
    ]);
    s = applyAll(s, [
      { type: 'tool_call_end', toolId: 't1', status: 'error', output: 'boom', durationMs: 5 },
    ]);
    const tool = (s.messages[0]!.blocks[0] as unknown as { kind: 'group'; items: { open?: boolean }[] }).items[0]!;
    expect(tool.open).toBe(true);

    s = applyAll(s, [
      { type: 'tool_call_start', messageId: 'a1', toolId: 't2', name: 'exec', input: {} },
      { type: 'tool_call_end', toolId: 't2', status: 'success', output: 'ok', durationMs: 5 },
    ]);
    const t2 = (s.messages[0]!.blocks[0] as unknown as { kind: 'group'; items: { open?: boolean }[] }).items[1]!;
    expect(t2.open).toBe(false);
  });

  test('写时克隆：未修改的消息保持引用稳定（React.memo 流式性能前提）', () => {
    const s0 = applyAll(empty(), userMsg('u1', '第一条'));
    const m0 = s0.messages[0]!;
    const s1 = applyAll(s0, [{ type: 'message_start', messageId: 'a1', role: 'assistant' }]);
    const blockBefore = s1.messages[1]!.blocks[0];
    const s2 = applyAll(s1, [{ type: 'text_delta', messageId: 'a1', text: '增量' }]);
    expect(s2.messages[0]).toBe(m0); // 未修改的消息引用不变
    expect(s2.messages[1]).not.toBe(s1.messages[1]); // 修改过的消息是新对象
    expect(s2.messages[1]!.blocks[0]).not.toBe(blockBefore); // block 也是新对象
  });

  test('标题取第一条用户消息前 20 字（spec §2）', () => {
    const s = applyAll(empty(), userMsg('u1', '这是一条很长很长的用户输入用来测试标题截断逻辑对不对'));
    expect(s.title).toBe('这是一条很长很长的用户输入用来测试标题截');
    expect(s.title).toHaveLength(20);
  });

  test('权限请求：allowAlways 缺省为 false（capability / ask_user 不渲染"总是允许"，协议 §6.1）', () => {
    let s = applyAll(empty(), [
      { type: 'message_start', messageId: 'a1', role: 'assistant' },
      { type: 'tool_call_start', messageId: 'a1', toolId: 't1', name: 'exec', input: {} },
      { type: 'tool_permission_request', toolId: 't1', description: '需要越界能力' },
    ]);
    const tool = (s.messages[0]!.blocks[0] as unknown as { kind: 'group'; items: [{ permission?: { allowAlways: boolean } }] }).items[0]!;
    expect(tool.permission?.allowAlways).toBe(false);
    expect(s.status).toBe('waiting');

    s = applyAll(s, [
      { type: 'tool_permission_request', toolId: 't1', description: '运行 npm publish', allowAlways: true },
    ]);
    const tool2 = (s.messages[0]!.blocks[0] as unknown as { kind: 'group'; items: [{ permission?: { allowAlways: boolean } }] }).items[0]!;
    expect(tool2.permission?.allowAlways).toBe(true);
  });

  test('todo_update 与 message_end 状态推导', () => {
    let s = applyAll(empty(), [
      ...userMsg('u1', 'todo'),
      { type: 'message_start', messageId: 'a1', role: 'assistant' },
      { type: 'turn_running' },
      {
        type: 'todo_update',
        todos: [
          { id: '1', text: 'a', status: 'done' },
          { id: '2', text: 'b', status: 'in_progress' },
          { id: '3', text: 'c', status: 'pending' },
          { id: '4', text: 'd', status: 'pending' },
        ],
      },
    ]);
    expect(s.todos).toHaveLength(4);
    expect(s.status).toBe('running');
    s = applyAll(s, [{ type: 'message_end', messageId: 'a1' }]);
    expect(s.status).toBe('idle');
  });

  test('history 回放：user/assistant/tool 消息重建视图（协议 §7）', () => {
    const s = applyAll(empty(), [
      {
        type: 'history',
        messages: [
          { msgid: 1, role: 'user', text: '你好' },
          {
            msgid: 2,
            role: 'assistant',
            text: '回答',
            toolCalls: [{ id: 'c1', name: 'exec', args: { command: 'ls' } }],
          },
          { msgid: 3, role: 'tool', toolCallId: 'c1', output: 'file.txt', ok: true },
        ],
      },
    ]);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]!.role).toBe('user');
    const assistant = s.messages[1]!;
    const tool = assistant.blocks.find((b): b is Extract<typeof b, { kind: 'tool' }> => b.kind === 'tool');
    if (tool) {
      expect(tool.status).toBe('success');
      expect(tool.output).toBe('file.txt');
    } else {
      throw new Error('工具块未重建');
    }
  });
});
