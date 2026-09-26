/**
 * 设置面板（`/setting`）—— 停在屏幕正中的浮层设置表。
 *
 * 与 ask_user 的区别：ask 是"问一次就结束"的表单，本面板是**可停留**的设置表 ——
 * 每行一个配置项，改完不关闭，直到用户显式退出。所以它自己持有焦点行、滚动
 * 窗口与编辑态。
 *
 * 三件事刻意分开，各自可单测：
 *   1. 状态机（本文件，不碰终端、不碰屏幕坐标）
 *   2. 居中几何（`centeredPanelTop` / `panelContentBudget`，纯函数）
 *   3. 屏幕坐标换算（app.ts 的 `#compose`，全项目唯一一处）
 *
 * 行内容与宿主状态解耦：面板只认 `SettingsRow` 这五个回调（display / options /
 * enabled / apply / invoke），不认 provider、沙箱、MCP 这些概念。宿主负责把
 * "档位"编译成一行 enum、"启停某个 MCP server"编译成一行 toggle。
 */

import { BOLD, DIM, RESET, bg, fg } from "./markdown.ts";
import { padAnsi, truncateAnsi, visibleWidth } from "./ansi.ts";
import { COLOR } from "./theme.ts";
import type { Key } from "./keys.ts";

export type SettingsRowKind = "enum" | "toggle" | "text" | "action";

export interface SettingsRow {
  /** 稳定标识（单测与日志用，不参与渲染）。 */
  id: string;
  /** 分组名；相邻同组只画一次组标题。 */
  section: string;
  label: string;
  kind: SettingsRowKind;
  /** 右侧当前值；action / toggle 行可以省略（toggle 由面板画成 开 / 关）。 */
  display?: () => string;
  /** enum 的候选值，顺序即 ←→ 的方向。 */
  options?: readonly string[];
  /** toggle 的当前状态。 */
  enabled?: () => boolean;
  /** enum / toggle / text 的提交入口。 */
  apply?: (value: string) => void | Promise<void>;
  /** action 行回车时执行。 */
  invoke?: () => void | Promise<void>;
  /** 返回非空 = 该行只读，原因显示在右侧（仍可聚焦，用户能看到为什么改不了）。 */
  blocked?: () => string | undefined;
  /** text 行按掩码显示，且空提交表示"保持现值"。 */
  secret?: boolean;
}

/* ------------------------------------------------------------------ */
/* 居中几何（纯函数）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 面板首行的**上方占用行数**（0-based，与 `#dialogTopRow` 同一口径）。
 *
 * 上下各留一半余量 —— 这就是"真的终端中间"，而不是贴着正文底部。
 * 返回 0 表示放不下（调用方应改用别的形态），正常尺寸下不会发生。
 */
export function centeredPanelTop(height: number, rows: number): number {
  if (height <= 0 || rows <= 0) return 0;
  const room = height - rows;
  if (room <= 0) return 0;
  // 至少压住状态栏下面一行，否则面板会盖住状态栏
  return Math.min(Math.max(1, Math.floor(room / 2)), room);
}

