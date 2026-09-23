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
import { combineHooks, runUserTurn, type LoopHooks } from "../core/loop.ts";
import type { AgentSession } from "../core/session.ts";
import type { SessionRuntime } from "../core/runtime.ts";
import type { ToolRegistry } from "../tools/types.ts";
import { Screen } from "./screen.ts";
import { Terminal } from "./term.ts";
import { KeyDecoder, type Key } from "./keys.ts";
import { bg, BOLD, DIM, RESET, fg, renderMarkdown, renderPlain } from "./markdown.ts";
import { truncateAnsi, padAnsi, visibleWidth } from "./ansi.ts";
import { Transcript, type DisplayItem } from "./transcript.ts";
import { COLOR } from "./theme.ts";
import { renderToolItem } from "./renderers.ts";
import { registerBuiltinToolRenderers } from "./renderers-builtin.ts";
import { composeTodoPanel } from "./render-todo.ts";
import { composeThinkingBlock, ThinkingBuffer, THINKING_BLOCK_ROWS } from "./thinking.ts";
import { TranscriptLayout } from "./transcript-layout.ts";
import { composeCenteredButton, composeHistoryDrawer, historyPaneHeights } from "./history-drawer.ts";
import { hitTest, type HitRegion } from "./hit.ts";
import {
  closeHistoryView,
  initialHistoryView,
  openHistoryView,
  returnToLatestView,
  scrollHistoryView,
  scrollMainView,
  shouldShowMoreButton,
  shouldShowReturnButton,
  syncHistoryView,
  type HistoryViewState,
} from "./history-state.ts";
import { setHighlightReadyHandler } from "./highlight.ts";
import {
  AskUserFlow,
  type AskUserAnswer,
  type AskUserQuestion,
} from "./ask-user.ts";
import { currentTodoList, type TodoList } from "../tools/todo.ts";
import type { PermissionRequest } from "../permission/policy.ts";
import { describeCapability, MODES, type SandboxMode } from "../permission/mode.ts";
import type { CapabilityEscalation } from "../tools/types.ts";
import type { AuditTrail } from "../store/audit.ts";
import {
  composeDialogActions,
  hitDialogActionAtLine,
  type DialogAction,
  type DialogButtonRowHit,
} from "./dialog.ts";

/** 输入面板的行数（带底色的"阴影"区块）。 */
export const INPUT_ROWS = 4;

/** 消息区左侧留白 —— 让文字不贴着终端边缘。 */
export const BODY_INDENT = 3;

/**
 * 通用对话框。
 *
 * 权限确认、能力授权都用它；将来 `ask_user` 也接这里 ——
 * 区别只是 body 的行数与是否需要文本输入。
 */
interface PendingDialog {
  title: string;
  body: string[];
  /** 按键提示。 */
  hint: string;
  /** 可鼠标点击的按钮。键盘路径仍然保留。 */
  actions: readonly DialogAction[];
  resolve: (value: boolean) => void;
}

/** 屏幕坐标命中区间；row 为 1-based。 */

export interface TuiInteraction {
  askPermission(request: PermissionRequest): Promise<boolean>;
  confirmModeChange(request: PermissionRequest, needed: SandboxMode): Promise<boolean>;
  requestCapability(escalation: CapabilityEscalation): Promise<boolean>;
  askUser(questions: readonly AskUserQuestion[]): Promise<AskUserAnswer[] | undefined>;
}

export interface TuiOptions {
  session: AgentSession;
  tools: ToolRegistry;
  cwd: string;
  /** 启动时的欢迎语。 */
  banner?: string;
  /** 沙箱档位，用于状态栏与升档提示。 */
  mode?: SandboxMode;
  /** 当前 session 的审计流水；TUI hooks 会把它和渲染 hooks 合并。 */
  audit?: AuditTrail;
  /**
   * 新建对话时调用（`/new`）。
   * 返回完整的 session runtime，避免复用旧 session 的 gate/sandbox。
   * 省略时回退到旧的 createSession（仅用于兼容）。
   */
  createRuntime?: (interaction: TuiInteraction) => SessionRuntime;
  /** 旧接口：只换 AgentSession，工具与 gate 复用当前 runtime。 */
  createSession?: () => AgentSession;
}

