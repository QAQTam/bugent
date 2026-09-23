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
import { truncateAnsi, visibleWidth } from "./ansi.ts";

type DisplayItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; callId: string; name: string; args: unknown; output: string; ok: boolean; done: boolean }
  | { kind: "error"; text: string };

export interface TuiOptions {
  session: AgentSession;
  tools: ToolRegistry;
  cwd: string;
  /** 启动时的欢迎语。 */
  banner?: string;
}

const COLOR = {
  prompt: "#22d3ee",
  user: "#7dd3fc",
  tool: "#fbbf24",
  toolOk: "#94a3b8",
  error: "#f87171",
  busy: "#fbbf24",
};

export class TuiApp {
  #terminal = new Terminal();
  #screen: Screen;
  #decoder = new KeyDecoder();

  #session: AgentSession;
  #tools: ToolRegistry;
  #cwd: string;

  #items: DisplayItem[] = [];
  #input = "";
  #cursor = 0;
  #scrollOffset = 0;
  #busy = false;
  #usage: Usage = { input: 0, output: 0 };
  #abort: AbortController | undefined;
  #renderScheduled = false;
  #resolveExit: (() => void) | undefined;

  constructor(options: TuiOptions) {
    this.#session = options.session;
    this.#tools = options.tools;
    this.#cwd = options.cwd;
    const { width, height } = this.#terminal.size;
    this.#screen = new Screen(width, height);
    if (options.banner !== undefined) {
      this.#items.push({ kind: "assistant", text: options.banner });
    }
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

    this.#input = "";
    this.#cursor = 0;
    this.#scrollOffset = 0;
    this.#items.push({ kind: "user", text });
    this.#render();
    void this.#runTurn(text);
  }

  #requestExit(): void {
    this.#resolveExit?.();
  }

  /* --------------------------- 对话推进 --------------------------- */

  async #runTurn(input: string): Promise<void> {
    this.#busy = true;
    this.#abort = new AbortController();
    this.#items.push({ kind: "assistant", text: "" });
    const assistantIndex = this.#items.length - 1;
    this.#render();

    const hooks: LoopHooks = {
      onText: (delta) => {
        const item = this.#items[assistantIndex];
        if (item !== undefined && item.kind === "assistant") item.text += delta;
        this.#scheduleRender();
      },
      onToolCall: (call) => {
        this.#items.push({
          kind: "tool",
          callId: call.id,
          name: call.name,
          args: call.args,
          output: "",
          ok: true,
          done: false,
        });
        this.#scheduleRender();
      },
      onToolResult: (call, result) => {
        for (let i = this.#items.length - 1; i >= 0; i -= 1) {
          const item = this.#items[i];
          if (item !== undefined && item.kind === "tool" && item.callId === call.id && !item.done) {
            item.output = result.output;
            item.ok = result.ok;
            item.done = true;
            break;
          }
        }
        this.#scheduleRender();
      },
      onUsage: (usage) => {
        this.#usage = {
          input: this.#usage.input + usage.input,
          output: this.#usage.output + usage.output,
          ...(usage.cached !== undefined
            ? { cached: (this.#usage.cached ?? 0) + usage.cached }
            : this.#usage.cached !== undefined
              ? { cached: this.#usage.cached }
              : {}),
        };
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
      this.#items.push({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // 清掉空的 assistant 占位（比如被中断且没有任何输出）
      const placeholder = this.#items[assistantIndex];
      if (placeholder !== undefined && placeholder.kind === "assistant" && placeholder.text.length === 0) {
        this.#items.splice(assistantIndex, 1);
      }
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
    const bodyHeight = Math.max(1, height - 2);
    return [
      this.#composeStatus(width),
      ...this.#composeBody(width, bodyHeight),
      this.#composeInput(width),
    ];
  }

  #composeStatus(width: number): string {
    const left = `${BOLD}bugent${RESET} ${DIM}${this.#session.client.id}${RESET}`;
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
    for (const item of this.#items) {
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

      case "tool": {
        const argsText = safeJson(item.args);
        const budget = Math.max(0, width - visibleWidth(item.name) - 4);
        const head = `${fg(COLOR.tool)}⏺${RESET} ${BOLD}${item.name}${RESET} ${DIM}${truncateAnsi(
          argsText,
          budget,
        )}${RESET}`;
        const lines = [head];
        if (item.done) {
          const color = item.ok ? COLOR.toolOk : COLOR.error;
          for (const line of renderPlain(item.output, Math.max(1, width - 2))) {
            lines.push(`${DIM}${fg(color)}  ${line}${RESET}`);
          }
        }
        return lines;
      }

      case "error":
        return renderPlain(item.text, width).map((line) => `${fg(COLOR.error)}${line}${RESET}`);
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}
