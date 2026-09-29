/** 无头渲染测试（bun test + happy-dom）：不启动浏览器验证 UI 设计行为。 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import type { Root } from 'react-dom/client';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register({ url: 'http://localhost/' });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { App } = await import('../src/app/App');
const { MockTransport } = await import('../src/transport/MockTransport');
const { useSessions, flushNow } = await import('../src/store/sessions');

const roots: Root[] = [];
let currentTransport: InstanceType<typeof MockTransport> | undefined;

function text(): string {
  return document.body.textContent ?? '';
}

async function renderApp(): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  currentTransport = new MockTransport();
  const transport = currentTransport;
  await act(async () => {
    root.render(<App transport={transport} />);
  });
}

afterEach(async () => {
  for (const r of roots.splice(0)) {
    await act(async () => {
      r.unmount();
    });
  }
  currentTransport = undefined;
});

async function send(text2: string): Promise<void> {
  // 通过 store 设置草稿，再点发送按钮（受控组件在 happy-dom 下不做 DOM 输入模拟）
  const id = useSessions.getState().activeId!;
  act(() => {
    useSessions.getState().setDraft(id, text2);
  });
  const btn = document.querySelector('.send-btn') as HTMLButtonElement;
  await act(async () => {
    btn.click();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.innerHTML = '';
  // 重置全局 store：测试之间标签互不残留
  useSessions.setState({ order: [], sessions: {}, activeId: null });
});

describe('WebUI 无头渲染（happy-dom）', () => {
  test('初始渲染：一个标签、输入框、空状态提示；无欢迎卡片/无品牌文案', async () => {
    await renderApp();
    expect(document.querySelectorAll('[role="tab"]').length).toBe(1);
    expect(document.querySelector('.composer textarea')).not.toBeNull();
    expect(text()).toContain('输入消息开始');
    // 克制守则：无装饰文案
    for (const banned of ['智能助手', 'Powered by', '有什么可以', '让我们开始', '释放', '为您服务']) {
      expect(text()).not.toContain(banned);
    }
  });

  test('流式 Markdown 场景：标题与表格渲染，未闭合 ** 不崩溃', async () => {
    await renderApp();
    await send('普通消息');
    await sleep(1600); // mock 分片流式 ~500 字符
    flushNow();
    expect(document.querySelector('.md h2')?.textContent).toContain('示例回复');
    expect(document.querySelectorAll('.md table tr').length).toBeGreaterThanOrEqual(3);
    expect(document.querySelector('.codeblock pre')?.textContent).toContain('export function add');
  });

  test('工具场景：连续 5 个调用合并为一行分组；失败项默认展开', async () => {
    await renderApp();
    await send('工具');
    await sleep(900);
    flushNow();
    expect(text()).toContain('执行了 5 个操作');
    expect(text()).toContain('运行 bun test');
    expect(text()).toContain('error TS2304'); // 失败输出默认可见
  });

  test('权限场景：权限卡出现，含"总是允许"；批准后卡片消失', async () => {
    await renderApp();
    await send('权限');
    await sleep(200);
    flushNow();
    expect(document.querySelector('.perm-card')).not.toBeNull();
    expect(text()).toContain('总是允许');
    expect(text()).toContain('允许');
    // 标签状态点变橙（waiting）
    const dot = document.querySelector('[role="tab"] .dot') as HTMLElement;
    expect(dot.dataset.status).toBe('waiting');
    // 点击"允许"
    const allowBtn = [...document.querySelectorAll('.perm-card .btn')].find((b) => b.textContent === '允许') as HTMLButtonElement;
    await act(async () => {
      allowBtn.click();
      await sleep(300);
    });
    flushNow();
    expect(document.querySelector('.perm-card')).toBeNull();
  });

  test('todo 场景：面板出现在输入框上方，默认 3 条，可展开全部', async () => {
    await renderApp();
    await send('todo');
    await sleep(700);
    flushNow();
    expect(document.querySelector('.todo-panel')).not.toBeNull();
    expect(document.querySelectorAll('.todo-item').length).toBe(3); // 默认折叠只显示 3 条
    expect(text()).toMatch(/\d\/4/); // 进度文字
    // 展开
    const head = document.querySelector('.todo-head') as HTMLButtonElement;
    await act(async () => {
      head.click();
    });
    expect(document.querySelectorAll('.todo-item').length).toBe(4);
    expect(text()).toContain('4/4');
  });

  test('错误场景：错误条出现，按钮变停止→恢复', async () => {
    await renderApp();
    await send('错误');
    await sleep(300);
    flushNow();
    expect(document.querySelector('.notice[data-kind="error"]')?.textContent).toContain('500');
  });

  test('标签独立：两个标签草稿互不影响', async () => {
    await renderApp();
    // 新建标签 Ctrl+T
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true }));
    });
    expect(document.querySelectorAll('[role="tab"]').length).toBe(2);
    const id1 = useSessions.getState().order[0]!;
    const id2 = useSessions.getState().order[1]!;
    await act(async () => {
      useSessions.getState().setDraft(id1, '草稿一');
      useSessions.getState().setActive(id2);
    });
    expect((document.querySelector('.composer textarea') as HTMLTextAreaElement).value).toBe('');
    await act(async () => {
      useSessions.getState().setActive(id1);
    });
    expect((document.querySelector('.composer textarea') as HTMLTextAreaElement).value).toBe('草稿一');
  });
});