export class TuiApp implements TuiInteraction {
  #terminal = new Terminal();
  #screen: Screen;
  #decoder = new KeyDecoder();

  #session: AgentSession;
  #tools: ToolRegistry;
  #cwd: string;
  #createRuntime: ((interaction: TuiInteraction) => SessionRuntime) | undefined;
  #createSession: (() => AgentSession) | undefined;
  #audit: AuditTrail | undefined;

  #transcript = new Transcript();
  /** 块级布局缓存：滚动/流式渲染不再重跑整段历史。 */
  #layout = new TranscriptLayout<DisplayItem>();
  /** 思考链路的滚动缓冲（只保留当前行，O(1) 内存）。 */
  #thinking = new ThinkingBuffer();
  #input = "";
  #cursor = 0;
  /** 主区滚动、钉底和历史抽屉的统一状态。 */
  #viewState: HistoryViewState = initialHistoryView();
  /** 上一次布局总行数，用于回看时抵消新增内容造成的位移。 */
  #lastLayoutTotal = 0;
  /** 上一次消息区高度，供滚动和历史上限计算。 */
  #bodyHeight = 1;
  /** body 顶部是否有非内容行（“查看更多消息”按钮）；鼠标命中要扣掉。 */
  #bodyContentOffset = 0;
  /** 消息区顶部“查看更多消息”的鼠标命中区间（row 相对 body，0-based）。 */
  #moreHistoryHit: HitRegion | undefined;
  /** 输入框上方“回到最新消息”的鼠标命中区间（row 为屏幕 1-based）。 */
  #returnToLatestHit: HitRegion | undefined;
  #busy = false;
  #usage: Usage = { input: 0, output: 0 };
  #abort: AbortController | undefined;
  #renderScheduled = false;
  #resolveExit: (() => void) | undefined;
  #mode: SandboxMode = "workspace-write";

  /** 待处理的对话框；存在时按键全部路由给它。 */
  #pendingDialog: PendingDialog | undefined;
  /** 进行中的 ask_user 问答流程。 */
  #askFlow: AskUserFlow | undefined;
  #askResolve: ((answers: AskUserAnswer[] | undefined) => void) | undefined;
  /** 对话框覆盖层在 body 里的起始行（-1 表示当前没有对话框）。鼠标命中要用。 */
  #dialogTopRow = -1;
  /** 当前权限弹窗按钮的鼠标命中区间（行号相对覆盖层顶部）。 */
  #dialogButtonHits: DialogButtonRowHit[] = [];

  /** 待办派生的缓存（键 = 会话 id + 消息条数）。 */
  #todoCache: { key: string; list: TodoList } | undefined;
  /** in_progress shimmer 相位；0..1。 */
  #todoShimmer = 0;
  /** shimmer 定时器。只在当前 turn 且有 in_progress 时运行。 */
  #todoShimmerTimer: ReturnType<typeof setInterval> | undefined;

  /** 上一次渲染时每个工具条目占用的 body 行区间，用于鼠标点击命中。 */
  #toolHits: { callId: string; start: number; end: number }[] = [];
  /** body 视窗在完整内容里的起始下标。 */
  #bodyWindowStart = 0;

