/**
 * ask_user 的多页问答流程。
 *
 * 规格：
 *   - 最多 5 题，每题 2~4 个选项（A~D）+ 自由回答
 *   - 默认单选，显式 `multiple: true` 才是多选
 *   - ↑↓ 选择，e 输入自定义答案，←→ 翻页
 *   - 最后一页是汇总：Enter 提交，← 返回上一页
 *   - Esc 一次进入"待确认退出"，3 秒内再按一次才真的终止（abort）
 *
 * 状态机与渲染都放在这里，且**不碰终端** —— 定时器可注入，
 * 所以整个流程能在单测里跑完，不需要 PTY。
 */

import { BOLD, DIM, RESET, fg, renderPlain } from "./markdown.ts";
import { truncateAnsi, visibleWidth } from "./ansi.ts";
import { COLOR } from "./theme.ts";
import type { Key } from "./keys.ts";

export const MAX_QUESTIONS = 5;
export const MAX_OPTIONS = 4;
/** 两次 Esc 的间隔上限。 */
export const ESC_WINDOW_MS = 3000;

const OPTION_LABELS = ["A", "B", "C", "D"] as const;

export interface AskUserQuestion {
  question: string;
  options: string[];
  /** 显式声明多选；否则默认单选。 */
  multiple?: boolean;
}

export interface AskUserAnswer {
  question: string;
  /** 选中的选项下标（单选时最多一个）。 */
  selected: number[];
  /** 用户按 e 输入的自定义答案。 */
  custom?: string;
}

export type AskUserOutcome =
  | { kind: "pending" }
  | { kind: "submit"; answers: AskUserAnswer[] }
  | { kind: "abort" };

export interface AskUserOptions {
  questions: readonly AskUserQuestion[];
  /** 状态变化时触发重绘（含 Esc 窗口超时）。 */
  onChange?: () => void;
  /** 定时器注入，测试用。 */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

function labelOf(index: number): string {
  return OPTION_LABELS[index] ?? String(index + 1);
}

export class AskUserFlow {
  readonly questions: readonly AskUserQuestion[];

  #answers: AskUserAnswer[];
  /** 0..N-1 = 问题页；N = 汇总页。 */
  #page = 0;
  #cursor = 0;
  #typing = false;
  #buffer = "";

  #escArmed = false;
  #escTimer: unknown;

  #onChange: (() => void) | undefined;
  #setTimeout: (fn: () => void, ms: number) => unknown;
  #clearTimeout: (handle: unknown) => void;

  constructor(options: AskUserOptions) {
    this.questions = options.questions;
    this.#answers = options.questions.map((question) => ({ question: question.question, selected: [] }));
    this.#onChange = options.onChange;
    this.#setTimeout = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as number));
  }

  get page(): number {
    return this.#page;
  }

  get totalPages(): number {
    return this.questions.length + 1;
  }

  get isSummary(): boolean {
    return this.#page === this.questions.length;
  }

  get isTyping(): boolean {
    return this.#typing;
  }

  get escArmed(): boolean {
    return this.#escArmed;
  }

  get answers(): readonly AskUserAnswer[] {
    return this.#answers;
  }

  dispose(): void {
    this.#clearEscTimer();
  }

  /* ------------------------------ 按键 ------------------------------ */

  handleKey(key: Key): AskUserOutcome {
    // Esc 优先级最高，且任何其它键都会解除"待确认"状态
    if (key.type === "escape") return this.#handleEscape();
    this.#disarmEsc();

    if (this.#typing) return this.#handleTyping(key);
    if (this.isSummary) return this.#handleSummary(key);
    return this.#handleQuestion(key);
  }

  #handleEscape(): AskUserOutcome {
    if (this.#escArmed) {
      this.#disarmEsc();
      return { kind: "abort" };
    }

    this.#escArmed = true;
    this.#escTimer = this.#setTimeout(() => {
      this.#escArmed = false;
      this.#escTimer = undefined;
      this.#onChange?.();
    }, ESC_WINDOW_MS);

