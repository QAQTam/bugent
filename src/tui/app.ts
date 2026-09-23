/**
 * bugent 的 TUI 应用层（Phase 5 + Phase 8）。
 *
 * 全部建立在 Bun 原生能力上：Bun.markdown.ansi / Bun.wrapAnsi / Bun.stringWidth /
 * Bun.color，加上自己写的差分渲染器（Screen）和按键解析器（KeyDecoder）。
 * 没有任何第三方 TUI 依赖。
 *
 * 布局：
 *   ┌──────────────────────────────┐
 *   │ 状态栏            （1 行）    │
 *   │ 消息区            （h-2 行）  │
 *   │ 输入行            （1 行）    │
 *   └──────────────────────────────┘
 */

import type { Usage } from "../provider/types.ts";
import { runUserTurn, type LoopHooks } from "../core/loop.ts";
import type { AgentSession } from "../core/session.ts";
import type { ToolRegistry } from "../tools/types.ts";
import { Screen } from "./screen.ts";
import { Terminal } from "./term.ts";
import { KeyDecoder, type Key } from "./keys.ts";
import { BOLD, DIM, RESET, fg, renderMarkdown, renderPlain } from "./markdown.ts";
import { truncateAnsi, padAnsi, visibleWidth } from "./ansi.ts";
import { Transcript, type DisplayItem } from "./transcript.ts";
import { COLOR } from "./theme.ts";
import { renderToolItem } from "./renderers.ts";
import { registerBuiltinToolRenderers } from "./renderers-builtin.ts";
import { composeTodoPanel } from "./render-todo.ts";
import { currentTodos, type Todo } from "../tools/todo.ts";
import type { PermissionRequest } from "../permission/policy.ts";

export interface TuiOptions {
  session: AgentSession;
  tools: ToolRegistry;
  cwd: string;
  /** 启动时的欢迎语。 */
  banner?: string;
  /** 是否启用了沙箱，用于状态栏提示。 */
  sandboxEnabled?: boolean;
  /**
   * 新建对话时调用（`/new`）。
   * 省略则 `/new` 不可用 —— 调用方需要能创建并落盘一个新会话。
   */
  createSession?: () => AgentSession;
}

export class TuiApp {
  #terminal = new Terminal();
  #screen: Screen;
  #decoder = new KeyDecoder();

  #session: AgentSession;
  #tools: ToolRegistry;
  #cwd: string;
  #createSession: (() => AgentSession) | undefined;

  #transcript = new Transcript();
  #input = "";
  #cursor = 0;
  #scrollOffset = 0;
  #busy = false;
  #usage: Usage = { input: 0, output: 0 };
  #abort: AbortController | undefined;
  #renderScheduled = false;
  #resolveExit: (() => void) | undefined;
  #sandboxEnabled = false;

  /** 待用户确认的权限请求；存在时按键全部路由给它。 */
  #pendingPrompt: { request: PermissionRequest; resolve: (value: boolean) => void } | undefined;

  /** 待办派生的缓存（键 = 会话 id + 消息条数）。 */
  #todoCache: { key: string; todos: Todo[] } | undefined;

  constructor(options: TuiOptions) {
    // 注册内置工具的自定义外观（幂等）。放在构造函数里，
    // 保证任何入口构造 TuiApp 都能拿到，而不只是 CLI。
    registerBuiltinToolRenderers();

    this.#session = options.session;
    this.#tools = options.tools;
    this.#cwd = options.cwd;
    this.#createSession = options.createSession;
    this.#sandboxEnabled = options.sandboxEnabled === true;
    const { width, height } = this.#terminal.size;
    this.#screen = new Screen(width, height);
    if (options.banner !== undefined) {
      this.#transcript.pushNotice(options.banner);
    }
  }