  constructor(options: TuiOptions) {
    // 注册内置工具的自定义外观（幂等）。放在构造函数里，
    // 保证任何入口构造 TuiApp 都能拿到，而不只是 CLI。
    registerBuiltinToolRenderers();

    // 语言高亮模块是懒加载的：加载完成后要重绘一次，否则第一次看到的
    // 永远是纯文本。渲染路径保持同步，靠这个回调补上第二遍。
    setHighlightReadyHandler(() => this.#render(true));

    this.#session = options.session;
    this.#tools = options.tools;
    this.#cwd = options.cwd;
    this.#createRuntime = options.createRuntime;
    this.#createSession = options.createSession;
    this.#audit = options.audit;
    this.#mode = options.mode ?? "workspace-write";
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
    return this.#openDialog({
      title: `权限确认 · ${request.tool}`,
      body: [request.summary],
      hint: `[y] 允许    [n] 拒绝    ${DIM}Esc / Enter 拒绝${RESET}`,
      actions: [
        { label: "允许", value: true, tone: "ok" },
        { label: "拒绝", value: false, tone: "error" },
      ],
    });
  }

  /**
   * 能力授权入口（目前是联网）。
   *
   * 弹窗里一定带**真实原因与细节**（哪条命令、什么报错）——
   * 否则用户看到的是一句没有上下文的"是否允许联网"，根本不知道在批准什么。
   */
  requestCapability(escalation: CapabilityEscalation): Promise<boolean> {
    return this.#openDialog({
      title: `需要授权 · ${describeCapability(escalation.capability)}`,
      body: [escalation.reason, ...(escalation.details ?? [])],
      hint: `[y] 允许这一次    [n] 拒绝    ${DIM}Esc / Enter 拒绝${RESET}`,
      actions: [
        { label: "允许这一次", value: true, tone: "ok" },
        { label: "拒绝", value: false, tone: "error" },
      ],
    });
  }

  /**
   * 档位不足时询问是否临时升档。
   *
   * 和权限确认共用同一个对话框 —— 将来 `ask_user` 也接这里。
   */
  confirmModeChange(request: PermissionRequest, needed: SandboxMode): Promise<boolean> {
    return this.#openDialog({
      title: `需要更高档位 · ${needed}`,
      body: [
        `${request.tool} 想${request.summary}`,
        `当前档位（${this.#mode}）不允许，需要升到 ${needed}`,
      ],
      hint: `[y] 升到 ${needed}（本次会话）    [n] 拒绝    ${DIM}Esc / Enter 拒绝${RESET}`,
      actions: [
        { label: "允许升档", value: true, tone: "ok" },
        { label: "拒绝", value: false, tone: "error" },
      ],
    }).then((approved) => {
      if (approved) this.#mode = needed;
      return approved;
    });
  }

  /**
   * ask_user 的交互入口。
   *
   * 与权限弹窗共用同一套外框渲染，区别只是内容是分页表单、
   * 按键路由到 AskUserFlow。返回 undefined 表示用户中止。
   */
  askUser(questions: readonly AskUserQuestion[]): Promise<AskUserAnswer[] | undefined> {
    return new Promise<AskUserAnswer[] | undefined>((resolve) => {
      this.#askResolve = resolve;
      this.#askFlow = new AskUserFlow({
        questions,
        onChange: () => this.#render(true),
      });
      this.#render(true);
    });
  }

  #finishAsk(answers: AskUserAnswer[] | undefined): void {
    const flow = this.#askFlow;
    const resolve = this.#askResolve;
    this.#askFlow = undefined;
    this.#askResolve = undefined;
    flow?.dispose();
    resolve?.(answers);
    this.#render(true);
  }

  #openDialog(dialog: Omit<PendingDialog, "resolve">): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.#pendingDialog = { ...dialog, resolve };
      this.#render(true);
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
      this.#syncTodoShimmer();
      await exited;
    } finally {
      clearInterval(escapeTimer);
      this.#stopTodoShimmer();
      offData();
      offResize();
      setHighlightReadyHandler(undefined);
      this.#abort?.abort();
      this.#terminal.exit();
    }
  }

  /* --------------------------- 输入处理 --------------------------- */

  #handleKeys(keys: readonly Key[]): void {
    for (const key of keys) this.#handleKey(key);
  }

  #handleKey(key: Key): void {
    // ask_user 问答优先：它是多页表单，有自己的按键语义
    if (this.#askFlow !== undefined) {
      // 但鼠标要放行 —— 点击选项是问答的核心交互之一，
      // 如果在这里一并吞掉，#handleMouse 永远收不到事件
      if (key.type === "mouse") {
        this.#handleMouse(key);
        return;
      }

      const outcome = this.#askFlow.handleKey(key);
      if (outcome.kind === "submit") this.#finishAsk(outcome.answers);
      else if (outcome.kind === "abort") this.#finishAsk(undefined);
      return;
    }

    // 有对话框时，所有按键都归它 —— 不能漏到下面的输入逻辑。
    // 鼠标要交给统一的鼠标路由，才能命中按钮。
    if (this.#pendingDialog !== undefined) {
      if (key.type === "mouse") this.#handleMouse(key);
      else this.#resolveDialog(key);
      return;
    }

    // 历史抽屉只接管 Esc 与滚动；输入框仍可正常使用。
    if (this.#viewState.historyOpen && key.type === "escape") {
      this.#closeHistoryDrawer();
      return;
    }

    switch (key.type) {
      case "mouse":
        this.#handleMouse(key);
        return;

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
        if (this.#viewState.historyOpen) this.#scrollHistoryBy(1);
        else this.#scrollBy(1);
        return;

      case "down":
        if (this.#viewState.historyOpen) this.#scrollHistoryBy(-1);
        else this.#scrollBy(-1);
        return;

      case "pageUp":
        if (this.#viewState.historyOpen) this.#scrollHistoryBy(Math.max(1, this.#bodyHeight - 2));
        else this.#scrollBy(Math.max(1, this.#bodyHeight));
        return;

      case "pageDown":
        if (this.#viewState.historyOpen) this.#scrollHistoryBy(-Math.max(1, this.#bodyHeight - 2));
        else this.#scrollBy(-Math.max(1, this.#bodyHeight));
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

  /** 处理鼠标事件：左键点击按钮/折叠行，滚轮滚动主视窗或历史抽屉。 */
  #handleMouse(key: Extract<Key, { type: "mouse" }>): void {
    if (key.button === "wheelUp") {
      if (this.#viewState.historyOpen) this.#scrollHistoryBy(3);
      else this.#scrollBy(3);
      return;
    }
    if (key.button === "wheelDown") {
      if (this.#viewState.historyOpen) this.#scrollHistoryBy(-3);
      else this.#scrollBy(-3);
      return;
    }
    if (!key.pressed || key.button !== "left") return;

    // 屏幕坐标是 1-based；body 从第 2 行开始（第 1 行是状态栏）
    const bodyRow = key.y - 2;

    // 权限 / 能力 / 升档弹窗：点击按钮直接确认或拒绝。
    if (this.#pendingDialog !== undefined && this.#dialogTopRow >= 0) {
      const dialogLine = bodyRow - this.#dialogTopRow;
      const column = key.x - 1;
      const answer = hitDialogActionAtLine(this.#dialogButtonHits, dialogLine, column);
      if (answer !== undefined) {
        this.#finishDialog(answer);
        return;
      }
    }

    // ask_user：点到选项就选中/勾选，点到汇总里的题就跳回去。
    // 覆盖层第 0 行是上边框，所以 flow 行号要再减 1。
    if (this.#askFlow !== undefined && this.#dialogTopRow >= 0) {
      const flowLine = bodyRow - this.#dialogTopRow - 1;
      if (flowLine >= 0 && this.#askFlow.clickLine(flowLine)) {
        this.#render(true);
        return;
      }
    }

    if (hitTest(this.#returnToLatestHit, key.x, key.y)) {
      this.#returnToLatest();
      return;
    }

    if (
      !this.#viewState.historyOpen &&
      hitTest(this.#moreHistoryHit, key.x, bodyRow)
    ) {
      this.#openHistoryDrawer();
      return;
    }

    if (this.#viewState.historyOpen || bodyRow < 0) return;

    const bodyIndex = this.#bodyWindowStart + (bodyRow - this.#bodyContentOffset);
    for (const hit of this.#toolHits) {
      if (bodyIndex >= hit.start && bodyIndex <= hit.end) {
        if (this.#transcript.toggleToolExpanded(hit.callId)) {
          // 展开会改变布局，必须整屏重绘而不是走差分
          this.#render(true);
        }
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
    this.#viewState = scrollMainView(this.#viewState, delta, this.#layout.totalLines, this.#bodyHeight);
    this.#render();
  }

  #scrollHistoryBy(delta: number): void {
    this.#viewState = scrollHistoryView(this.#viewState, delta, this.#layout.totalLines, this.#bodyHeight);
    this.#render();
  }

  #openHistoryDrawer(): void {
    this.#viewState = openHistoryView(this.#viewState, this.#layout.totalLines, this.#bodyHeight);
    this.#render(true);
  }

  #closeHistoryDrawer(): void {
    this.#viewState = closeHistoryView(this.#viewState);
    this.#render(true);
  }

  #returnToLatest(): void {
    this.#viewState = returnToLatestView(this.#viewState);
    this.#render(true);
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
    this.#viewState = initialHistoryView();
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
    if (this.#createRuntime === undefined && this.#createSession === undefined) {
      this.#transcript.pushError("当前未启用持久化，无法创建新对话");
      this.#render();
      return;
    }

    this.#input = "";
    this.#cursor = 0;
    this.#viewState = initialHistoryView();
    this.#lastLayoutTotal = 0;
    this.#usage = { input: 0, output: 0 };
    this.#stopTodoShimmer();
    this.#todoCache = undefined;

    if (this.#createRuntime !== undefined) {
      const runtime = this.#createRuntime(this);
      this.#session = runtime.session;
      this.#tools = runtime.tools;
      this.#mode = runtime.mode;
      this.#audit = runtime.audit;
    } else {
      this.#session = this.#createSession!();
    }

    this.#transcript = new Transcript();
    this.#layout = new TranscriptLayout<DisplayItem>();
    this.#transcript.pushNotice(
      `已开始新对话：\`${this.#session.id}\`\n\n用 \`/resume\` 之外的会话请重启并加 \`--resume <id>\`。`,
    );
    this.#render(true);
  }

  #requestExit(): void {
    this.#resolveExit?.();
  }

  /** 处理对话框按键。默认拒绝（Enter / Esc / 其它键都视为拒绝）。 */
  #resolveDialog(key: Key): void {
    const dialog = this.#pendingDialog;
    if (dialog === undefined) return;

    let answer: boolean | undefined;

    if (key.type === "text") {
      const value = key.value.trim().toLowerCase();
      if (value === "y" || value === "yes") answer = true;
      else if (value === "n" || value === "no") answer = false;
    } else if (key.type === "enter" || key.type === "escape") {
      answer = false;
    }

    if (answer === undefined) return;
    this.#finishDialog(answer);
  }

  /** 结束当前对话框并返回布尔结果；鼠标与键盘共用。 */
  #finishDialog(answer: boolean): void {
    const dialog = this.#pendingDialog;
    if (dialog === undefined) return;

    this.#pendingDialog = undefined;
    this.#dialogButtonHits = [];
    dialog.resolve(answer);
    this.#render(true);
  }

  /* --------------------------- 对话推进 --------------------------- */

  async #runTurn(input: string): Promise<void> {
    this.#busy = true;
    this.#abort = new AbortController();
    this.#render();
    this.#syncTodoShimmer();

    const uiHooks: LoopHooks = {
      onText: (delta) => {
        this.#transcript.appendAssistantText(delta);
        this.#scheduleRender();
      },
      // 思考链路：只进滚动缓冲，不进消息区、不落库
      onReasoning: (delta) => {
        this.#thinking.push(delta);
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
      // 运行中的流式输出：只保留末尾若干行，内存有界
      onToolProgress: (call, chunk) => {
        this.#transcript.appendToolProgress(call.id, chunk);
        this.#scheduleRender();
      },
      // 工具跑失败后请求一次性能力授权（如联网）—— 弹窗里带真实原因与报错
      onRequestCapability: (_call, escalation) => this.requestCapability(escalation),
      // ask_user：多页问答表单
      onAskUser: (_call, questions) => this.askUser(questions),
      onToolResult: (call, result) => {
        this.#transcript.finishTool(call.id, result.output, result.ok);
        this.#syncTodoShimmer();
        this.#scheduleRender();
      },
      onUsage: (usage) => {
        this.#usage = Transcript.mergeUsage(this.#usage, usage);
        this.#scheduleRender();
      },
    };
    const hooks = combineHooks(uiHooks, this.#audit?.hooks());

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
      this.#thinking.reset();
      this.#busy = false;
      this.#stopTodoShimmer();
      this.#abort = undefined;
      this.#render();
    }
  }

  /**
   * 只在当前 turn 有 in_progress 时驱动 shimmer。
   *
   * 不把动画定时器常驻：turn 结束后即使模型忘了把某项改成 completed，
   * 也只留下静态的进行中样式，不继续烧 CPU。
   */
  #syncTodoShimmer(): void {
    const active =
      this.#busy && this.#todos().todos.some((todo) => todo.status === "in_progress");
    if (!active) {
      this.#stopTodoShimmer();
      return;
    }
    if (this.#todoShimmerTimer !== undefined) return;

    this.#todoShimmerTimer = setInterval(() => {
      if (!this.#busy) {
        this.#stopTodoShimmer();
        return;
      }
      this.#todoShimmer = (this.#todoShimmer + 0.04) % 1;
      this.#render();
    }, 50);
  }

  #stopTodoShimmer(): void {
    if (this.#todoShimmerTimer !== undefined) {
      clearInterval(this.#todoShimmerTimer);
      this.#todoShimmerTimer = undefined;
    }
    this.#todoShimmer = 0;
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
    // 让渲染成为 shimmer 的最终校准点：即使 onToolResult 回调发生在
    // 工具结果落库之前，下一次实际渲染也会按最新历史停止或启动动画。
    this.#syncTodoShimmer();

    const { width, height } = this.#terminal.size;
    if (this.#screen.resize(width, height)) force = true;
    if (force) this.#screen.invalidate();

    const lines = this.#compose(width, height);
    const output = this.#screen.draw(lines);
    if (output.length > 0) this.#terminal.write(output);
  }

  #compose(width: number, height: number): string[] {
    // 思考区固定预留（默认 5 行，小终端自动收缩），不思考时是全空白 ——
    // 这块空间同时充当输入框上方的呼吸留白
    const thinkingRows = Math.min(THINKING_BLOCK_ROWS, Math.max(1, height - 4));
    const thinkingBlock = composeThinkingBlock(this.#thinking, width, { rows: thinkingRows });

    // sticky 待办面板：不能吃掉太多屏幕，最多占 40% 且必须给消息区留位置
    const panelBudget = Math.max(
      0,
      Math.min(Math.floor(height * 0.4), height - 3 - thinkingBlock.length),
    );
    const todoList = this.#todos();
    const todoPanel =
      panelBudget >= 2
        ? composeTodoPanel(todoList.todos, width, {
            maxLines: panelBudget,
            ...(todoList.summary !== undefined ? { summary: todoList.summary } : {}),
            ...(this.#todoShimmer > 0 ? { shimmer: this.#todoShimmer } : {}),
          })
        : [];

    // 2 = 状态栏 + 输入面板第一行；INPUT_ROWS - 1 = 面板其余留白行
    const bodyHeight = Math.max(
      1,
      height - 2 - (INPUT_ROWS - 1) - todoPanel.length - thinkingBlock.length,
    );
    const body = this.#composeBody(width, bodyHeight);

    // 对话框 / 问答以覆盖层形式压在消息区底部
    if (this.#pendingDialog !== undefined || this.#askFlow !== undefined) {
      const overlay = this.#renderDialog(width);
      const start = Math.max(0, bodyHeight - overlay.length);
      this.#dialogTopRow = start;
      for (let i = 0; i < overlay.length && start + i < bodyHeight; i += 1) {
        body[start + i] = overlay[i]!;
      }
    } else {
      this.#dialogTopRow = -1;
      this.#dialogButtonHits = [];
    }

    // “回到最新消息”放在思考区最后一行：它本来就是输入框上方的留白，
    // 不额外挤占消息区高度，也不会造成 layout 抖动。
    if (shouldShowReturnButton(this.#viewState) && thinkingBlock.length > 0) {
      const rowIndex = thinkingBlock.length - 1;
      const label = `${fg(COLOR.tool)}[ 回到最新消息 ]${RESET}`;
      const row = 1 + bodyHeight + todoPanel.length + thinkingBlock.length;
      const button = composeCenteredButton(label, width, row);
      thinkingBlock[rowIndex] = button.line;
      this.#returnToLatestHit = button.hit;
    } else {
      this.#returnToLatestHit = undefined;
    }

    return [
      this.#composeStatus(width),
      ...body,
      ...todoPanel,
      ...thinkingBlock,
      ...this.#composeInput(width),
    ];
  }

  /**
   * 当前待办（从消息历史派生）。
   *
   * 带缓存：渲染是 60fps 级别的，而派生要倒扫历史 ——
   * 没有 todo 的会话会每次都扫全量，白烧 CPU。
   */
  #todos(): TodoList {
    const messages = this.#session.messages;
    const key = `${this.#session.id}:${messages.length}`;
    if (this.#todoCache === undefined || this.#todoCache.key !== key) {
      this.#todoCache = {
        key,
        list: currentTodoList(messages, { hideCompletedAfterUserTurn: true }),
      };
    }
    return this.#todoCache.list;
  }

  #renderDialog(width: number): string[] {
    this.#dialogButtonHits = [];
    const inner = Math.max(16, Math.min(width - 2, 74));
    const color = fg(COLOR.warn);
    const bar = `${color}│${RESET}`;
    const row = (text: string): string =>
      `${bar}${padAnsi(truncateAnsi(text, inner), inner)}${bar}`;

    // ask_user：分页表单，内容由 AskUserFlow 自己渲染
    if (this.#askFlow !== undefined) {
      return [
        `${color}┌${"─".repeat(inner)}┐${RESET}`,
        ...this.#askFlow.render(inner).map((line) => row(` ${line}`)),
        `${color}└${"─".repeat(inner)}┘${RESET}`,
      ];
    }

    const dialog = this.#pendingDialog;
    if (dialog === undefined) return [];

    const lines = [
      `${color}┌${"─".repeat(inner)}┐${RESET}`,
      row(` ${BOLD}${truncateAnsi(dialog.title, inner - 2)}${RESET}`),
    ];
    for (const entry of dialog.body) {
      lines.push(row(` ${truncateAnsi(entry, inner - 2)}`));
    }
    lines.push(row(""));

    const actions = composeDialogActions(dialog.actions);
    lines.push(row(actions.text));
    const actionLine = lines.length - 1;
    this.#dialogButtonHits = actions.hits.map((hit) => ({ line: actionLine, hit }));

    lines.push(row(` ${dialog.hint}`));
    lines.push(`${color}└${"─".repeat(inner)}┘${RESET}`);
    return lines;
  }

  #composeStatus(width: number): string {
    const modeColor = this.#mode === "no-sandbox" ? COLOR.warn : COLOR.ok;
    const badge = `${fg(modeColor)}${this.#mode}${RESET}`;
    const left = `${BOLD}bugent${RESET} ${DIM}${this.#session.client.id}${RESET} ${badge}`;
    const right = this.#busy
      ? `${fg(COLOR.busy)}● 运行中${RESET}`
      : `${DIM}turn ${this.#session.turn} · ↑${this.#usage.input} ↓${this.#usage.output}${
          this.#usage.cached !== undefined ? ` ⚡${this.#usage.cached}` : ""
        }${RESET}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return truncateAnsi(left + " ".repeat(gap) + right, width);
  }

  /**
   * 输入面板：4 行"阴影"区块。
   *
   * 之前只有一行 `› ___`，太单薄；现在做成带底色的面板 ——
   * 第一行放输入内容，其余三行留白（同时也给光标和长文本留了呼吸空间）。
   */
  #composeInput(width: number): string[] {
    // 末尾留一格：写满整行会让终端自动折行，把布局顶乱
    const fill = Math.max(0, width - 1);
    const background = bg(COLOR.inputBg);

    const rows: string[] = [];
    for (let index = 0; index < INPUT_ROWS; index += 1) {
      const raw = index === 0 ? this.#composeInputText() : "";

      // 关键：RESET([0m) 会把**背景色一起清掉**，于是 `▌` 之后的
      // 整行都失去底色，看起来就是"输入框和灰蓝色分离"。
      // 在每个 RESET 之后重新贴上背景色即可。
      const content = raw.replaceAll(RESET, `${RESET}${background}`);
      const padding = " ".repeat(Math.max(0, fill - visibleWidth(raw)));

      rows.push(`${background}${content}${padding}${RESET}`);
    }
    return rows;
  }

  /** 第一行的内容：提示符 + 输入文本 + 光标。 */
  #composeInputText(): string {
    const edge = `${fg(COLOR.inputEdge)}▌${RESET} `;
    const textColor = fg(COLOR.inputText);
    const available = Math.max(1, this.#terminal.size.width - 4);
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

    return `${edge}${textColor}${rendered}${RESET}`;
  }

  /**
   * 渲染消息区，并在必要时**吸顶**当前条目的头部。
   *
   * 为什么需要吸顶：body 视窗是钉底的（scrollOffset=0 时看最新内容），
   * 而长工具条目的渲染又是从开头截断的 —— 两个方向相反，结果是
   * 滚到底时既看不到头部（含 +N -M 徽标），也看不到内容结尾，
   * 只剩信息量最低的中段。
   *
   * 修法是通用且便宜的：窗口起点落在某条目内部时，把该条目的头部
   * 覆盖在第一行。对 bash 的长输出、read_file 的长文件同样有效。
   */
  #composeBody(width: number, height: number): string[] {
    this.#bodyHeight = height;

    // 左侧留白：内容按窄 width 渲染，再统一缩进，避免文字贴着终端边缘
    const indent = " ".repeat(BODY_INDENT);
    const innerWidth = Math.max(1, width - BODY_INDENT);

    // 只有内容版本变化的 block 会重新渲染；滚动本身只重新取窗口。
    this.#layout.update(
      this.#transcript.items,
      innerWidth,
      (_item, index) => this.#transcript.itemVersion(index),
      (item, itemWidth) =>
        this.#renderItem(item, itemWidth).map((line) => (line.length > 0 ? indent + line : line)),
      {
        callIdOf: (item) => (item.kind === "tool" ? item.callId : undefined),
        globalVersion: this.#transcript.revision,
      },
    );

    const total = this.#layout.totalLines;
    const delta = total - this.#lastLayoutTotal;
    this.#viewState = syncHistoryView(this.#viewState, total, height, delta);
    this.#lastLayoutTotal = total;

    if (this.#viewState.historyOpen) {
      const pane = historyPaneHeights(height);
      const maxHistory = Math.max(0, total - pane.top);
      const older = this.#layout.window(pane.top, this.#viewState.historyOffset);
      const latest = this.#layout.window(pane.bottom, 0);
      const drawer = composeHistoryDrawer({
        width,
        height,
        topLines: older.lines,
        bottomLines: latest.lines,
        offset: this.#viewState.historyOffset,
        maxOffset: maxHistory,
      });

      this.#bodyWindowStart = older.start;
      this.#bodyContentOffset = 0;
      this.#toolHits = [];
      this.#moreHistoryHit = undefined;
      return drawer.lines;
    }

    const showMore = shouldShowMoreButton(this.#viewState, total, height);
    const viewportHeight = Math.max(1, height - (showMore ? 1 : 0));
    const viewport = this.#layout.window(viewportHeight, this.#viewState.scrollOffset);

    this.#bodyWindowStart = viewport.start;
    this.#bodyContentOffset = showMore ? 1 : 0;
    this.#toolHits = viewport.blocks.flatMap((block) =>
      block.callId === undefined
        ? []
        : [{ callId: block.callId, start: block.start, end: block.contentEnd }],
    );

    if (!showMore) {
      this.#moreHistoryHit = undefined;
      return viewport.lines;
    }

    const label = `${DIM}↑ 更早消息已折叠 ${RESET}${fg(COLOR.tool)}[ 查看更多消息 ]${RESET}`;
    const button = composeCenteredButton(label, width, 0);
    this.#moreHistoryHit = button.hit;
    return [button.line, ...viewport.lines];
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
