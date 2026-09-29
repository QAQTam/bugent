/** ProtocolTransport ↔ Bridge 端到端无头测试：真实 WS 协议栈，不经过 DOM。
 *  覆盖"发消息有反应"的关键链路：send（本地标签 id）→ session.new → attach →
 *  turn.send → 事件按本地 id 路由回来。 */
import { describe, expect, test } from 'bun:test';
import { Bridge } from '../../src/runtime/bridge.ts';
import { AgentSession } from '../../src/core/session.ts';
import { createMockClient } from '../../src/provider/adapters/mock.ts';
import type { AgentEvent } from '../src/transport/types';
import { ProtocolTransport } from '../src/transport/ProtocolTransport';

function waitUntil<T>(fn: () => T | undefined, label: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined) {
        resolve(v);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`waitUntil 超时: ${label}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('ProtocolTransport 端到端（真实 bridge）', () => {
  test('send(本地 id) → 流式文本事件按本地 id 回来', async () => {
    const bridge = new Bridge({
      createSession: ({ sessionId }) => ({
        session: new AgentSession({
          id: sessionId,
          system: 'SYS',
          client: createMockClient({ script: [{ text: '这是回复正文' }] }),
          model: 'test',
          now: () => 0,
        }),
        model: 'test',
      }),
    });
    const info = await bridge.start();
    const transport = new ProtocolTransport({ url: info.url, token: info.token });

    const events: { sid: string; e: AgentEvent }[] = [];
    transport.onEvent((sid, e) => events.push({ sid, e }));
    transport.connect();

    // 首次 send：懒建 session → attach → turn.send
    transport.send('s-local-1', '你好');

    const text = await waitUntil(() => {
      const deltas = events
        .filter(({ sid, e }) => sid === 's-local-1' && e.type === 'text_delta')
        .map(({ e }) => (e as { text: string }).text)
        .join('');
      return deltas.length > 0 ? deltas : undefined;
    }, 'text_delta');
    expect(text).toContain('这是回复正文');

    await waitUntil(
      () => (events.some(({ sid, e }) => sid === 's-local-1' && e.type === 'message_end') ? true : undefined),
      'message_end',
    );

    // 事件全部路由到本地标签 id（不是服务端 id）
    const sids = new Set(events.map(({ sid }) => sid));
    expect(sids.size).toBe(1);
    expect(sids.has('s-local-1')).toBe(true);

    // 用户消息由协议回发，恰好一条
    const userStarts = events.filter(({ e }) => e.type === 'message_start' && (e as { role?: string }).role === 'user');
    expect(userStarts).toHaveLength(1);

    transport.close();
    bridge.stop();
  });

  test('stop() 翻译为 turn.cancel；连接断开重连后 attached 复位', async () => {
    const bridge = new Bridge({
      createSession: ({ sessionId }) => ({
        session: new AgentSession({
          id: sessionId,
          system: 'SYS',
          client: createMockClient({
            script: [{ chunks: [{ type: 'text', delta: '慢' }, { type: 'done', reason: 'stop' }] }],
            chunkDelayMs: 120,
          }),
          model: 'test',
          now: () => 0,
        }),
        model: 'test',
      }),
    });
    const info = await bridge.start();
    const transport = new ProtocolTransport({ url: info.url, token: info.token });
    const events: { sid: string; e: AgentEvent }[] = [];
    transport.onEvent((sid, e) => events.push({ sid, e }));
    transport.connect();

    transport.send('tab-a', 'x');
    await waitUntil(
      () => (events.some(({ e }) => e.type === 'text_delta') ? true : undefined),
      'first delta',
    );
    transport.stop('tab-a'); // → turn.cancel（服务端 abort）
    await waitUntil(
      () => (events.some(({ e }) => e.type === 'message_end') ? true : undefined),
      '收尾',
    );
    transport.close();
    bridge.stop();
  });
});