/** 居中面板在给定终端高度下的最大行数（含边框）：上下各留 2 行呼吸位。 */
export function panelRowBudget(height: number): number {
  return Math.max(3, height - 4);
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

export interface SettingsPanelRender {
  lines: string[];
  /** 面板局部行号 -> 行下标；鼠标命中与自检共用。 */
  rowLines: Map<number, number>;
  /** 编辑态的硬件光标（面板局部坐标：行号 0-based、列号 0-based）。 */
  cursor?: { line: number; column: number };
}

export type SettingsKeyOutcome = "handled" | "close" | "none";

export interface SettingsPanelOptions {
  rows: readonly SettingsRow[];
  /** 标题行右侧的补充说明，例如当前 session id。 */
  subtitle?: string;
  /** 请求宿主重绘。 */
  onChange?: () => void;
}

/** 左侧留白（宿主还会再加一圈边框）。 */
const LEADING = 1;
/** 焦点标记占的列数（`▸ ` 或 `  `）。 */
const MARKER_WIDTH = 2;

interface WindowPlan {
  start: number;
  end: number;
  /** 需要画组标题的行下标。 */
  headers: number[];
}

export class SettingsPanel {
  readonly rows: readonly SettingsRow[];
  readonly subtitle: string | undefined;

  #cursor = 0;
  #scroll = 0;
  /** 键盘移动光标时窗口跟随；滚轮滚动后不再硬拉回光标。 */
  #followCursor = true;
  #hovered: number | undefined;
  #pressed: number | undefined;
  #editing: { row: number; buffer: string; cursor: number } | undefined;
  #onChange: (() => void) | undefined;

  constructor(options: SettingsPanelOptions) {
    this.rows = options.rows;
    this.subtitle = options.subtitle;
    this.#onChange = options.onChange;
  }

  get rowCount(): number {
    return this.rows.length;
  }

  get cursorRow(): number {
    return this.#cursor;
  }

  get editingRow(): number | undefined {
    return this.#editing?.row;
  }

  get hoveredRow(): number | undefined {
    return this.#hovered;
  }

  get pressedRow(): number | undefined {
    return this.#pressed;
  }

  #rowAt(index: number): SettingsRow | undefined {
    return this.rows[index];
  }

  #touch(): void {
    this.#onChange?.();
  }

  /* --------------------------- 状态变更 --------------------------- */

  /** 光标移动（自动换行）。返回是否真的动了。 */
  moveCursor(delta: number): boolean {
    const count = this.rows.length;
    if (count === 0) return false;
    const next = ((this.#cursor + delta) % count + count) % count;
    if (next === this.#cursor) return false;
    this.#cursor = next;
    this.#followCursor = true;
    this.#touch();
    return true;
  }

  /** 滚轮：只移动窗口，不动光标（光标留在原地，键盘一动再拉回来）。 */
  scrollViewport(delta: number): boolean {
    const maxStart = Math.max(0, this.rows.length - 1);
    const next = Math.min(maxStart, Math.max(0, this.#scroll + delta));
    if (next === this.#scroll) return false;
    this.#scroll = next;
    this.#followCursor = false;
    this.#touch();
    return true;
  }

  setHover(row: number | undefined): void {
    if (this.#hovered === row) return;
    this.#hovered = row;
    this.#touch();
  }

  setPressed(row: number | undefined): void {
    if (this.#pressed === row) return;
    this.#pressed = row;
    this.#touch();
  }

  /** 单击一行：先选中；点已经选中的那一行才激活（列表的常规语义）。 */
  clickRow(row: number): void {
    if (row < 0 || row >= this.rows.length) return;
    if (this.#editing !== undefined && this.#editing.row !== row) this.#commitEdit();
    if (this.#cursor !== row) {
      this.#cursor = row;
      this.#followCursor = true;
      this.#touch();
      return;
    }
    this.activate(row);
  }

  /** 回车 / 再次点击：按行类型执行。 */
  activate(row = this.#cursor): void {
    const spec = this.#rowAt(row);
    if (spec === undefined) return;
    if (spec.blocked?.() !== undefined) {
      this.#touch();
      return;
    }
    switch (spec.kind) {
      case "enum":
        this.cycle(1, row);
        return;
      case "toggle": {
        const next = !(spec.enabled?.() ?? false);
        void spec.apply?.(next ? "true" : "false");
        this.#touch();
        return;
      }
      case "text":
        this.#beginEdit(row, spec);
        return;
      case "action":
        void spec.invoke?.();
        this.#touch();
        return;
    }
  }

  /** ←→：在候选值之间切换（当前值不在候选里时从第一个开始）。 */
  cycle(direction: 1 | -1, row = this.#cursor): boolean {
    const spec = this.#rowAt(row);
    if (spec === undefined || spec.kind !== "enum" || spec.blocked?.() !== undefined) return false;
    const options = spec.options ?? [];
    if (options.length === 0) return false;
    const current = spec.display?.() ?? "";
    const index = options.indexOf(current);
    const next =
      index < 0
        ? direction > 0
          ? 0
          : options.length - 1
        : ((index + direction) % options.length + options.length) % options.length;
    const value = options[next];
    if (value === undefined) return false;
    void spec.apply?.(value);
    this.#touch();
    return true;
  }

  #beginEdit(row: number, spec: SettingsRow): void {
    const current = spec.display?.() ?? "";
    this.#editing = {
      row,
      // 密钥行绝不回填：掩码显示的是长度，回填等于把已存的 key 变成可见初值。
      buffer: spec.secret === true ? "" : current,
      cursor: spec.secret === true ? 0 : Array.from(current).length,
    };
    this.#touch();
  }

  #commitEdit(): void {
    const editing = this.#editing;
    this.#editing = undefined;
    if (editing === undefined) return;
    const spec = this.#rowAt(editing.row);
    if (spec === undefined) return;
    // 空提交 = 保持现值（密钥行尤其重要：回车不该把 key 清空）
    if (editing.buffer.length === 0) {
      this.#touch();
      return;
    }
    void spec.apply?.(editing.buffer);
    this.#touch();
  }

  #cancelEdit(): void {
    if (this.#editing === undefined) return;
    this.#editing = undefined;
    this.#touch();
  }

  /* --------------------------- 按键 --------------------------- */

  handleKey(key: Key): SettingsKeyOutcome {
    if (this.#editing !== undefined) return this.#handleEditKey(key);

    switch (key.type) {
      case "up":
        return this.moveCursor(-1) ? "handled" : "none";
      case "down":
        return this.moveCursor(1) ? "handled" : "none";
      case "pageUp":
        return this.moveCursor(-5) ? "handled" : "none";
      case "pageDown":
        return this.moveCursor(5) ? "handled" : "none";
      case "home":
        return this.moveCursor(-this.#cursor) ? "handled" : "none";
      case "end":
        return this.moveCursor(this.rows.length - 1 - this.#cursor) ? "handled" : "none";
      case "left":
        return this.cycle(-1) ? "handled" : "none";
      case "right":
        return this.cycle(1) ? "handled" : "none";
      case "enter":
      case "newline":
        this.activate();
        return "handled";
      case "tab":
        return this.#jumpSection(1) ? "handled" : "none";
      case "escape":
        return "close";
      case "text": {
        const value = key.value;
        if (value === "q" || value === "Q") return "close";
        if (value === "j") return this.moveCursor(1) ? "handled" : "none";
        if (value === "k") return this.moveCursor(-1) ? "handled" : "none";
        if (value === "h") return this.cycle(-1) ? "handled" : "none";
        if (value === "l") return this.cycle(1) ? "handled" : "none";
        if (value === " ") {
          this.activate();
          return "handled";
        }
        return "none";
      }
      default:
        return "none";
    }
  }

  /** Tab：跳到下一个分组的第一行。 */
  #jumpSection(direction: 1 | -1): boolean {
    const count = this.rows.length;
    if (count === 0) return false;
    const section = this.#rowAt(this.#cursor)?.section;
    for (let step = 1; step <= count; step += 1) {
      const index = ((this.#cursor + direction * step) % count + count) % count;
      if (this.#rowAt(index)?.section !== section) {
        this.#cursor = index;
        this.#followCursor = true;
        this.#touch();
        return true;
      }
    }
    return false;
  }

  #handleEditKey(key: Key): SettingsKeyOutcome {
    const editing = this.#editing;
    if (editing === undefined) return "none";

    const insert = (text: string): void => {
      const chars = Array.from(editing.buffer);
      chars.splice(editing.cursor, 0, ...Array.from(text));
      editing.buffer = chars.join("");
      editing.cursor += Array.from(text).length;
      this.#touch();
    };

    switch (key.type) {
      case "text":
      case "paste":
        insert(key.value);
        return "handled";
      case "backspace": {
        if (editing.cursor === 0) return "handled";
        const chars = Array.from(editing.buffer);
        chars.splice(editing.cursor - 1, 1);
        editing.buffer = chars.join("");
        editing.cursor -= 1;
        this.#touch();
        return "handled";
      }
      case "delete": {
        const chars = Array.from(editing.buffer);
        if (editing.cursor >= chars.length) return "handled";
        chars.splice(editing.cursor, 1);
        editing.buffer = chars.join("");
        this.#touch();
        return "handled";
      }
      case "left":
        if (editing.cursor > 0) editing.cursor -= 1;
        this.#touch();
        return "handled";
      case "right":
        if (editing.cursor < Array.from(editing.buffer).length) editing.cursor += 1;
        this.#touch();
        return "handled";
      case "home":
        editing.cursor = 0;
        this.#touch();
        return "handled";
      case "end":
        editing.cursor = Array.from(editing.buffer).length;
        this.#touch();
        return "handled";
      case "enter":
        // 密钥行的空提交 = 保持现值，此时退出编辑态即可
        this.#commitEdit();
        return "handled";
      case "escape":
        this.#cancelEdit();
        return "handled";
      default:
        return "none";
    }
  }

  /* --------------------------- 渲染 --------------------------- */

  render(inner: number, maxRows: number): SettingsPanelRender {
    // 宿主还会加 ┌─┐ / └─┘ 两行，本函数返回"标题 + 正文 + 提示"
    const bodyBudget = Math.max(1, maxRows - 4);
    const plan = this.#plan(bodyBudget);
    const labelBudget = Math.max(6, Math.floor((inner - LEADING - MARKER_WIDTH - 2) * 0.55));
    const valueBudget = Math.max(6, inner - LEADING - MARKER_WIDTH - labelBudget - 2);

    const lines: string[] = [this.#titleLine(inner)];
    const rowLines = new Map<number, number>();
    let cursor: SettingsPanelRender["cursor"];

    for (let index = plan.start; index < plan.end; index += 1) {
      const spec = this.#rowAt(index);
      if (spec === undefined) continue;
      if (plan.headers.includes(index)) lines.push(sectionLine(inner, spec.section));
      rowLines.set(lines.length, index);
      const rendered = this.#rowLine(inner, index, spec, labelBudget, valueBudget);
      lines.push(rendered.line);
      if (rendered.cursorColumn !== undefined) {
        cursor = { line: lines.length - 1, column: rendered.cursorColumn };
      }
    }

    lines.push(this.#hintLine(inner));
    return { lines, rowLines, ...(cursor !== undefined ? { cursor } : {}) };
  }

  /**
   * 计算可见窗口。
   *
   * 组标题也占行，所以"能塞几行"必须连标题一起算 —— 否则在组边界上会多出
   * 一行，把提示行挤出面板。
   */
  #plan(budget: number): WindowPlan {
    const count = this.rows.length;
    if (count === 0) return { start: 0, end: 0, headers: [] };

    let start = Math.min(Math.max(0, this.#scroll), count - 1);
    if (this.#followCursor) {
      if (this.#cursor < start) start = this.#cursor;
      for (let guard = 0; guard <= count; guard += 1) {
        const probe = this.#planFrom(start, budget);
        if (this.#cursor < probe.end || start >= this.#cursor) break;
        start += 1;
      }
    }
    this.#scroll = start;
    return this.#planFrom(start, budget);
  }

  #planFrom(start: number, budget: number): WindowPlan {
    const headers: number[] = [];
    let lines = 0;
    let end = start;
    let lastSection: string | undefined;
    for (let index = start; index < this.rows.length; index += 1) {
      const section = this.#rowAt(index)?.section;
      const isHeader = section !== lastSection;
      const cost = (isHeader ? 1 : 0) + 1;
      if (lines + cost > budget) {
        // 预算再紧也至少给一行：宁可挤掉组标题，也不要画出一个空面板
        if (end === start) end = start + 1;
        break;
      }
      if (isHeader) headers.push(index);
      lines += cost;
      lastSection = section;
      end = index + 1;
    }
    return { start, end, headers };
  }

  #titleLine(inner: number): string {
    const title = `${BOLD}设置${RESET}`;
    const subtitle = this.subtitle === undefined ? "" : ` ${DIM}· ${this.subtitle}${RESET}`;
    return paint(` ${title}${subtitle}`, inner, undefined);
  }

  #hintLine(inner: number): string {
    const hint =
      this.#editing !== undefined
        ? "Enter 确认   Esc 取消   空提交 = 保持现值"
        : "↑↓ 移动   ←→ 切换   Enter 应用   Tab 换组   Esc 关闭";
    return paint(` ${DIM}${hint}${RESET}`, inner, undefined);
  }

  #rowLine(
    inner: number,
    index: number,
    spec: SettingsRow,
    labelBudget: number,
    valueBudget: number,
  ): { line: string; cursorColumn?: number } {
    const editing = this.#editing !== undefined && this.#editing.row === index;
    const focused = index === this.#cursor;
    const marker = focused ? `${fg(COLOR.prompt)}▸${RESET} ` : "  ";
    const labelColor = focused ? COLOR.inputText : COLOR.toolOk;
    const label = padAnsi(truncateAnsi(spec.label, labelBudget), labelBudget);
    const head = `${" ".repeat(LEADING)}${marker}${fg(labelColor)}${label}${RESET}`;

    const background =
      this.#pressed === index
        ? bg(COLOR.buttonPressedBg)
        : this.#hovered === index
          ? bg(COLOR.userBandBg)
          : undefined;

    if (editing) {
      const state = this.#editing!;
      const shown = spec.secret === true ? "•".repeat(Array.from(state.buffer).length) : state.buffer;
      const prefix = `${head} `;
      const cursorColumn = visibleWidth(prefix) + this.#prefixWidth(state.buffer, state.cursor);
      const text = `${prefix}${fg(COLOR.inputText)}${shown}${RESET}`;
      return { line: paint(text, inner, background), cursorColumn };
    }

    const blocked = spec.blocked?.();
    const value =
      blocked !== undefined
        ? blocked
        : spec.kind === "toggle"
          ? (spec.enabled?.() ?? false)
            ? "开"
            : "关"
          : (spec.display?.() ?? "");
    const valueColor =
      blocked !== undefined ? COLOR.error : focused ? COLOR.prompt : COLOR.toolOk;
    const headWidth = visibleWidth(head);
    const valueText = truncateAnsi(value, valueBudget);
    const gap = Math.max(1, inner - headWidth - visibleWidth(valueText));
    const text = `${head}${" ".repeat(gap)}${fg(valueColor)}${valueText}${RESET}`;
    return { line: paint(text, inner, background) };
  }

  /** 光标左侧的可见宽度（宽字符按 2 列算）。 */
  #prefixWidth(buffer: string, cursor: number): number {
    return visibleWidth(Array.from(buffer).slice(0, cursor).join(""));
  }
}

function sectionLine(inner: number, section: string): string {
  return paint(` ${DIM}${section}${RESET}`, inner, undefined);
}

/**
 * 裁到整宽后补到整宽；有底色时把补出来的空格也染上。
 *
 * 补白必须在 RESET **之前**，而行内自身的 RESET 会中途打断底色 —— 所以先把
 * 每个 RESET 后面补一次底色（与 `#paintDialog` 同一套写法），再补空格。
 *
 * 先裁后补是硬要求：`padAnsi` 只补不裁，提示行/长值在窄终端上会顶破 inner，
 * 整行底色就会缺角（宿主再截断一次就变成"色块断在中间"）。
 */
function paint(text: string, width: number, background: string | undefined): string {
  const fitted = truncateAnsi(text, width);
  // 截断可能吃掉结尾的 RESET，那样后续空格会带上最后一档样式
  const closed = text.includes(RESET) && !fitted.endsWith(RESET) ? `${fitted}${RESET}` : fitted;
  if (background === undefined) return padAnsi(closed, width);
  const filled = padAnsi(closed.replaceAll(RESET, `${RESET}${background}`), width);
  return `${background}${filled}${RESET}`;
}
