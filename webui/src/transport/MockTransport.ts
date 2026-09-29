import type { AgentEvent, AgentTransport, ToolDecision } from './types';

/** MockTransport（主 spec §9）：没有后端也能完整演示所有 UI。
 *  按输入关键字选择剧本；"总是允许"卡只在 permission 剧本中出现（协议 §6.1）。 */
export class MockTransport implements AgentTransport {
  private handlers = new Set<(sessionId: string, e: AgentEvent) => void>();
  private pending = new Map<string, (approved: boolean) => void>(); // toolId -> resolver
  private running = new Set<string>();

  onEvent(handler: (sessionId: string, e: AgentEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(sessionId: string, e: AgentEvent): void {
    for (const h of this.handlers) h(sessionId, e);
  }

  private async emitText(sessionId: string, id: string, text: string, chunk = 8, delayMs = 12): Promise<void> {
    for (let i = 0; i < text.length; i += chunk) {
      if (!this.running.has(sessionId)) return; // 已停止
      this.emit(sessionId, { type: 'text_delta', messageId: id, text: text.slice(i, i + chunk) });
      await sleep(delayMs);
    }
  }

  send(sessionId: string, text: string): void {
    if (this.running.has(sessionId)) return;
    this.running.add(sessionId);
    void this.run(sessionId, text).finally(() => this.running.delete(sessionId));
  }

  stop(sessionId: string): void {
    this.running.delete(sessionId);
  }

  approveTool(toolId: string, decision: ToolDecision): void {
    // mock 的剧本只关心是否放行；'always' 在真实协议里由服务端加规则，mock 无状态
    const resolve = this.pending.get(toolId);
    this.pending.delete(toolId);
    resolve?.(decision !== 'deny');
  }

  private async run(sessionId: string, text: string): Promise<void> {
    if (text.includes('权限')) return this.permissionScenario(sessionId);
    if (text.includes('工具')) return this.toolsScenario(sessionId);
    if (text.includes('todo')) return this.todoScenario(sessionId);
    if (text.includes('错误')) return this.errorScenario(sessionId);
    if (text.includes('思考')) return this.thinkingScenario(sessionId);
    return this.markdownScenario(sessionId, text);
  }

  private async start(sessionId: string, userText: string): Promise<string> {
    const uid = `u-${genId()}`;
    this.emit(sessionId, { type: 'message_start', messageId: uid, role: 'user' });
    this.emit(sessionId, { type: 'text_delta', messageId: uid, text: userText });
    this.emit(sessionId, { type: 'message_end', messageId: uid });
    const aid = `a-${genId()}`;
    this.emit(sessionId, { type: 'message_start', messageId: aid, role: 'assistant' });
    return aid;
  }

  /** 流式 Markdown：标题/列表/表格/代码块 + 末尾未闭合的 **（验收：未闭合语法不闪烁）。 */
  private async markdownScenario(sessionId: string, userText: string): Promise<void> {
    const aid = await this.start(sessionId, userText);
    const md = [
      '## 示例回复',
      '',
      '这里是一段说明文字，包含**加粗**、`行内代码`和[链接](https://example.com)。',
      '',
      '- 第一项',
      '- 第二项',
      '- 第三项',
      '',
      '| 列 A | 列 B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '| 3 | 4 |',
      '',
      '```ts',
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '```',
      '',
      '> 引用一行',
      '',
      '这一段结尾是未闭合的加粗 **',
    ].join('\n');
    await this.emitText(sessionId, aid, md);
    this.emit(sessionId, { type: 'message_end', messageId: aid });
  }

  /** 连续 5 个工具调用合并为一行分组，其中一个失败（验收项）。 */
  private async toolsScenario(sessionId: string, userText = '工具'): Promise<void> {
    const aid = await this.start(sessionId, userText);
    this.emit(sessionId, { type: 'text_delta', messageId: aid, text: '按顺序执行以下操作。\n\n' });
    const tools = [
      { id: 't1', name: 'read_file', input: { path: 'src/index.ts' }, output: 'export {};' },
      { id: 't2', name: 'exec', input: { command: 'bun test' }, output: '42 pass, 0 fail' },
      { id: 't3', name: 'read_file', input: { path: 'README.md' }, output: '# bugent' },
      { id: 't4', name: 'exec', input: { command: 'bun run build' }, output: 'error TS2304: Cannot find name "x"' },
      { id: 't5', name: 'write_file', input: { path: 'out.txt' }, output: 'ok' },
    ];
    for (const t of tools) {
      if (!this.running.has(sessionId)) return;
      this.emit(sessionId, { type: 'tool_call_start', messageId: aid, toolId: t.id, name: t.name, input: t.input });
      await sleep(60);
      const failed = t.id === 't4';
      this.emit(sessionId, {
        type: 'tool_call_end',
        toolId: t.id,
        status: failed ? 'error' : 'success',
        output: t.output,
        durationMs: 120,
      });
      await sleep(40);
    }
    this.emit(sessionId, { type: 'text_delta', messageId: aid, text: '\n\n完成。其中构建失败，需要处理。' });
    this.emit(sessionId, { type: 'message_end', messageId: aid });
  }

  /** 权限请求：允许 / 拒绝 / 总是允许（allowAlways = true，对应协议 permission.request）。 */
  private async permissionScenario(sessionId: string): Promise<void> {
    const aid = await this.start(sessionId, '权限');
    const toolId = 'perm-1';
    this.emit(sessionId, {
      type: 'tool_call_start', messageId: aid, toolId,
      name: 'exec', input: { command: 'npm publish' },
    });
    await sleep(50);
    this.emit(sessionId, {
      type: 'tool_permission_request',
      toolId,
      description: '运行 npm publish（需要网络与工作区外写入）',
      allowAlways: true,
    });
    const approved = await new Promise<boolean>((resolve) => this.pending.set(toolId, () => resolve(true)));
    if (!approved) {
      this.emit(sessionId, {
        type: 'tool_call_end', toolId, status: 'error', output: '用户拒绝了本次调用', durationMs: 0,
      });
    } else {
      await sleep(80);
      this.emit(sessionId, {
        type: 'tool_call_end', toolId, status: 'success', output: 'published', durationMs: 900,
      });
    }
    this.emit(sessionId, { type: 'message_end', messageId: aid });
  }

  private async todoScenario(sessionId: string): Promise<void> {
    const aid = await this.start(sessionId, 'todo');
    const mk = (i: number, text: string, status: 'pending' | 'in_progress' | 'done') => ({
      id: `td-${i}`, text, status,
    });
    this.emit(sessionId, {
      type: 'todo_update',
      todos: [mk(1, '读取配置', 'done'), mk(2, '修改实现', 'in_progress'), mk(3, '补测试', 'pending'), mk(4, '更新文档', 'pending')],
    });
    await this.emitText(sessionId, aid, '开始处理任务。\n\n');
    await sleep(120);
    this.emit(sessionId, {
      type: 'todo_update',
      todos: [mk(1, '读取配置', 'done'), mk(2, '修改实现', 'done'), mk(3, '补测试', 'in_progress'), mk(4, '更新文档', 'pending')],
    });
    await sleep(120);
    this.emit(sessionId, {
      type: 'todo_update',
      todos: [mk(1, '读取配置', 'done'), mk(2, '修改实现', 'done'), mk(3, '补测试', 'done'), mk(4, '更新文档', 'done')],
    });
    this.emit(sessionId, { type: 'text_delta', messageId: aid, text: '全部任务完成。' });
    this.emit(sessionId, { type: 'message_end', messageId: aid });
  }

  private async thinkingScenario(sessionId: string): Promise<void> {
    const aid = await this.start(sessionId, '思考');
    this.emit(sessionId, { type: 'thinking_delta', messageId: aid, text: '先分析问题，再决定方案。' });
    await sleep(150);
    await this.emitText(sessionId, aid, '结论如下：直接使用现有工具即可。');
    this.emit(sessionId, { type: 'message_end', messageId: aid });
  }

  private async errorScenario(sessionId: string): Promise<void> {
    const aid = await this.start(sessionId, '错误');
    await this.emitText(sessionId, aid, '正在执行');
    this.emit(sessionId, { type: 'error', message: '请求失败：服务端返回 500' });
  }
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