    this.#onChange?.();
    return { kind: "pending" };
  }

  #disarmEsc(): void {
    if (!this.#escArmed) return;
    this.#clearEscTimer();
    this.#escArmed = false;
  }

  #clearEscTimer(): void {
    if (this.#escTimer !== undefined) {
      this.#clearTimeout(this.#escTimer);
      this.#escTimer = undefined;
    }
  }

  #handleTyping(key: Key): AskUserOutcome {
    switch (key.type) {
      case "enter": {
        const text = this.#buffer.trim();
        this.#answers[this.#page] = {
          ...this.#answers[this.#page]!,
          ...(text.length > 0 ? { custom: text } : {}),
        };
        this.#typing = false;
        this.#buffer = "";
        this.#onChange?.();
        return { kind: "pending" };
      }
      case "escape":
        // 上面已处理；这里不可达，保留分支只为穷尽类型
        return { kind: "pending" };
      case "backspace":
        this.#buffer = [...this.#buffer].slice(0, -1).join("");
        this.#onChange?.();
        return { kind: "pending" };
      case "text":
        this.#buffer += key.value;
        this.#onChange?.();
        return { kind: "pending" };
      default:
        return { kind: "pending" };
    }
  }

  #handleQuestion(key: Key): AskUserOutcome {
    const question = this.questions[this.#page]!;
    const count = question.options.length;
    const multiple = question.multiple === true;
    const answer = this.#answers[this.#page]!;

    switch (key.type) {
      case "up":
        if (count > 0) this.#cursor = (this.#cursor - 1 + count) % count;
        if (!multiple && count > 0) this.#select(this.#page, [this.#cursor]);
        this.#onChange?.();
        return { kind: "pending" };

      case "down":
        if (count > 0) this.#cursor = (this.#cursor + 1) % count;
        if (!multiple && count > 0) this.#select(this.#page, [this.#cursor]);
        this.#onChange?.();
        return { kind: "pending" };

      case "text": {
        // 空格必须用**原始值**判断 —— trim 之后 " " 就变成 "" 了，勾选会失灵
        if (key.value === " " && multiple && count > 0) {
          this.#toggle(this.#page, this.#cursor);
          this.#onChange?.();
          return { kind: "pending" };
        }

        const value = key.value.trim();

        // e -> 进入自定义输入
        if (value === "e" || value === "E") {
          this.#typing = true;
          this.#buffer = answer.custom ?? "";
          this.#onChange?.();
          return { kind: "pending" };
        }

        // A~D 快捷选择
        const letter = value.toUpperCase();
        const index = (OPTION_LABELS as readonly string[]).indexOf(letter);
        if (index >= 0 && index < count) {
          this.#cursor = index;
          if (multiple) this.#toggle(this.#page, index);
          else this.#select(this.#page, [index]);
          this.#onChange?.();
        }
        return { kind: "pending" };
      }

      case "enter":
      case "right":
        return this.#goNext();

      case "left":
        return this.#goPrev();

      default:
        return { kind: "pending" };
    }
  }

  #handleSummary(key: Key): AskUserOutcome {
    switch (key.type) {
      case "enter":
        return { kind: "submit", answers: this.#answers.map((a) => ({ ...a })) };
      case "left":
        this.#page = Math.max(0, this.#page - 1);
        this.#syncCursor();
        this.#onChange?.();
        return { kind: "pending" };
      default:
        return { kind: "pending" };
    }
  }

  #goNext(): AskUserOutcome {
    this.#page = Math.min(this.questions.length, this.#page + 1);
    this.#syncCursor();
    this.#onChange?.();
    return { kind: "pending" };
  }

  #goPrev(): AskUserOutcome {
    this.#page = Math.max(0, this.#page - 1);
    this.#syncCursor();
    this.#onChange?.();
    return { kind: "pending" };
  }

  /** 翻页后把光标对到已选项上，避免"明明选了却停在 A"。 */
  #syncCursor(): void {
    const answer = this.#answers[this.#page];
    if (answer === undefined || answer.selected.length === 0) {
      this.#cursor = 0;
      return;
    }
    this.#cursor = answer.selected[0] ?? 0;
  }

  #select(page: number, selected: number[]): void {
    this.#answers[page] = { ...this.#answers[page]!, selected };
  }

  #toggle(page: number, index: number): void {
    const answer = this.#answers[page]!;
    const has = answer.selected.includes(index);
    this.#select(
      page,
      has ? answer.selected.filter((i) => i !== index) : [...answer.selected, index].sort((a, b) => a - b),
    );
  }

  /* ------------------------------ 渲染 ------------------------------ */

  /** 生成对话框内容（不含外框，外框由 TuiApp 统一画）。 */
  render(width: number): string[] {
    const inner = Math.max(20, width - 4);
    if (this.isSummary) return this.#renderSummary(inner);
    if (this.#typing) return this.#renderTyping(inner);
    return this.#renderQuestion(inner);
  }

  #pageHeader(question: AskUserQuestion, inner: number): string {
    const mode = question.multiple === true ? "多选" : "单选";
    const title = `问题 ${this.#page + 1}/${this.questions.length} · ${mode}`;
    const bar = `${DIM}${"─".repeat(Math.max(0, inner - visibleWidth(title) - 1))}${RESET}`;
    return `${BOLD}${title}${RESET} ${bar}`;
  }

  #renderQuestion(inner: number): string[] {
    const question = this.questions[this.#page]!;
    const multiple = question.multiple === true;
    const answer = this.#answers[this.#page]!;
    const lines: string[] = [this.#pageHeader(question, inner), ""];

    for (const line of renderPlain(question.question, inner - 2)) lines.push(line);
    lines.push("");

    if (question.options.length === 0) {
      lines.push(`${DIM}（本题无选项，按 e 直接输入回答）${RESET}`);
    } else {
      for (let index = 0; index < question.options.length; index += 1) {
        const active = index === this.#cursor;
        const chosen = answer.selected.includes(index);
        const marker = active ? `${fg(COLOR.prompt)}▸${RESET}` : " ";
        const box = multiple ? (chosen ? "[x]" : "[ ]") : chosen ? "(●)" : "( )";
        const label = `${labelOf(index)}.`;
        const text = truncateAnsi(question.options[index] ?? "", inner - 12);
        const color = active ? COLOR.inputText : COLOR.toolOk;
        lines.push(`${marker} ${fg(color)}${box} ${label} ${text}${RESET}`);
      }
    }

    if (answer.custom !== undefined) {
      lines.push("");
      lines.push(`${DIM}自定义：${RESET}${truncateAnsi(answer.custom, inner - 10)}`);
    }

    lines.push("");
    lines.push(
      multiple
        ? `${DIM}↑↓ 移动   Space 勾选   Enter 下一题   e 自定义   ←→ 翻页${RESET}`
        : `${DIM}↑↓ 选择   Enter 下一题   e 自定义   ←→ 翻页${RESET}`,
    );
    lines.push(...this.#escHint());
    return lines;
  }

  #renderTyping(inner: number): string[] {
    const question = this.questions[this.#page]!;
    const lines = [this.#pageHeader(question, inner), ""];
    for (const line of renderPlain(question.question, inner - 2)) lines.push(line);
    lines.push("");
    lines.push(`${fg(COLOR.prompt)}▸${RESET} ${this.#buffer}\x1b[7m \x1b[27m`);
    lines.push("");
    lines.push(`${DIM}Enter 确认   Backspace 删除   Esc 取消${RESET}`);
    return lines;
  }

  #renderSummary(inner: number): string[] {
    const title = `汇总 · 共 ${this.questions.length} 题`;
    const bar = `${DIM}${"─".repeat(Math.max(0, inner - visibleWidth(title) - 1))}${RESET}`;
    const lines: string[] = [`${BOLD}${title}${RESET} ${bar}`, ""];

    for (let index = 0; index < this.questions.length; index += 1) {
      const question = this.questions[index]!;
      const answer = this.#answers[index]!;

      lines.push(`${BOLD}${index + 1}.${RESET} ${truncateAnsi(question.question, inner - 4)}`);

      const picked = answer.selected
        .map((optionIndex) => `${labelOf(optionIndex)}. ${question.options[optionIndex] ?? ""}`)
        .join("，");

      if (picked.length > 0) {
        lines.push(`   ${fg(COLOR.ok)}→${RESET} ${truncateAnsi(picked, inner - 6)}`);
      }
      if (answer.custom !== undefined) {
        lines.push(`   ${fg(COLOR.tool)}✎${RESET} ${truncateAnsi(answer.custom, inner - 6)}`);
      }
      if (picked.length === 0 && answer.custom === undefined) {
        lines.push(`   ${DIM}（未回答）${RESET}`);
      }
      lines.push("");
    }

    lines.push(`${DIM}Enter 确认提交   ← 返回上一页${RESET}`);
    lines.push(...this.#escHint());
    return lines;
  }

  #escHint(): string[] {
    if (!this.#escArmed) return [`${DIM}Esc 退出${RESET}`];
    return [
      `${fg(COLOR.error)}⚠ 再按一次 Esc 终止回答（${ESC_WINDOW_MS / 1000} 秒内）${RESET}`,
    ];
  }
}

/** 把答案渲染成回传给模型的文本。 */
export function formatAnswers(answers: readonly AskUserAnswer[]): string {
  const blocks = answers.map((answer, index) => {
    const lines = [`${index + 1}. ${answer.question}`];

    if (answer.selected.length > 0) {
      lines.push(`   选择：${answer.selected.map((i) => labelOf(i)).join("、")}`);
    }
    if (answer.custom !== undefined) {
      lines.push(`   补充：${answer.custom}`);
    }
    if (answer.selected.length === 0 && answer.custom === undefined) {
      lines.push("   回答：（用户未作答）");
    }

    return lines.join("\n");
  });

  return blocks.join("\n\n");
}