  /**
   * 权限确认入口，供 PermissionGate 调用。
   * 会挂起当前 turn，直到用户按下 y / n。
   */
  askPermission(request: PermissionRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.#pendingPrompt = { request, resolve };
      this.#render();
    });
  }

  async run(): Promise<void> {
    this.#terminal.enter();
    const offData = this.#terminal.onData((chunk) => this.#handleKeys(this.#decoder.push(chunk)));
    const offResize = this.#terminal.onResize(() => this.#render(true));
    // 裸 ESC 需要超时才能确认（区别于转义序列前缀）
    const escapeTimer = setInterval(() => {
      const keys = this.#decoder.flush();
      if (keys.length > 0) this.#handleKeys(keys);
    }, 50);

    const exited = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });

    try {
      this.#render(true);
      await exited;
    } finally {
      clearInterval(escapeTimer);
      offData();
      offResize();
      this.#abort?.abort();
      this.#terminal.exit();
    }
  }

  /* --------------------------- 输入处理 --------------------------- */

  #handleKeys(keys: readonly Key[]): void {
    for (const key of keys) this.#handleKey(key);
  }

  #handleKey(key: Key): void {
    // 有权限弹窗时，所有按键都归它 —— 不能漏到下面的输入逻辑
    if (this.#pendingPrompt !== undefined) {
      this.#resolvePrompt(key);
      return;
    }

    switch (key.type) {
      case "ctrl":
        if (key.key === "c") this.#requestExit();
        else if (key.key === "d" && this.#input.length === 0) this.#requestExit();
        else if (key.key === "l") this.#render(true);
        return;

      case "escape":
        // 运行中按 ESC 中断当前轮
        this.#abort?.abort();
        return;

      case "enter":
        this.#submit();
        return;

      case "backspace": {
        if (this.#cursor === 0) return;
        const chars = Array.from(this.#input);
        chars.splice(this.#cursor - 1, 1);
        this.#input = chars.join("");
        this.#cursor -= 1;
        this.#render();
        return;
      }

      case "delete": {
        const chars = Array.from(this.#input);
        if (this.#cursor >= chars.length) return;
        chars.splice(this.#cursor, 1);
        this.#input = chars.join("");
        this.#render();
        return;
      }

      case "left":
        if (this.#cursor > 0) this.#cursor -= 1;
        this.#render();
        return;

      case "right":
        if (this.#cursor < Array.from(this.#input).length) this.#cursor += 1;
        this.#render();
        return;

      case "home":
        this.#cursor = 0;
        this.#render();
        return;

      case "end":
        this.#cursor = Array.from(this.#input).length;
        this.#render();
        return;

      case "up":
        this.#scrollBy(1);
        return;

      case "down":
        this.#scrollBy(-1);
        return;

      case "pageUp":
        this.#scrollBy(Math.max(1, this.#terminal.size.height - 4));
        return;

      case "pageDown":
        this.#scrollBy(-Math.max(1, this.#terminal.size.height - 4));
        return;

      case "tab": {
        this.#insert("  ");
        return;
      }

      case "text": {
        this.#insert(key.value);
        return;
      }
    }
  }

  #insert(text: string): void {
    const chars = Array.from(this.#input);
    chars.splice(this.#cursor, 0, ...Array.from(text));
    this.#input = chars.join("");
    this.#cursor += Array.from(text).length;
    this.#render();
  }

  #scrollBy(delta: number): void {
    this.#scrollOffset = Math.max(0, this.#scrollOffset + delta);
    this.#render();
  }

  #submit(): void {
    const text = this.#input.trim();
    if (text.length === 0) return;
    if (text === "/exit" || text === "/quit") {
      this.#requestExit();
      return;
    }
    if (text === "/new") {
      this.#startNewSession();
      return;
    }

    this.#input = "";
    this.#cursor = 0;
    this.#scrollOffset = 0;
    this.#transcript.pushUser(text);
    this.#render();
    void this.#runTurn(text);
  }

  /** `/new`：换一个全新会话，显示历史一并清空。 */
  #startNewSession(): void {
    if (this.#busy) {
      this.#transcript.pushError("当前一轮还在跑，先按 ESC 中断再开新对话");
      this.#render();
      return;
    }
    if (this.#createSession === undefined) {
      this.#transcript.pushError("当前未启用持久化，无法创建新对话");
      this.#render();
      return;
    }

    this.#input = "";
    this.#cursor = 0;
    this.#scrollOffset = 0;
    this.#usage = { input: 0, output: 0 };
    this.#session = this.#createSession();
    this.#transcript = new Transcript();
    this.#transcript.pushNotice(
      `已开始新对话：\`${this.#session.id}\`\n\n用 \`/resume\` 之外的会话请重启并加 \`--resume <id>\`。`,
    );
    this.#render(true);
  }

  #requestExit(): void {
    this.#resolveExit?.();
  }

  /** 处理权限弹窗里的按键。默认拒绝（Enter / Esc / 其它键都视为拒绝）。 */
  #resolvePrompt(key: Key): void {
    const pending = this.#pendingPrompt;
    if (pending === undefined) return;

    let answer: boolean | undefined;

    if (key.type === "text") {
      const value = key.value.trim().toLowerCase();
      if (value === "y" || value === "yes") answer = true;
      else if (value === "n" || value === "no") answer = false;
    } else if (key.type === "enter" || key.type === "escape") {
      answer = false;
    }

    if (answer === undefined) return;

    this.#pendingPrompt = undefined;
    pending.resolve(answer);
    this.#render();
  }

  /* --------------------------- 对话推进 --------------------------- */

  async #runTurn(input: string): Promise<void> {
    this.#busy = true;
    this.#abort = new AbortController();
    this.#render();

    const hooks: LoopHooks = {
      onText: (delta) => {
        this.#transcript.appendAssistantText(delta);
        this.#scheduleRender();
      },
      // 一条 assistant 消息结束：断开流式块，下一条消息另起一块。
      // 漏掉这一步会把"工具调用前的说明"和"最终答复"拼进同一行。
      onAssistant: () => {
        this.#transcript.endAssistant();
      },
      onToolCall: (call) => {
        this.#transcript.startTool(call);
        this.#scheduleRender();
      },
      onToolResult: (call, result) => {
        this.#transcript.finishTool(call.id, result.output, result.ok);
        this.#scheduleRender();
      },
      onUsage: (usage) => {
        this.#usage = Transcript.mergeUsage(this.#usage, usage);
        this.#scheduleRender();
      },
    };

    try {
      // runUserTurn 负责把用户消息写进 session —— 不要绕过它直接调 runTurn
      await runUserTurn(this.#session, input, {
        tools: this.#tools,
        cwd: this.#cwd,
        hooks,
        signal: this.#abort.signal,
      });
    } catch (error) {
      this.#transcript.pushError(error instanceof Error ? error.message : String(error));
    } finally {
      this.#transcript.endAssistant();
      this.#busy = false;
      this.#abort = undefined;
      this.#render();
    }
  }

  #scheduleRender(): void {
    if (this.#renderScheduled) return;
    this.#renderScheduled = true;
    setTimeout(() => {
      this.#renderScheduled = false;
      this.#render();
    }, 16);
  }

  /* --------------------------- 渲染 --------------------------- */

  #render(force = false): void {
    const { width, height } = this.#terminal.size;
    if (this.#screen.resize(width, height)) force = true;
    if (force) this.#screen.invalidate();

    const lines = this.#compose(width, height);
    const output = this.#screen.draw(lines);
    if (output.length > 0) this.#terminal.write(output);
  }

  #compose(width: number, height: number): string[] {
    // sticky 待办面板：不能吃掉太多屏幕，最多占 40% 且必须给消息区留位置
    const panelBudget = Math.max(0, Math.min(Math.floor(height * 0.4), height - 3));
    const todoPanel =
      panelBudget >= 2 ? composeTodoPanel(this.#todos(), width, { maxLines: panelBudget }) : [];

    const bodyHeight = Math.max(1, height - 2 - todoPanel.length);
    const body = this.#composeBody(width, bodyHeight);

    // 权限弹窗以覆盖层形式压在消息区底部
    if (this.#pendingPrompt !== undefined) {
      const overlay = this.#renderPrompt(width);
      const start = Math.max(0, bodyHeight - overlay.length);
      for (let i = 0; i < overlay.length && start + i < bodyHeight; i += 1) {
        body[start + i] = overlay[i]!;
      }
    }

    return [this.#composeStatus(width), ...body, ...todoPanel, this.#composeInput(width)];
  }

  /**
   * 当前待办（从消息历史派生）。
   *
   * 带缓存：渲染是 60fps 级别的，而派生要倒扫历史 ——
   * 没有 todo 的会话会每次都扫全量，白烧 CPU。
   */
  #todos(): Todo[] {
    const messages = this.#session.messages;
    const key = `${this.#session.id}:${messages.length}`;
    if (this.#todoCache === undefined || this.#todoCache.key !== key) {
      this.#todoCache = { key, todos: currentTodos(messages) };
    }
    return this.#todoCache.todos;
  }

  #renderPrompt(width: number): string[] {
    const pending = this.#pendingPrompt;
    if (pending === undefined) return [];

    const inner = Math.max(16, Math.min(width - 2, 74));
    const color = fg(COLOR.warn);
    const bar = `${color}│${RESET}`;
    const row = (text: string): string =>
      `${bar}${padAnsi(truncateAnsi(text, inner), inner)}${bar}`;

    return [
      `${color}┌${"─".repeat(inner)}┐${RESET}`,
      row(` ${BOLD}权限确认${RESET} ${DIM}${pending.request.tool}${RESET}`),
      row(` ${truncateAnsi(pending.request.summary, inner - 2)}`),
      row(""),
      row(
        ` ${fg(COLOR.ok)}[y]${RESET} 允许    ${fg(COLOR.error)}[n]${RESET} 拒绝    ${DIM}Esc / Enter 拒绝${RESET}`,
      ),
      `${color}└${"─".repeat(inner)}┘${RESET}`,
    ];
  }

  #composeStatus(width: number): string {
    const sandbox = this.#sandboxEnabled
      ? `${fg(COLOR.ok)}沙箱${RESET}`
      : `${fg(COLOR.warn)}无沙箱${RESET}`;
    const left = `${BOLD}bugent${RESET} ${DIM}${this.#session.client.id}${RESET} ${sandbox}`;
    const right = this.#busy
      ? `${fg(COLOR.busy)}● 运行中${RESET}`
      : `${DIM}turn ${this.#session.turn} · ↑${this.#usage.input} ↓${this.#usage.output}${
          this.#usage.cached !== undefined ? ` ⚡${this.#usage.cached}` : ""
        }${RESET}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return truncateAnsi(left + " ".repeat(gap) + right, width);
  }

  #composeInput(width: number): string {
    const prompt = `${fg(COLOR.prompt)}›${RESET} `;
    const available = Math.max(1, width - 2);
    const chars = Array.from(this.#input);

    // 水平滚动，保证光标可见
    let start = 0;
    while (start < this.#cursor && visibleWidth(chars.slice(start, this.#cursor).join("")) >= available) {
      start += 1;
    }

    let used = 0;
    let rendered = "";
    for (let i = start; i < chars.length; i += 1) {
      const char = chars[i]!;
      const charWidth = visibleWidth(char);
      if (used + charWidth > available) break;
      rendered += i === this.#cursor ? `\x1b[7m${char}\x1b[27m` : char;
      used += charWidth;
    }
    if (this.#cursor >= chars.length) rendered += "\x1b[7m \x1b[27m";

    return prompt + rendered;
  }

  #composeBody(width: number, height: number): string[] {
    const all: string[] = [];
    for (const item of this.#transcript.items) {
      all.push(...this.#renderItem(item, width));
      all.push("");
    }

    const total = all.length;
    if (total <= height) {
      const padded = all.slice();
      while (padded.length < height) padded.push("");
      return padded;
    }

    const end = this.#scrollOffset === 0 ? total : Math.max(height, total - this.#scrollOffset);
    const start = Math.max(0, end - height);
    return all.slice(start, end);
  }

  #renderItem(item: DisplayItem, width: number): string[] {
    switch (item.kind) {
      case "user": {
        const prefix = `${fg(COLOR.user)}›${RESET} `;
        const body = renderPlain(item.text, Math.max(1, width - 2));
        return body.map((line, index) => (index === 0 ? prefix + line : `  ${line}`));
      }

      case "assistant": {
        if (item.text.length === 0) return [DIM + "…" + RESET];
        return renderMarkdown(item.text, width);
      }

      case "tool":
        // 交给渲染扩展点：通用工具走默认外观，注册过的（如 todo_write）走自定义。
        // TUI 核心因此不需要认识任何具体工具名。
        return renderToolItem(item, width);

      case "error":
        return renderPlain(item.text, width).map((line) => `${fg(COLOR.error)}${line}${RESET}`);
    }
  }
}
