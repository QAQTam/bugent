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
import { combineHooks, runTurn, runUserTurn, type LoopHooks } from "../core/loop.ts";
import type { AgentSession } from "../core/session.ts";
import type { SessionRuntime } from "../core/runtime.ts";
import {
  GOAL_INITIALIZATION_INSTRUCTION,
  type GoalController,
} from "../goal/controller.ts";
import type { McpStatus } from "../mcp/manager.ts";
import type { SkillStatus } from "../skills/manager.ts";
import { BranchService } from "../core/branch-service.ts";
import { applyWorkspaceUndo, planWorkspaceUndo } from "../core/workspace-undo.ts";
import type { MsgId, StoredMessage } from "../core/message.ts";
import { storedText } from "../core/message.ts";
import type { ToolRegistry } from "../tools/types.ts";
import { APPLY_PATCH_TOOL_NAME } from "../tools/apply-patch.ts";
import { PatchStreamProgress } from "../patch/streaming-progress.ts";
import { parseModelRef } from "../provider/registry.ts";
import type { PersistedProviderConfig } from "../provider/registry.ts";
import { Screen } from "./screen.ts";
import { Terminal } from "./term.ts";
import { KeyDecoder, type Key } from "./keys.ts";
import { bg, BOLD, DIM, RESET, fg, renderMarkdown, renderPlain } from "./markdown.ts";
import { truncateAnsi, padAnsi, visibleWidth } from "./ansi.ts";
import { inputIndexAt, layoutInput } from "./input-view.ts";
import {
  composeScrollbar,
  createScrollbarMetrics,
  hitScrollbar,
  scrollbarThumbAt,
  scrollOffsetFromDrag,
  type ScrollbarMetrics,
} from "./scrollbar.ts";
import { Transcript, displayActionMsgId, displayMsgId, type DisplayItem } from "./transcript.ts";
import { COLOR } from "./theme.ts";
import { renderToolItem } from "./renderers.ts";
import { registerBuiltinToolRenderers } from "./renderers-builtin.ts";
import { composeTodoPanel } from "./render-todo.ts";
import {
  composeThinkingBlock,
  isSpinningActivity,
  ThinkingBuffer,
  THINKING_BLOCK_ROWS,
  type AgentActivity,
} from "./thinking.ts";
import { TranscriptLayout, maxScrollOffset } from "./transcript-layout.ts";
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
import { createWorkspaceFs } from "../tools/workspace-fs.ts";
import type { PermissionRequest } from "../permission/policy.ts";
import { describeCapability, isSandboxMode, MODES, type SandboxMode } from "../permission/mode.ts";
import type { CapabilityEscalation } from "../tools/types.ts";
import type { AuditTrail } from "../store/audit.ts";
import {
  composeDialogActions,
  hitDialogActionAtLine,
  type DialogAction,
  type DialogButtonRowHit,
} from "./dialog.ts";
import {
  MESSAGE_ACTIONS,
  copyNotice,
  messageActionFromKey,
  type MessageAction,
} from "./message-actions.ts";

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

/** 点击消息后弹出的操作菜单；动作不是布尔值，所以与授权弹窗分开存。 */
interface PendingMessageMenu {
  /** 用于复制 / 检查 / 分叉 / 重试的实际消息。 */
  msgid: MsgId;
  /** 用于撤回的分支锚点；工具卡片通常指向 assistant tool-call。 */
  undoMsgid: MsgId;
  title: string;
  body: string[];
  hint: string;
  actions: readonly DialogAction<MessageAction>[];
}

/** 当前鼠标交互的弹窗按钮。 */
type ButtonTarget =
  | { kind: "dialog"; value: boolean }
  | { kind: "message"; value: MessageAction };

/** 请求 TUI 宿主创建/切换 runtime。 */
export interface RuntimeRequest {
  /** 省略时表示新建 session。 */
  sessionId?: string;
  branchId?: string;
  mode?: SandboxMode;
  /** session 级 provider/model/API key 覆盖。 */
  providerId?: string;
  model?: string;
  apiKey?: string;
  /** 非敏感 provider 配置覆盖（endpoint/baseUrl 等）。 */
  providerConfig?: PersistedProviderConfig;
  /** Session-level MCP server allowlist. */
  mcpServerIds?: readonly string[];
}

function oneLine(text: string, max = 64): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1))}…`;
}

/** 把带 ANSI 的弹窗行水平居中；右侧留白由 Screen 清行时补齐。 */
function centerLine(line: string, width: number): string {
  const clipped = truncateAnsi(line, width);
  const padding = Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2));
  return " ".repeat(padding) + clipped;
}

function dialogInnerWidth(width: number): number {
  return Math.max(16, Math.min(width - 2, 74));
}

function todoImpact(before: TodoList, after: TodoList): string {
  const beforeById = new Map(before.todos.map((todo) => [todo.id, todo]));
  const afterById = new Map(after.todos.map((todo) => [todo.id, todo]));
  let changed = 0;
  for (const [id, todo] of beforeById) {
    const next = afterById.get(id);
    if (next === undefined || next.status !== todo.status || next.content !== todo.content) changed += 1;
  }
  for (const id of afterById.keys()) if (!beforeById.has(id)) changed += 1;
  return changed === 0 ? "Todo：无状态变化" : `Todo：${changed} 项将回滚或恢复`;
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
  /** 当前 session 的 provider id，用于 /context 展示。 */
  providerId?: string;
  /** MCP status for /context. `disabledReason` is set on unsupported platforms. */
  mcp?: McpStatus & { disabledReason?: string };
  /** All configured MCP servers and their current session enablement. */
  mcpServers?: readonly { id: string; enabled: boolean }[];
  /** Skill catalog available to the current session. */
  skillStatus?: SkillStatus;
  /** Re-scan skill roots and update all attached registries. */
  reloadSkills?: () => Promise<SkillStatus>;
  /** Reload a configured MCP server's tool snapshot. */
  reloadMcp?: (serverId: string) => Promise<void>;
  /** 可切换的 provider id 列表。 */
  providers?: readonly string[];
  /** 当前 session 的非敏感 provider 配置。 */
  providerConfig?: PersistedProviderConfig;
  /** 当前 session 已保存的多个 provider profile。 */
  providerConfigs?: readonly PersistedProviderConfig[];
  /** 持久化/删除当前 session 的 provider profile。 */
  saveProviderConfig?: (sessionId: string, config: PersistedProviderConfig) => void;
  deleteProviderConfig?: (sessionId: string, providerId: string) => void;
  /** 系统 keychain 中的 API key（按 session + provider 隔离）。 */
  apiKey?: string;
  loadApiKey?: (sessionId: string, providerId: string) => Promise<string | undefined>;
  saveApiKey?: (sessionId: string, providerId: string, secret: string) => Promise<void>;
  deleteApiKey?: (sessionId: string, providerId: string) => Promise<void>;
  /** 启动时的欢迎语。 */
  banner?: string;
  /** 沙箱档位，用于状态栏与升档提示。 */
  mode?: SandboxMode;
  /** 当前 session 的 Goal Contract controller；未持久化时省略。 */
  goalController?: GoalController;
  /** 实验性自动 continuation；默认关闭。 */
  goalAutoContinue?: boolean;
  /** 单次 Goal 连续自动推进上限。 */
  maxGoalContinuationTurns?: number;
  /** 当前 session 的审计流水；TUI hooks 会把它和渲染 hooks 合并。 */
  audit?: AuditTrail;
  /**
   * 新建/切换分支时调用（`/new`、fork、undo、retry）。
   * 返回完整 runtime，避免复用旧 session 的 gate/sandbox。
   */
  createRuntime?: (
    interaction: TuiInteraction,
    request?: RuntimeRequest,
  ) => SessionRuntime;
  /** 旧接口：只换 AgentSession，工具与 gate 复用当前 runtime。 */
  createSession?: () => AgentSession;
  /** 分支操作入口；`--no-persist` 时省略。 */
  branchService?: BranchService;
}

export class TuiApp implements TuiInteraction {
  #terminal = new Terminal();
  #screen: Screen;
  #decoder = new KeyDecoder();

  #session: AgentSession;
  #tools: ToolRegistry;
  #cwd: string;
  #providerId: string;
  #mcp: (McpStatus & { disabledReason?: string }) | undefined;
  #mcpServers: readonly { id: string; enabled: boolean }[] = [];
  #skillStatus: SkillStatus | undefined;
  #reloadSkills: (() => Promise<SkillStatus>) | undefined;
  #reloadMcp: ((serverId: string) => Promise<void>) | undefined;
  #providerIds: readonly string[];
  #registeredProviderIds: ReadonlySet<string>;
  /** 当前 provider 的非敏感配置；API key 不在其中。 */
  #providerConfig: PersistedProviderConfig | undefined;
  /** 本进程内新增/切换过的 provider 配置，便于切回来。 */
  #providerConfigs = new Map<string, PersistedProviderConfig>();
  #saveProviderConfig: ((sessionId: string, config: PersistedProviderConfig) => void) | undefined;
  #deleteProviderConfig: ((sessionId: string, providerId: string) => void) | undefined;
  #loadApiKey: ((sessionId: string, providerId: string) => Promise<string | undefined>) | undefined;
  #saveApiKey: ((sessionId: string, providerId: string, secret: string) => Promise<void>) | undefined;
  #deleteApiKey: ((sessionId: string, providerId: string) => Promise<void>) | undefined;
  /** 当前进程内、当前 session 的 API key 覆盖；不落盘。 */
  #apiKeyOverride: string | undefined;
  #createRuntime:
    | ((interaction: TuiInteraction, request?: RuntimeRequest) => SessionRuntime)
    | undefined;
  #createSession: (() => AgentSession) | undefined;
  /** 最近一次由 createRuntime 创建的 runtime；切换时负责释放其 MCP attachments。 */
  #runtime: SessionRuntime | undefined;
  #branchService: BranchService | undefined;
  #audit: AuditTrail | undefined;
  /** 最近一条 assistant 消息；工具卡片用它建立可点击目标。 */
  #lastAssistantMsgid: MsgId | undefined;

  #transcript = new Transcript();
  /** apply_patch 参数流式解析器；工具真正开始时移除。 */
  #patchStreams = new Map<string, PatchStreamProgress>();
  /** 块级布局缓存：滚动/流式渲染不再重跑整段历史。 */
  #layout = new TranscriptLayout<DisplayItem>();
  /** 思考链路的滚动缓冲（只保留当前行，O(1) 内存）。 */
  #thinking = new ThinkingBuffer();
  /** Agent 的运行状态；spinner 代表 alive/working，而不是只看 reasoning。 */
  #activity: AgentActivity = { state: "idle" };
  /** 菊花帧；只在 thinking.active 时驱动。 */
  #thinkingFrame = 0;
  #thinkingTimer: ReturnType<typeof setInterval> | undefined;
  #input = "";
  #cursor = 0;
  /** Real terminal cursor position for IME/accessibility anchoring. */
  #inputCursorRow: number | undefined;
  #inputCursorColumn = 3;
  /** Cursor row within the visible input panel. */
  #inputCursorOffset = 0;
  /** 主区滚动、钉底和历史抽屉的统一状态。 */
  #viewState: HistoryViewState = initialHistoryView();
  /** 上一次布局总行数，用于回看时抵消新增内容造成的位移。 */
  #lastLayoutTotal = 0;
  /** 上一次消息区高度，供滚动和历史上限计算。 */
  #bodyHeight = 1;
  /** 当前消息区右侧滚动条几何；无回看空间时为空。 */
  #scrollbar: ScrollbarMetrics | undefined;
  /** 正在拖动滚动条时保存轨道快照，避免内容变化导致跳变。 */
  #scrollbarDrag: { metrics: ScrollbarMetrics; grabOffset: number } | undefined;
  /** body 顶部是否有非内容行（“查看更多消息”按钮）；鼠标命中要扣掉。 */
  #bodyContentOffset = 0;
  /** 消息区顶部“查看更多消息”的鼠标命中区间（row 相对 body，0-based）。 */
  #moreHistoryHit: HitRegion | undefined;
  /** 输入框上方“回到最新消息”的鼠标命中区间（row 为屏幕 1-based）。 */
  #returnToLatestHit: HitRegion | undefined;
  #busy = false;
  #usage: Usage = { input: 0, output: 0 };
  #abort: AbortController | undefined;
  /** 串行化所有工具触发的交互弹窗，避免并发工具互相覆盖对话框状态。 */
  #interactionTail: Promise<void> = Promise.resolve();
  #renderScheduled = false;
  #resolveExit: (() => void) | undefined;
  #mode: SandboxMode = "workspace-write";
  #goalController: GoalController | undefined;
  #goalStatusLine: string | undefined;
  #goalAutoContinue = false;
  #maxGoalContinuationTurns = 50;
  #goalContinuationStreak = 0;

  /** 待处理的对话框；存在时按键全部路由给它。 */
  #pendingDialog: PendingDialog | undefined;
  /** 待处理的消息操作菜单。 */
  #pendingMessageMenu: PendingMessageMenu | undefined;
  /** 进行中的 ask_user 问答流程。 */
  #askFlow: AskUserFlow | undefined;
  #askResolve: ((answers: AskUserAnswer[] | undefined) => void) | undefined;
  /** 对话框在屏幕上的起始行（0-based；-1 表示当前没有对话框）。鼠标命中要用。 */
  #dialogTopRow = -1;
  /** 对话框占用的行数；用于把鼠标事件限制在弹窗区域。 */
  #dialogHeight = 0;
  /** 当前权限弹窗按钮的鼠标命中区间（行号相对覆盖层顶部）。 */
  #dialogButtonHits: DialogButtonRowHit[] = [];
  /** 当前消息操作菜单按钮的鼠标命中区间。 */
  #messageButtonHits: DialogButtonRowHit<MessageAction>[] = [];
  /** 当前鼠标悬停/按下的按钮。 */
  #hoveredButton: ButtonTarget | undefined;
  #pressedButton: ButtonTarget | undefined;

  /** 待办派生的缓存（键 = 会话 id + 消息条数）。 */
  #todoCache: { key: string; list: TodoList } | undefined;
  /** in_progress shimmer 相位；0..1。 */
  #todoShimmer = 0;
  /** shimmer 定时器。只在当前 turn 且有 in_progress 时运行。 */
  #todoShimmerTimer: ReturnType<typeof setInterval> | undefined;

  /** 上一次渲染时每个工具条目占用的 body 行区间，用于鼠标点击命中。 */
  #toolHits: { callId: string; start: number; end: number }[] = [];
  /** 上一次渲染时每条可操作消息占用的 body 行区间。 */
  #messageHits: { msgid: MsgId; undoMsgid: MsgId; start: number; end: number }[] = [];
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
    this.#providerId = options.providerId ?? options.session.client.id.split("/")[0] ?? "unknown";
    this.#mcp = options.mcp;
    this.#mcpServers = options.mcpServers ?? [];
    this.#skillStatus = options.skillStatus;
    this.#reloadSkills = options.reloadSkills;
    this.#reloadMcp = options.reloadMcp;
    const savedProviderConfigs = options.providerConfigs ?? [];
    for (const config of savedProviderConfigs) this.#providerConfigs.set(config.id, config);
    if (options.providerConfig !== undefined) {
      this.#providerConfigs.set(options.providerConfig.id, options.providerConfig);
    }
    this.#registeredProviderIds = new Set(options.providers ?? []);
    const providerIds = new Set<string>([
      ...(options.providers ?? [this.#providerId]),
      ...savedProviderConfigs.map((config) => config.id),
      this.#providerId,
    ]);
    this.#providerIds = [...providerIds];
    this.#providerConfig = options.providerConfig ?? this.#providerConfigs.get(this.#providerId);
    this.#saveProviderConfig = options.saveProviderConfig;
    this.#deleteProviderConfig = options.deleteProviderConfig;
    this.#loadApiKey = options.loadApiKey;
    this.#saveApiKey = options.saveApiKey;
    this.#deleteApiKey = options.deleteApiKey;
    this.#apiKeyOverride = options.apiKey;
    this.#createRuntime = options.createRuntime;
    this.#createSession = options.createSession;
    this.#branchService = options.branchService;
    this.#audit = options.audit;
    this.#mode = options.mode ?? "workspace-write";
    this.#goalController = options.goalController;
    this.#goalAutoContinue = options.goalAutoContinue ?? false;
    this.#maxGoalContinuationTurns = options.maxGoalContinuationTurns ?? 50;
    this.#refreshGoalStatus();
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
    return this.#serializeInteraction(() =>
      this.#openDialog({
        title: `权限确认 · ${request.tool}`,
        body: [request.summary],
        hint: `${DIM}Esc / Enter 取消${RESET}`,
        actions: [
          { label: "同意", value: true, tone: "ok", shortcut: "y" },
          { label: "拒绝", value: false, tone: "error", shortcut: "n" },
        ],
      }),
    );
  }

  /**
   * 能力授权入口（目前是联网）。
   *
   * 弹窗里一定带**真实原因与细节**（哪条命令、什么报错）——
   * 否则用户看到的是一句没有上下文的"是否允许联网"，根本不知道在批准什么。
   */
  requestCapability(escalation: CapabilityEscalation): Promise<boolean> {
    return this.#serializeInteraction(() =>
      this.#openDialog({
        title: `需要授权 · ${describeCapability(escalation.capability)}`,
        body: [escalation.reason, ...(escalation.details ?? [])],
        hint: `${DIM}Esc / Enter 取消${RESET}`,
        actions: [
          { label: "允许这一次", value: true, tone: "warn", shortcut: "y" },
          { label: "拒绝", value: false, tone: "error", shortcut: "n" },
        ],
      }),
    );
  }

  /**
   * 档位不足时询问是否临时升档。
   *
   * 和权限确认共用同一个对话框 —— 将来 `ask_user` 也接这里。
   */
  confirmModeChange(request: PermissionRequest, needed: SandboxMode): Promise<boolean> {
    return this.#serializeInteraction(() =>
      this.#openDialog({
        title: `需要更高档位 · ${needed}`,
        body: [
          `${request.tool} 想${request.summary}`,
          `当前档位（${this.#mode}）不允许，需要升到 ${needed}`,
        ],
        hint: `${DIM}Esc / Enter 取消${RESET}`,
        actions: [
          { label: `升到 ${needed}`, value: true, tone: "warn", shortcut: "y" },
          { label: "拒绝", value: false, tone: "error", shortcut: "n" },
        ],
      }).then((approved) => {
        if (approved) this.#mode = needed;
        return approved;
      }),
    );
  }

  /**
   * ask_user 的交互入口。
   *
   * 与权限弹窗共用同一套外框渲染，区别只是内容是分页表单、
   * 按键路由到 AskUserFlow。返回 undefined 表示用户中止。
   */
  askUser(questions: readonly AskUserQuestion[]): Promise<AskUserAnswer[] | undefined> {
    return this.#serializeInteraction(
      () =>
        new Promise<AskUserAnswer[] | undefined>((resolve) => {
          this.#askResolve = resolve;
          this.#askFlow = new AskUserFlow({
            questions,
            onChange: () => this.#render(true),
          });
          this.#render(true);
        }),
    );
  }

  /** 工具触发的交互弹窗按到达顺序串行；同一时刻只能有一个可见对话框。 */
  #serializeInteraction<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#interactionTail.then(task, task);
    this.#interactionTail = run.then(
      () => {},
      () => {},
    );
    return run;
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
      this.#clearButtonInteraction();
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
      this.#scrollbarDrag = undefined;
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

    // 消息操作菜单：鼠标走统一路由，键盘支持快捷字母与 Esc。
    if (this.#pendingMessageMenu !== undefined) {
      if (key.type === "mouse") this.#handleMouse(key);
      else this.#resolveMessageMenuKey(key);
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

      case "newline":
        this.#insert("\n");
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

      case "home": {
        const layout = this.#inputLayout();
        this.#cursor = layout.starts[layout.cursorRow] ?? 0;
        this.#render();
        return;
      }

      case "end": {
        const layout = this.#inputLayout();
        const line = layout.lines[layout.cursorRow] ?? "";
        this.#cursor = inputIndexAt(layout, layout.cursorRow, visibleWidth(line));
        this.#render();
        return;
      }

      case "up":
        if (this.#moveInputVertical(-1)) return;
        if (this.#viewState.historyOpen) this.#scrollHistoryBy(1);
        else this.#scrollBy(1);
        return;

      case "down":
        if (this.#moveInputVertical(1)) return;
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

      case "paste": {
        this.#insert(key.value.replace(/\r\n?/g, "\n"));
        return;
      }
    }
  }

  /** 处理鼠标事件：左键点击按钮/折叠行，右键打开消息操作，滚轮滚动视窗。 */
  #handleMouse(key: Extract<Key, { type: "mouse" }>): void {
    if (this.#scrollbarDrag !== undefined) {
      if (key.button !== "left") return;
      if (key.motion) {
        this.#dragScrollbarTo(key.y);
        return;
      }
      if (!key.pressed) {
        this.#scrollbarDrag = undefined;
        this.#render();
        return;
      }
    }

    if (key.button === "wheelUp") {
      if (
        this.#pendingMessageMenu !== undefined ||
        this.#pendingDialog !== undefined ||
        this.#askFlow !== undefined
      ) {
        return;
      }
      if (this.#viewState.historyOpen) this.#scrollHistoryBy(3);
      else this.#scrollBy(3);
      return;
    }
    if (key.button === "wheelDown") {
      if (
        this.#pendingMessageMenu !== undefined ||
        this.#pendingDialog !== undefined ||
        this.#askFlow !== undefined
      ) {
        return;
      }
      if (this.#viewState.historyOpen) this.#scrollHistoryBy(-3);
      else this.#scrollBy(-3);
      return;
    }
    if (
      key.button === "left" &&
      key.pressed &&
      hitScrollbar(this.#scrollbar, key.x, key.y)
    ) {
      this.#beginScrollbarDrag(key.y);
      return;
    }
    // 鼠标移动：只更新悬停按钮，不触发点击。
    if (key.motion === true) {
      const target = this.#buttonTargetAt(key.x, key.y);
      if (!this.#sameButtonTarget(this.#hoveredButton, target)) {
        this.#hoveredButton = target;
        this.#render(true);
      }
      return;
    }

    // 屏幕坐标是 1-based；body 从第 2 行开始（第 1 行是状态栏）
    const bodyRow = key.y - 2;

    // 弹窗 / 消息操作菜单使用标准按下-抬起语义。
    if (this.#pendingMessageMenu !== undefined || this.#pendingDialog !== undefined) {
      if (key.button !== "left") return;

      if (key.pressed) {
        const target = this.#buttonTargetAt(key.x, key.y);
        this.#pressedButton = target;
        if (target !== undefined) this.#render(true);
        return;
      }

      const target = this.#buttonTargetAt(key.x, key.y);
      const pressed = this.#pressedButton;
      this.#pressedButton = undefined;
      if (pressed !== undefined && this.#sameButtonTarget(pressed, target)) {
        this.#invokeButton(pressed);
      } else {
        this.#render(true);
      }
      return;
    }

    if (!key.pressed) return;

    // ask_user：点到选项就选中/勾选，点到汇总里的题就跳回去。
    // #dialogTopRow 现在是 0-based 屏幕行号；覆盖层第 0 行是上边框。
    if (key.button === "left" && this.#askFlow !== undefined && this.#dialogTopRow >= 0) {
      const dialogRow = key.y - 1 - this.#dialogTopRow;
      const flowLine = dialogRow - 1;
      if (
        dialogRow >= 0 &&
        dialogRow < this.#dialogHeight &&
        flowLine >= 0 &&
        this.#askFlow.clickLine(flowLine)
      ) {
        this.#render(true);
        return;
      }
      // 点击弹窗其它区域时吞掉事件，不能穿透到下面的消息列表。
      if (dialogRow >= 0 && dialogRow < this.#dialogHeight) return;
    }

    if (key.button === "left" && hitTest(this.#returnToLatestHit, key.x, key.y)) {
      this.#returnToLatest();
      return;
    }

    if (
      key.button === "left" &&
      !this.#viewState.historyOpen &&
      hitTest(this.#moreHistoryHit, key.x, bodyRow)
    ) {
      this.#openHistoryDrawer();
      return;
    }

    if (this.#viewState.historyOpen || bodyRow < 0) return;
    if (key.button !== "left" && key.button !== "right") return;

    const bodyIndex = this.#bodyWindowStart + (bodyRow - this.#bodyContentOffset);

    // 工具卡片左键仍用于展开；右键留给消息操作。
    if (key.button === "left") {
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

    const hit = this.#messageAt(bodyIndex);
    if (hit !== undefined) this.#openMessageMenu(hit.msgid, hit.undoMsgid);
  }

  #clearButtonInteraction(): void {
    this.#hoveredButton = undefined;
    this.#pressedButton = undefined;
  }

  #sameButtonTarget(a: ButtonTarget | undefined, b: ButtonTarget | undefined): boolean {
    if (a === undefined || b === undefined) return a === b;
    if (a.kind !== b.kind) return false;
    return a.value === b.value;
  }

  #buttonTargetAt(x: number, y: number): ButtonTarget | undefined {
    if (this.#dialogTopRow < 0) return undefined;
    const dialogRow = y - 1 - this.#dialogTopRow;
    if (dialogRow < 0 || dialogRow >= this.#dialogHeight) return undefined;

    if (this.#pendingMessageMenu !== undefined) {
      const action = hitDialogActionAtLine(
        this.#messageButtonHits,
        dialogRow,
        x - 1,
      );
      return action === undefined ? undefined : { kind: "message", value: action };
    }

    if (this.#pendingDialog !== undefined) {
      const answer = hitDialogActionAtLine(
        this.#dialogButtonHits,
        dialogRow,
        x - 1,
      );
      return answer === undefined ? undefined : { kind: "dialog", value: answer };
    }

    return undefined;
  }

  #invokeButton(target: ButtonTarget): void {
    if (target.kind === "dialog") this.#finishDialog(target.value);
    else this.#resolveMessageAction(target.value);
  }

  #messageAt(bodyIndex: number): { msgid: MsgId; undoMsgid: MsgId } | undefined {
    for (const hit of this.#messageHits) {
      if (bodyIndex >= hit.start && bodyIndex <= hit.end) {
        return { msgid: hit.msgid, undoMsgid: hit.undoMsgid };
      }
    }
    return undefined;
  }

  #insert(text: string): void {
    const chars = Array.from(this.#input);
    chars.splice(this.#cursor, 0, ...Array.from(text));
    this.#input = chars.join("");
    this.#cursor += Array.from(text).length;
    this.#render();
  }

  #inputLayout() {
    const available = Math.max(1, this.#terminal.size.width - 4);
    return layoutInput(this.#input, this.#cursor, available);
  }

  /** Move across visual rows; return false only when the input is one row. */
  #moveInputVertical(delta: number): boolean {
    const layout = this.#inputLayout();
    if (layout.lines.length <= 1) return false;
    const targetRow = Math.max(
      0,
      Math.min(layout.cursorRow + delta, layout.lines.length - 1),
    );
    if (targetRow === layout.cursorRow) return true;
    const targetLine = layout.lines[targetRow] ?? "";
    const targetColumn = Math.min(layout.cursorColumn, visibleWidth(targetLine));
    this.#cursor = inputIndexAt(layout, targetRow, targetColumn);
    this.#render();
    return true;
  }

  #scrollBy(delta: number): void {
    this.#viewState = scrollMainView(this.#viewState, delta, this.#layout.totalLines, this.#bodyHeight);
    this.#render();
  }

  #setScrollOffset(offset: number): void {
    const delta = offset - this.#viewState.scrollOffset;
    this.#viewState = scrollMainView(
      this.#viewState,
      delta,
      this.#layout.totalLines,
      this.#bodyHeight,
    );
    this.#render();
  }

  #beginScrollbarDrag(y: number): void {
    const metrics = this.#scrollbar;
    if (metrics === undefined) return;
    const onThumb = scrollbarThumbAt(metrics, y);
    const grabOffset = onThumb ? y - metrics.thumbTop : Math.floor(metrics.thumbHeight / 2);
    this.#scrollbarDrag = { metrics, grabOffset };
    this.#setScrollOffset(scrollOffsetFromDrag(metrics, y, grabOffset));
  }

  #dragScrollbarTo(y: number): void {
    const drag = this.#scrollbarDrag;
    if (drag === undefined) return;
    this.#setScrollOffset(scrollOffsetFromDrag(drag.metrics, y, drag.grabOffset));
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
    if (text.length === 0) {
      // abort 后队列会保留；空 Enter 是用户明确表示“继续跑排队消息”。
      if (!this.#busy && this.#session.queuedUserCount > 0) this.#drainQueuedUser();
      return;
    }
    if (text === "/exit" || text === "/quit") {
      this.#requestExit();
      return;
    }
    if (text === "/new") {
      this.#startNewSession();
      return;
    }
    if (text === "/") {
      this.#clearInput();
      void this.#openCommandPalette();
      return;
    }
    if (text === "/context") {
      this.#clearInput();
      void this.#openContextDialog();
      return;
    }
    if (text === "/goal" || text.startsWith("/goal ")) {
      this.#clearInput();
      void this.#handleGoalCommand(text.slice("/goal".length).trim());
      return;
    }
    if (text === "/mode") {
      this.#clearInput();
      void this.#chooseSandboxMode();
      return;
    }
    if (text.startsWith("/mode ")) {
      const mode = text.slice("/mode ".length).trim();
      this.#clearInput();
      if (!isSandboxMode(mode)) {
        this.#transcript.pushError("未知档位，可选：read-only / workspace-write / no-sandbox");
        this.#render();
        return;
      }
      this.#reconfigureRuntime({ mode });
      return;
    }
    if (text === "/provider") {
      this.#clearInput();
      void this.#chooseProvider();
      return;
    }
    if (text.startsWith("/provider ")) {
      const providerId = text.slice("/provider ".length).trim();
      this.#clearInput();
      if (!this.#providerIds.includes(providerId)) {
        this.#transcript.pushError(`未知 provider：${providerId}`);
        this.#render();
        return;
      }
      this.#reconfigureRuntime({ providerId });
      return;
    }
    if (text === "/model") {
      this.#clearInput();
      void this.#promptModel();
      return;
    }
    if (text.startsWith("/model ")) {
      const model = text.slice("/model ".length).trim();
      this.#clearInput();
      if (model.length === 0) {
        this.#transcript.pushError("model 不能为空");
        this.#render();
        return;
      }
      this.#reconfigureRuntime({ model });
      return;
    }
    if (text === "/key") {
      this.#clearInput();
      void this.#promptApiKey();
      return;
    }
    if (text.startsWith("/")) {
      this.#clearInput();
      this.#transcript.pushError(`未知命令：${text}。输入 / 查看命令菜单`);
      this.#render();
      return;
    }

    this.#input = "";
    this.#cursor = 0;
    this.#viewState = initialHistoryView();
    this.#goalContinuationStreak = 0;
    this.#goalController?.clearUserDeferral();

    // busy 时绝不启动第二个 runTurn：先排队，等当前 turn 正常结束后自动 drain。
    if (this.#busy || this.#session.hasOpenToolBatch()) {
      const result = this.#session.submitUser(text);
      if (result.status === "queued") {
        this.#transcript.pushNotice(`[已排队 ${this.#session.queuedUserCount}]`);
      }
      this.#render();
      return;
    }

    // abort 后队列可能仍有内容；新输入排在队尾，并立即从队首继续，保持 FIFO。
    if (this.#session.queuedUserCount > 0) {
      this.#session.enqueueUser(text);
      this.#drainQueuedUser();
      return;
    }

    this.#render();
    void this.#runTurn(text);
  }

  #clearInput(): void {
    this.#input = "";
    this.#cursor = 0;
    this.#viewState = initialHistoryView();
    this.#render();
  }

  /** `/`：用现有 ask_user 选择器承载命令面板。 */
  async #openCommandPalette(): Promise<void> {
    const commands = [
      { label: "/context   查看当前 session 上下文", run: () => this.#openContextDialog() },
      { label: "/goal      初始化 / 查看 / 继续 Goal", run: () => this.#handleGoalCommand("") },
      { label: "/provider  切换 provider", run: () => this.#chooseProvider() },
      { label: "/model     切换模型", run: () => this.#promptModel() },
      { label: "/key       设置 API key（系统 keychain）", run: () => this.#promptApiKey() },
      { label: "/mode      调整沙箱档位", run: () => this.#chooseSandboxMode() },
      { label: "/new       新建会话", run: () => this.#startNewSession() },
      { label: "/exit      退出", run: () => this.#requestExit() },
    ] as const;

    const answers = await this.askUser([
      {
        question: "选择命令",
        options: commands.map((command) => command.label),
      },
    ]);
    const selected = answers?.[0]?.selected[0];
    if (selected === undefined) return;
    await commands[selected]?.run();
  }

  /**
   * `/goal` 是 Goal 的唯一显式入口。
   *
   * 有参数时只授予一次创建权并启动初始化 turn；真正创建仍由模型调用
   * `create_goal` 完成，但普通 turn 永远拿不到该权限。
   */
  async #handleGoalCommand(argument: string): Promise<void> {
    const controller = this.#goalController;
    if (controller === undefined) {
      this.#transcript.pushError("当前 session 未启用持久化，无法使用 Goal 模式");
      this.#render(true);
      return;
    }

    const goal = controller.currentGoal();
    if (argument === "pause") {
      if (goal === undefined) {
        this.#transcript.pushError("当前 session 没有 Goal");
      } else {
        try {
          controller.pause("用户通过 /goal pause 暂停");
          this.#refreshGoalStatus();
          this.#transcript.pushNotice("Goal 已暂停。输入 `/goal resume` 恢复。");
        } catch (error) {
          this.#transcript.pushError(error instanceof Error ? error.message : String(error));
        }
      }
      this.#render(true);
      return;
    }
    if (argument === "resume") {
      if (goal === undefined) {
        this.#transcript.pushError("当前 session 没有 Goal");
      } else {
        try {
          controller.resume();
          this.#refreshGoalStatus();
          this.#transcript.pushNotice("Goal 已恢复。");
        } catch (error) {
          this.#transcript.pushError(error instanceof Error ? error.message : String(error));
        }
      }
      this.#render(true);
      return;
    }
    if (argument === "continue") {
      if (goal === undefined) {
        this.#transcript.pushError("当前 session 没有 Goal");
        this.#render(true);
        return;
      }
      if (this.#busy || this.#session.hasOpenToolBatch()) {
        this.#transcript.pushError("当前一轮还在跑，先结束或中断再刷新 Context Epoch");
        this.#render(true);
        return;
      }
      try {
        const epoch = await controller.createContextEpoch("manual");
        if (this.#switchRuntime(epoch.branchId, `已创建 Context Epoch ${epoch.epochId}`)) {
          this.#refreshGoalStatus();
          this.#render(true);
        }
      } catch (error) {
        this.#transcript.pushError(error instanceof Error ? error.message : String(error));
        this.#render(true);
      }
      return;
    }
    if (argument === "checkpoints") {
      if (goal === undefined) {
        this.#transcript.pushError("当前 session 没有 Goal");
        this.#render(true);
        return;
      }
      const checkpoints = controller.repository.listCheckpoints(goal.id);
      await this.#openDialog({
        title: "Goal Checkpoints",
        body:
          checkpoints.length === 0
            ? ["尚未建立 Checkpoint"]
            : checkpoints.map((checkpoint) => {
                const marker =
                  checkpoint.status === "completed"
                    ? "[x]"
                    : checkpoint.status === "active" ||
                        checkpoint.status === "verifying" ||
                        checkpoint.status === "reviewing"
                      ? "[>]"
                      : checkpoint.status === "blocked"
                        ? "[!]"
                        : "[ ]";
                return `${marker} ${checkpoint.order}. ${checkpoint.title} · ${checkpoint.status}`;
              }),
        hint: `${DIM}Esc / Enter 关闭${RESET}`,
        actions: [{ label: "关闭", value: false, tone: "neutral", shortcut: "Esc" }],
      });
      return;
    }
    if (argument === "finalize") {
      if (goal === undefined) {
        this.#transcript.pushError("当前 session 没有 Goal");
        this.#render(true);
        return;
      }
      if (this.#busy || this.#session.hasOpenToolBatch()) {
        this.#transcript.pushError("当前一轮还在跑，先结束或中断再执行 final audit");
        this.#render(true);
        return;
      }
      this.#busy = true;
      this.#activity = { state: "tool", detail: "Goal final audit" };
      this.#render(true);
      try {
        const result = await controller.finalAudit();
        this.#transcript.pushNotice(
          result.approved
            ? "Goal final audit 通过，Goal 已完成。"
            : `Goal final audit 未通过：${result.errors.join("；")}`,
        );
      } catch (error) {
        this.#transcript.pushError(error instanceof Error ? error.message : String(error));
      } finally {
        this.#busy = false;
        this.#activity = { state: "idle" };
        this.#goalContinuationStreak = 0;
        this.#refreshGoalStatus();
        this.#render(true);
      }
      return;
    }
    if (argument === "edit") {
      if (goal === undefined) {
        this.#transcript.pushError("当前 session 没有 Goal");
        this.#render(true);
        return;
      }
      const objective = await this.#promptText(`Goal objective（当前：${goal.objective}）`);
      if (objective === undefined) return;
      const criteriaText = await this.#promptText("成功标准（用 ; 分隔）");
      if (criteriaText === undefined) return;
      const constraintsText = await this.#promptText("约束（用 ; 分隔，可留空）");
      const nonGoalsText = await this.#promptText("非目标（用 ; 分隔，可留空）");
      const split = (value: string | undefined): string[] =>
        (value ?? "")
          .split(";")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
      try {
        controller.editContract({
          rawIntent: goal.rawIntent,
          objective,
          successCriteria: split(criteriaText),
          constraints: split(constraintsText),
          nonGoals: split(nonGoalsText),
          riskPolicy: goal.riskPolicy,
          ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
        });
        this.#refreshGoalStatus();
        this.#transcript.pushNotice("Goal Contract 已更新。");
      } catch (error) {
        this.#transcript.pushError(error instanceof Error ? error.message : String(error));
      }
      this.#render(true);
      return;
    }
    if (argument === "clear") {
      if (goal === undefined) {
        this.#transcript.pushError("当前 session 没有 Goal");
        this.#render(true);
        return;
      }
      const confirmed = await this.#openDialog({
        title: "清除 Goal",
        body: [
          `将删除 Goal ${goal.id} 的 Checkpoint、Evidence、Review 元数据。`,
          "对话消息与 Handoff 文件会保留。",
        ],
        hint: `${DIM}Esc / Enter 取消${RESET}`,
        actions: [
          { label: "清除", value: true, tone: "error", shortcut: "y" },
          { label: "取消", value: false, tone: "neutral", shortcut: "n" },
        ],
      });
      if (confirmed) {
        try {
          const cleared = controller.clearGoal();
          this.#goalContinuationStreak = 0;
          this.#refreshGoalStatus();
          this.#transcript.pushNotice(`Goal 已清除：${cleared}`);
        } catch (error) {
          this.#transcript.pushError(error instanceof Error ? error.message : String(error));
        }
        this.#render(true);
      }
      return;
    }
    if (argument === "status" || (goal !== undefined && argument.length === 0)) {
      await this.#showGoalStatus();
      return;
    }
    if (goal !== undefined) {
      this.#transcript.pushError(
        "当前 session 已有 Goal。可用子命令：`/goal status`、`/goal checkpoints`、`/goal continue`、`/goal finalize`、`/goal pause`、`/goal resume`、`/goal edit`、`/goal clear`。",
      );
      this.#render(true);
      return;
    }

    const rawIntent = argument.length > 0 ? argument : await this.#promptText("输入 Goal 原始意图");
    if (rawIntent === undefined) return;
    await this.#initializeGoal(rawIntent);
  }

  async #initializeGoal(rawIntent: string): Promise<void> {
    const controller = this.#goalController;
    if (controller === undefined) return;
    if (this.#busy || this.#session.hasOpenToolBatch()) {
      this.#transcript.pushError("当前一轮还在跑，先按 ESC 中断再初始化 Goal");
      this.#render(true);
      return;
    }
    if (this.#session.queuedUserCount > 0) {
      this.#transcript.pushError("当前 session 还有排队消息，先处理完再初始化 Goal");
      this.#render(true);
      return;
    }

    controller.authorizeCreate();
    this.#session.enqueueInjection(GOAL_INITIALIZATION_INSTRUCTION, "goal");
    this.#transcript.pushNotice("Goal 初始化已开始：模型会先澄清契约，不会立即改代码。");
    this.#refreshGoalStatus();
    this.#render(true);
    await this.#runTurn(rawIntent);
  }

  async #showGoalStatus(): Promise<void> {
    const controller = this.#goalController;
    if (controller === undefined) return;
    const goal = controller.currentGoal();
    if (goal === undefined) {
      this.#transcript.pushError("当前 session 没有 Goal。使用 `/goal <目标>` 初始化。");
      this.#render(true);
      return;
    }

    const canResume =
      goal.status === "paused" ||
      goal.status === "blocked" ||
      goal.status === "usage_limited";
    const action = await this.#openDialog({
      title: "Goal 状态",
      body: controller.dialogLines(),
      hint: `${DIM}Esc / Enter 关闭${RESET}`,
      actions:
        goal.status === "active"
          ? [
              { label: "暂停 Goal", value: true, tone: "warn", shortcut: "p" },
              { label: "关闭", value: false, tone: "neutral", shortcut: "Esc" },
            ]
          : canResume
            ? [
                { label: "恢复 Goal", value: true, tone: "ok", shortcut: "r" },
                { label: "关闭", value: false, tone: "neutral", shortcut: "Esc" },
              ]
            : [{ label: "关闭", value: false, tone: "neutral", shortcut: "Esc" }],
    });
    if (!action) return;

    try {
      if (goal.status === "active") {
        controller.pause("用户在 Goal 状态面板暂停");
        this.#transcript.pushNotice("Goal 已暂停。");
      } else if (canResume) {
        controller.resume();
        this.#transcript.pushNotice("Goal 已恢复。");
      }
      this.#refreshGoalStatus();
    } catch (error) {
      this.#transcript.pushError(error instanceof Error ? error.message : String(error));
    }
    this.#render(true);
  }

  #refreshGoalStatus(): void {
    this.#goalStatusLine = this.#goalController?.statusLine();
  }

  /** `/context`：展示当前 session 的 effective config，并提供配置入口。 */
  async #openContextDialog(): Promise<void> {
    const mcpStatus = new Map(
      (this.#mcp?.servers ?? []).map((server) => [server.id, server.tools.length]),
    );
    const mcpLines =
      this.#mcp?.disabledReason !== undefined
        ? [`MCP       ${this.#mcp.disabledReason}`]
        : this.#mcpServers.length > 0
          ? this.#mcpServers.map(
              (server) =>
                `MCP       ${server.id} · ${
                  server.enabled ? `${mcpStatus.get(server.id) ?? 0} tools` : "disabled"
                }`,
            )
          : ["MCP       (none)"];
    const skillLines =
      this.#skillStatus !== undefined && this.#skillStatus.skills.length > 0
        ? this.#skillStatus.skills.map((skill) => `Skill     ${skill.name} · load tool`)
        : ["Skill     (none)"];
    const openMenu = await this.#openDialog({
      title: "会话上下文",
      body: [
        `session   ${this.#session.id}`,
        `branch    ${this.#session.branchId ?? "(未启用分支)"}`,
        `provider  ${this.#providerId}`,
        `model     ${this.#session.model}`,
        `client    ${this.#session.client.id}`,
        `endpoint  ${this.#providerConfig?.endpoint ?? "(registry)"}`,
        `baseUrl   ${this.#providerConfig?.baseUrl ?? "(registry)"}`,
        `sandbox   ${this.#mode}`,
        ...mcpLines,
        ...skillLines,
        `API key   ${this.#apiKeyOverride !== undefined ? "已设置（keychain / 内存）" : "使用 provider 配置"}`,
        `持久化    ${this.#createRuntime === undefined ? "关闭" : "开启"}`,
      ],
      hint: `${DIM}Esc / Enter 关闭${RESET}`,
      actions: [
        { label: "打开配置菜单", value: true, tone: "warn", shortcut: "m" },
        { label: "关闭", value: false, tone: "neutral", shortcut: "Esc" },
      ],
    });
    if (openMenu) await this.#openContextActions();
  }

  /** `/context` 的二级菜单。 */
  async #openContextActions(): Promise<void> {
    const actions = [
      { label: "调整沙箱档位", run: () => this.#chooseSandboxMode() },
      { label: "切换 provider", run: () => this.#chooseProvider() },
      { label: "切换模型", run: () => this.#promptModel() },
      { label: "设置 API key", run: () => this.#promptApiKey() },
      ...(this.#mcpServers.length > 0
        ? [
            { label: "启停 MCP server", run: () => this.#chooseMcpServer() },
            { label: "重载 MCP 工具", run: () => this.#chooseMcpReload() },
          ]
        : []),
      ...(this.#reloadSkills !== undefined
        ? [{ label: "重载 skills", run: () => this.#reloadSkillCatalog() }]
        : []),
    ] as const;

    const answers = await this.askUser([
      {
        question: "选择要调整的配置",
        options: actions.map((action) => action.label),
      },
    ]);
    const selected = answers?.[0]?.selected[0];
    if (selected === undefined) return;
    await actions[selected]?.run();
  }

  /** 切换当前 session 的 MCP server 启停状态。 */
  async #chooseMcpServer(): Promise<void> {
    const answers = await this.askUser([
      {
        question: "选择要启停的 MCP server",
        options: this.#mcpServers.map(
          (server) => `${server.enabled ? "停用" : "启用"} — ${server.id}`,
        ),
      },
    ]);
    const index = answers?.[0]?.selected[0];
    if (index === undefined) return;
    const selected = this.#mcpServers[index];
    if (selected === undefined) return;
    const next = this.#mcpServers.map((server) =>
      server.id === selected.id ? { ...server, enabled: !server.enabled } : server,
    );
    const enabledIds = next.filter((server) => server.enabled).map((server) => server.id);
    if (this.#reconfigureRuntime({ mcpServerIds: enabledIds })) {
      this.#transcript.pushNotice(
        `MCP server ${selected.id} 已${selected.enabled ? "停用" : "启用"}（当前 session）`,
      );
      this.#render(true);
    }
  }

  /** 重载当前 session 可用的 MCP server 工具快照。 */
  async #chooseMcpReload(): Promise<void> {
    if (this.#busy) {
      this.#transcript.pushError("当前一轮还在跑，先按 ESC 中断再重载 MCP");
      this.#render(true);
      return;
    }
    if (this.#reloadMcp === undefined) {
      this.#transcript.pushError("当前没有可用的 MCP 重载入口");
      this.#render(true);
      return;
    }
    const enabled = this.#mcpServers.filter((server) => server.enabled);
    if (enabled.length === 0) {
      this.#transcript.pushError("当前 session 没有启用的 MCP server");
      this.#render(true);
      return;
    }
    const answers = await this.askUser([
      {
        question: "选择要重载的 MCP server",
        options: enabled.map((server) => server.id),
      },
    ]);
    const index = answers?.[0]?.selected[0];
    if (index === undefined) return;
    const server = enabled[index];
    if (server === undefined) return;
    try {
      await this.#reloadMcp(server.id);
      this.#transcript.pushNotice(`MCP server ${server.id} 工具列表已重载`);
    } catch (error) {
      this.#transcript.pushError(error instanceof Error ? error.message : String(error));
    }
    this.#render(true);
  }

  /** 重载 skill catalog，并在安全边界追加 developer delta。 */
  async #reloadSkillCatalog(): Promise<void> {
    if (this.#busy) {
      this.#transcript.pushError("当前一轮还在跑，先按 ESC 中断再重载 skills");
      this.#render(true);
      return;
    }
    if (this.#reloadSkills === undefined) {
      this.#transcript.pushError("当前没有可用的 skills 重载入口");
      this.#render(true);
      return;
    }
    try {
      this.#skillStatus = await this.#reloadSkills();
      this.#transcript.pushNotice(
        `skills 已重载：当前 ${this.#skillStatus.skills.length} 个可用`,
      );
    } catch (error) {
      this.#transcript.pushError(error instanceof Error ? error.message : String(error));
    }
    this.#render(true);
  }

  /** 用单选表单切换当前 session 的沙箱档位。 */
  async #chooseSandboxMode(): Promise<void> {
    const modes: readonly SandboxMode[] = ["read-only", "workspace-write", "no-sandbox"];
    const answers = await this.askUser([
      {
        question: "选择当前 session 的沙箱档位",
        options: [
          "read-only — 根只读、工作区只读、断网",
          "workspace-write — 工作区可写、根只读、断网",
          "no-sandbox — 不隔离（危险）",
        ],
      },
    ]);
    const selected = answers?.[0]?.selected[0];
    if (selected === undefined) return;
    const mode = modes[selected];
    if (mode !== undefined) this.#reconfigureRuntime({ mode });
  }

  /** `/provider`：从已注册 provider 里选一个，或新增/管理 session provider。 */
  async #chooseProvider(): Promise<void> {
    const addLabel = "＋ 新增 provider…";
    const manageLabel = "⚙ 管理 session provider profiles…";
    const options = [...this.#providerIds, addLabel, manageLabel];
    const answers = await this.askUser([
      {
        question: "选择当前 session 的 provider",
        options,
      },
    ]);
    const selected = answers?.[0]?.selected[0];
    if (selected === undefined) return;
    if (selected === this.#providerIds.length) {
      await this.#addProvider();
      return;
    }
    if (selected === this.#providerIds.length + 1) {
      await this.#openProviderManager();
      return;
    }
    const providerId = this.#providerIds[selected];
    if (providerId === undefined) return;
    const providerConfig = this.#providerConfigs.get(providerId);
    const apiKey = await this.#loadApiKey?.(this.#session.id, providerId);
    this.#reconfigureRuntime({
      providerId,
      ...(providerConfig !== undefined ? { providerConfig } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  }

  /** 管理当前 session 的 provider profiles。 */
  async #openProviderManager(): Promise<void> {
    const profiles = [...this.#providerConfigs.values()];
    if (profiles.length === 0) {
      this.#transcript.pushError("当前 session 还没有自定义 provider profile");
      this.#render(true);
      return;
    }
    const answers = await this.askUser([
      {
        question: "选择要管理的 provider profile",
        options: [...profiles.map((profile) => profile.id), "返回"],
      },
    ]);
    const selected = answers?.[0]?.selected[0];
    if (selected === undefined || selected >= profiles.length) return;
    await this.#manageProviderProfile(profiles[selected]!.id);
  }

  async #manageProviderProfile(providerId: string): Promise<void> {
    const config = this.#providerConfigs.get(providerId);
    if (config === undefined) return;
    const answers = await this.askUser([
      {
        question: `管理 provider profile：${providerId}`,
        options: ["切换到这个 provider", "重命名", "复制", "删除", "清除 API key", "返回"],
      },
    ]);
    const action = answers?.[0]?.selected[0];
    if (action === undefined || action === 5) return;

    if (action === 0) {
      const apiKey = await this.#loadApiKey?.(this.#session.id, providerId);
      this.#reconfigureRuntime({
        providerId,
        providerConfig: config,
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
      return;
    }

    if (action === 1) {
      const newId = await this.#promptText("输入新的 provider id");
      if (newId === undefined) return;
      if (this.#providerConfigs.has(newId)) {
        this.#transcript.pushError(`provider profile 已存在：${newId}`);
        this.#render(true);
        return;
      }
      const oldKey =
        (await this.#loadApiKey?.(this.#session.id, providerId)) ??
        (providerId === this.#providerId ? this.#apiKeyOverride : undefined);
      const renamed: PersistedProviderConfig = { ...config, id: newId };
      if (providerId === this.#providerId) {
        if (
          !this.#reconfigureRuntime({
            providerId: newId,
            providerConfig: renamed,
            ...(oldKey !== undefined ? { apiKey: oldKey } : {}),
          })
        ) {
          return;
        }
      } else {
        if (this.#saveProviderConfig === undefined) {
          this.#transcript.pushError("当前未启用持久化，无法重命名 provider profile");
          this.#render(true);
          return;
        }
        this.#saveProviderConfig(this.#session.id, renamed);
      }
      this.#deleteProviderConfig?.(this.#session.id, providerId);
      if (oldKey !== undefined) {
        await this.#saveApiKey?.(this.#session.id, newId, oldKey);
        await this.#deleteApiKey?.(this.#session.id, providerId);
      }
      this.#providerConfigs.delete(providerId);
      this.#providerConfigs.set(newId, renamed);
      this.#refreshProviderIds();
      this.#audit?.sessionConfig({
        action: "provider_profile_rename",
        fromProviderId: providerId,
        toProviderId: newId,
      });
      this.#transcript.pushNotice(`已重命名 provider profile：${providerId} -> ${newId}`);
      this.#render(true);
      return;
    }

    if (action === 2) {
      const newId = await this.#promptText("输入复制后的 provider id");
      if (newId === undefined) return;
      if (this.#providerConfigs.has(newId)) {
        this.#transcript.pushError(`provider profile 已存在：${newId}`);
        this.#render(true);
        return;
      }
      if (this.#saveProviderConfig === undefined) {
        this.#transcript.pushError("当前未启用持久化，无法复制 provider profile");
        this.#render(true);
        return;
      }
      const copied: PersistedProviderConfig = { ...config, id: newId };
      this.#saveProviderConfig(this.#session.id, copied);
      const oldKey = await this.#loadApiKey?.(this.#session.id, providerId);
      if (oldKey !== undefined) await this.#saveApiKey?.(this.#session.id, newId, oldKey);
      this.#providerConfigs.set(newId, copied);
      this.#refreshProviderIds();
      this.#audit?.sessionConfig({
        action: "provider_profile_copy",
        fromProviderId: providerId,
        toProviderId: newId,
      });
      this.#transcript.pushNotice(`已复制 provider profile：${providerId} -> ${newId}`);
      this.#render(true);
      return;
    }

    if (action === 3) {
      if (providerId === this.#providerId) {
        this.#transcript.pushError("不能删除当前 active provider，先切换到其它 provider");
        this.#render(true);
        return;
      }
      if (this.#deleteProviderConfig === undefined) {
        this.#transcript.pushError("当前未启用持久化，无法删除 provider profile");
        this.#render(true);
        return;
      }
      this.#deleteProviderConfig(this.#session.id, providerId);
      await this.#deleteApiKey?.(this.#session.id, providerId);
      this.#providerConfigs.delete(providerId);
      this.#refreshProviderIds();
      this.#audit?.sessionConfig({
        action: "provider_profile_delete",
        providerId,
      });
      this.#transcript.pushNotice(`已删除 provider profile：${providerId}`);
      this.#render(true);
      return;
    }

    if (action === 4) {
      await this.#deleteApiKey?.(this.#session.id, providerId);
      this.#reconfigureRuntime({ clearApiKey: true });
      this.#audit?.sessionConfig({ action: "api_key_clear", providerId });
      this.#transcript.pushNotice(`已清除 API key：${providerId}`);
      this.#render(true);
    }
  }

  #refreshProviderIds(): void {
    this.#providerIds = [
      ...new Set<string>([
        ...this.#registeredProviderIds,
        ...this.#providerConfigs.keys(),
        this.#providerId,
      ]),
    ];
  }

  /** 新增 session 级 provider：非敏感字段持久化，API key 只留内存。 */
  async #addProvider(): Promise<void> {
    const id = await this.#promptText("输入 provider id（例如 local）");
    if (id === undefined) return;

    const endpointAnswers = await this.askUser([
      {
        question: "选择 provider endpoint",
        options: ["openai-chat", "mock"],
      },
    ]);
    const endpointIndex = endpointAnswers?.[0]?.selected[0];
    if (endpointIndex === undefined) return;
    const endpoint = endpointIndex === 0 ? "openai-chat" : "mock";

    const baseUrl = await this.#promptText("输入 base URL（mock 可留空）");

    const advancedAnswers = await this.askUser([
      {
        question: "配置高级字段？",
        options: ["跳过", "配置 headers / extraBody / reasoningReplay / proxy"],
      },
    ]);
    const advancedIndex = advancedAnswers?.[0]?.selected[0];
    if (advancedIndex === undefined) return;
    const advanced = advancedIndex === 1;

    const headersText = advanced
      ? await this.#promptText("输入 headers JSON（可留空，例如 {\"x-a\":\"b\"}）")
      : undefined;
    const extraBodyText = advanced
      ? await this.#promptText("输入 extraBody JSON（可留空）")
      : undefined;

    let reasoningReplay: PersistedProviderConfig["reasoningReplay"];
    if (advanced) {
      const reasoningAnswers = await this.askUser([
        {
          question: "选择 reasoningReplay",
          options: ["不覆盖（默认）", "none", "reasoning", "reasoning_content", "both"],
        },
      ]);
      const reasoningIndex = reasoningAnswers?.[0]?.selected[0];
      if (reasoningIndex === undefined) return;
      reasoningReplay =
        reasoningIndex === 0
          ? undefined
          : (["none", "reasoning", "reasoning_content", "both"] as const)[reasoningIndex - 1];
    }

    const proxyText = advanced
      ? await this.#promptText("输入 proxy（留空=默认，false=直连）")
      : undefined;
    const apiKey = await this.#promptSecret("输入 API key（可留空，仅当前进程）");

    try {
      const headers =
        headersText === undefined
          ? undefined
          : this.#parseJsonObject(headersText, "headers", "string");
      const extraBody =
        extraBodyText === undefined ? undefined : this.#parseJsonObject(extraBodyText, "extraBody");
      const providerConfig: PersistedProviderConfig = {
        id,
        endpoint,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(headers !== undefined ? { headers: headers as Record<string, string> } : {}),
        ...(extraBody !== undefined ? { extraBody } : {}),
        ...(reasoningReplay !== undefined ? { reasoningReplay } : {}),
        ...(proxyText !== undefined ? { proxy: proxyText === "false" ? false : proxyText } : {}),
      };
      this.#providerConfigs.set(id, providerConfig);
      this.#saveProviderConfig?.(this.#session.id, providerConfig);
      this.#refreshProviderIds();
      const ok = this.#reconfigureRuntime({
        providerId: id,
        providerConfig,
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
      if (ok) {
        if (apiKey !== undefined) await this.#saveApiKey?.(this.#session.id, id, apiKey);
        this.#audit?.sessionConfig({
          action: "provider_profile_create",
          providerId: id,
        });
      }
    } catch (error) {
      this.#transcript.pushError(error instanceof Error ? error.message : String(error));
      this.#render(true);
    }
  }

  #parseJsonObject(
    text: string,
    label: string,
    valueType?: "string",
  ): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${label} 不是合法 JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} 必须是 JSON object`);
    }
    const record = parsed as Record<string, unknown>;
    if (valueType === "string") {
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== "string") throw new Error(`${label}.${key} 必须是字符串`);
      }
    }
    return record;
  }

  /** 单行文本输入：单个无选项问题会自动进入输入态。 */
  async #promptText(question: string): Promise<string | undefined> {
    const answers = await this.askUser([{ question, options: [] }]);
    const value = answers?.[0]?.custom?.trim();
    return value !== undefined && value.length > 0 ? value : undefined;
  }

  /** 掩码输入；返回值只交给调用方，不写 transcript。 */
  async #promptSecret(question: string): Promise<string | undefined> {
    const answers = await this.askUser([{ question, options: [], secret: true }]);
    const value = answers?.[0]?.custom?.trim();
    return value !== undefined && value.length > 0 ? value : undefined;
  }

  /** `/model`：输入模型名；也可以输入 provider/model 一次切换两者。 */
  async #promptModel(): Promise<void> {
    const input = await this.#promptText("输入模型名（可写 provider/model）");
    if (input === undefined) return;

    try {
      if (input.includes("/")) {
        const ref = parseModelRef(input);
        const providerConfig = this.#providerConfigs.get(ref.provider);
        this.#reconfigureRuntime({
          providerId: ref.provider,
          model: ref.model,
          ...(providerConfig !== undefined ? { providerConfig } : {}),
        });
      } else {
        this.#reconfigureRuntime({ model: input });
      }
    } catch (error) {
      this.#transcript.pushError(error instanceof Error ? error.message : String(error));
      this.#render(true);
    }
  }

  /** `/key`：掩码输入；保存到系统 keychain，失败时降级到进程内存。 */
  async #promptApiKey(): Promise<void> {
    const key = await this.#promptSecret("输入 API key（保存到系统 keychain；不可用则仅当前进程）");
    if (key === undefined) return;
    const providerId = this.#providerId;
    if (this.#reconfigureRuntime({ apiKey: key })) {
      await this.#saveApiKey?.(this.#session.id, providerId, key);
      this.#audit?.sessionConfig({ action: "api_key_set", providerId });
    }
  }

  /**
   * 只重建当前 session 的 runtime，不换 session / branch，也不动消息历史。
   * provider/client 与 sandbox runner 都是构建期对象，所以必须走重建。
   */
  #reconfigureRuntime(
    overrides: {
      mode?: SandboxMode;
      providerId?: string;
      model?: string;
      apiKey?: string;
      clearApiKey?: boolean;
      providerConfig?: PersistedProviderConfig;
      mcpServerIds?: readonly string[];
    } = {},
  ): boolean {
    const mode = overrides.mode ?? this.#mode;
    const providerId = overrides.providerId ?? this.#providerId;
    const model = overrides.model ?? this.#session.model;
    const mcpServerIds =
      overrides.mcpServerIds ??
      this.#mcpServers.filter((server) => server.enabled).map((server) => server.id);
    const providerChanged = providerId !== this.#providerId;
    const providerConfig =
      overrides.providerConfig ?? (providerChanged ? undefined : this.#providerConfig);
    const apiKey = overrides.clearApiKey
      ? undefined
      : overrides.apiKey ?? (providerChanged ? undefined : this.#apiKeyOverride);

    if (
      mode === this.#mode &&
      providerId === this.#providerId &&
      model === this.#session.model &&
      overrides.apiKey === undefined &&
      overrides.clearApiKey !== true &&
      overrides.providerConfig === undefined &&
      overrides.mcpServerIds === undefined
    ) {
      this.#transcript.pushNotice("当前 session 配置没有变化");
      this.#render(true);
      return true;
    }
    if (this.#busy) {
      this.#transcript.pushError("当前一轮还在跑，先按 ESC 中断再切换配置");
      this.#render(true);
      return false;
    }
    if (this.#createRuntime === undefined) {
      this.#transcript.pushError("当前未启用 runtime 切换，无法调整 session 配置");
      this.#render(true);
      return false;
    }
    if (this.#session.queuedUserCount > 0) {
      this.#transcript.pushError("当前 session 还有排队消息，先处理完再切换配置");
      this.#render(true);
      return false;
    }

    try {
      const runtime = this.#createRuntime(this, {
        sessionId: this.#session.id,
        ...(this.#session.branchId !== undefined ? { branchId: this.#session.branchId } : {}),
        mode,
        providerId,
        model,
        ...(providerConfig !== undefined ? { providerConfig } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
        mcpServerIds,
      });
      this.#adoptRuntime(runtime);
      if (overrides.clearApiKey === true) this.#apiKeyOverride = undefined;
      else if (overrides.apiKey !== undefined) this.#apiKeyOverride = overrides.apiKey;
      else if (providerChanged) this.#apiKeyOverride = undefined;
      if (providerConfig !== undefined) {
        this.#providerConfig = providerConfig;
        this.#providerConfigs.set(providerId, providerConfig);
      } else if (providerChanged) {
        this.#providerConfig = undefined;
      }
      this.#audit?.sessionConfig({
        action: "provider_model_mode",
        providerId,
        model,
        mode,
      });
      this.#transcript.pushNotice(
        `当前 session 配置已更新：${providerId}/${model} · ${mode}${
          this.#apiKeyOverride !== undefined ? " · API key 仅当前进程生效" : ""
        }`,
      );
      this.#render(true);
      return true;
    } catch (error) {
      this.#transcript.pushError(error instanceof Error ? error.message : String(error));
      this.#render(true);
      return false;
    }
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
    this.#thinking.reset();
    this.#stopThinkingAnimation();
    this.#todoCache = undefined;
    this.#messageHits = [];
    this.#toolHits = [];

    if (this.#createRuntime !== undefined) {
      const runtime = this.#createRuntime(this, { mode: this.#mode });
      this.#session.clearQueues();
      this.#adoptRuntime(runtime);
    } else {
      const next = this.#createSession!();
      this.#session.clearQueues();
      this.#session = next;
      this.#apiKeyOverride = undefined;
      this.#lastAssistantMsgid = undefined;
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
      const shortcut = dialog.actions.find(
        (action) => action.shortcut !== undefined && action.shortcut.toLowerCase() === value,
      );
      if (shortcut !== undefined) answer = shortcut.value;
      else if (value === "y" || value === "yes") answer = true;
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
    this.#clearButtonInteraction();
    dialog.resolve(answer);
    this.#render(true);
  }

  /* --------------------------- 消息操作 / 分支 --------------------------- */

  #messageById(msgid: MsgId): StoredMessage | undefined {
    return this.#session.messages.find((message) => message.msgid === msgid);
  }

  #openMessageMenu(msgid: MsgId, undoMsgid: MsgId = msgid): void {
    const message = this.#messageById(msgid);
    if (message === undefined) return;
    if (this.#branchService === undefined || this.#createRuntime === undefined) {
      this.#transcript.pushError("当前会话未启用持久化分支，无法执行消息操作");
      this.#render();
      return;
    }

    const toolCount = message.toolCalls?.length ?? 0;
    const detail = [
      `${message.role} / ${message.origin} · msgid ${message.msgid}`,
      oneLine(storedText(message)) || (toolCount > 0 ? `${toolCount} 个工具调用` : "(无文本)"),
      "",
    ];

    this.#clearButtonInteraction();
    this.#pendingMessageMenu = {
      msgid,
      undoMsgid,
      title: `消息操作 · #${msgid}`,
      body: detail,
      hint: "点击动作，或按对应字母",
      actions: MESSAGE_ACTIONS.map((item) => ({
        label: item.label,
        value: item.action,
        ...(item.tone !== undefined ? { tone: item.tone } : {}),
        ...(item.shortcut !== undefined ? { shortcut: item.shortcut } : {}),
      })),
    };
    this.#render(true);
  }

  #resolveMessageMenuKey(key: Key): void {
    if (key.type === "escape" || key.type === "enter") {
      this.#resolveMessageAction("cancel");
      return;
    }
    if (key.type !== "text") return;
    const action = messageActionFromKey(key.value.trim());
    if (action !== undefined) this.#resolveMessageAction(action);
  }

  #resolveMessageAction(action: MessageAction): void {
    const menu = this.#pendingMessageMenu;
    if (menu === undefined) return;
    this.#pendingMessageMenu = undefined;
    this.#messageButtonHits = [];
    this.#clearButtonInteraction();

    if (action === "cancel") {
      this.#render(true);
      return;
    }
    if (this.#busy) {
      this.#transcript.pushError("当前一轮还在跑，先按 ESC 中断再操作消息");
      this.#render(true);
      return;
    }
    if (this.#branchService === undefined || this.#createRuntime === undefined) {
      this.#transcript.pushError("当前会话未启用持久化分支");
      this.#render(true);
      return;
    }

    try {
      switch (action) {
        case "undo": {
          void this.#requestUndoPreview(menu.undoMsgid);
          return;
        }

        case "fork": {
          const result = this.#branchService.fork(this.#session.id, menu.msgid);
          this.#switchRuntime(result.branchId, `已从 #${menu.msgid} 分叉；原分支仍保留`);
          return;
        }

        case "retry": {
          const plan = this.#branchService.retryFrom(this.#session.id, menu.msgid);
          if (this.#switchRuntime(plan.branchId, `正在从 #${plan.userMsgid} 重试`)) {
            void this.#runTurn(plan.input, true);
          }
          return;
        }

        case "copy": {
          const message = this.#messageById(menu.msgid);
          if (message === undefined) throw new Error(`消息 ${menu.msgid} 已不存在`);
          const text = storedText(message);
          const payload = Buffer.from(text, "utf8").toString("base64");
          this.#terminal.write(`\x1b]52;c;${payload}\x1b\\`);
          this.#transcript.pushNotice(copyNotice(text));
          this.#render(true);
          return;
        }

        case "inspect": {
          const message = this.#messageById(menu.msgid);
          if (message === undefined) throw new Error(`消息 ${menu.msgid} 已不存在`);
          void this.#openDialog({
            title: `消息详情 · #${menu.msgid}`,
            body: [
              `role: ${message.role}`,
              `origin: ${message.origin}`,
              `parent: ${message.parentMsgId ?? "(root)"}`,
              `created: ${new Date(message.createdAt).toLocaleString()}`,
              `toolCallId: ${message.toolCallId ?? "(none)"}`,
              "",
              ...storedText(message).split("\n").slice(0, 6),
            ],
            hint: `${DIM}Esc / Enter 关闭${RESET}`,
            actions: [{ label: "关闭", value: false, tone: "neutral", shortcut: "Esc" }],
          });
          return;
        }
      }
    } catch (error) {
      this.#transcript.pushError(error instanceof Error ? error.message : String(error));
      this.#render(true);
    }
  }

  async #requestUndoPreview(msgid: MsgId): Promise<void> {
    const branchService = this.#branchService;
    if (branchService === undefined) return;

    try {
      const target = this.#messageById(msgid);
      const mode =
        target?.role === "tool" || (target?.role === "assistant" && (target.toolCalls?.length ?? 0) > 0)
          ? "before"
          : "at";
      const preview = branchService.previewUndo(this.#session.id, msgid, mode);
      const fs = createWorkspaceFs(this.#cwd);
      const workspacePlan = await planWorkspaceUndo(preview.removed, fs);
      const before = this.#todos();
      const after = currentTodoList(preview.retained, { hideCompletedAfterUserTurn: true });

      if (workspacePlan.conflicts.length > 0) {
        await this.#openDialog({
          title: `撤回冲突 · #${msgid}`,
          body: [
            "以下文件已被外部修改，撤回不会写入任何文件：",
            ...workspacePlan.conflicts.map((path) => `  ${path}`),
            "",
            "请先处理这些文件，再重新发起撤回。",
          ],
          hint: `${DIM}Esc / Enter 关闭${RESET}`,
          actions: [{ label: "关闭", value: false, tone: "neutral", shortcut: "Esc" }],
        });
        return;
      }

      const workspaceLines = workspacePlan.files.length > 0
        ? [`工作区：${workspacePlan.files.length} 个文件将反向 patch`]
        : ["工作区：无已记录的 edit_file / write_file 变更"];
      const workspaceNote = "说明：bash 的副作用暂不追踪；原分支会完整保留。";
      const irreversibleLines = workspacePlan.irreversible.length > 0
        ? [`不可逆：${workspacePlan.irreversible.join("、")}`]
        : [];

      const confirmed = await this.#openDialog({
        title: `撤回预览 · #${msgid}`,
        body: [
          `当前分支：${preview.sourceBranchId}`,
          `保留 ${preview.retained.length} 条消息，移出 ${preview.removed.length} 条`,
          ...workspaceLines,
          ...irreversibleLines,
          todoImpact(before, after),
          workspaceNote,
        ],
        hint: `${DIM}Esc / Enter 取消${RESET}`,
        actions: [
          { label: "确认撤回", value: true, tone: "warn", shortcut: "y" },
          { label: "取消", value: false, tone: "neutral", shortcut: "n" },
        ],
      });
      if (!confirmed) return;

      const workspaceResult = await applyWorkspaceUndo(workspacePlan, fs);
      if (!workspaceResult.ok) {
        this.#transcript.pushError(
          `工作区撤回失败：${workspaceResult.conflicts.join("、") || "未知冲突"}`,
        );
        this.#render(true);
        return;
      }

      const result = branchService.undoTo(this.#session.id, msgid, mode);
      const files = workspaceResult.applied.length;
      this.#switchRuntime(
        result.branchId,
        `已撤回到 #${msgid}；原分支仍保留${files > 0 ? `；已回滚 ${files} 个文件` : ""}`,
      );
    } catch (error) {
      this.#transcript.pushError(error instanceof Error ? error.message : String(error));
      this.#render(true);
    }
  }

  #adoptRuntime(runtime: SessionRuntime): void {
    this.#runtime?.dispose();
    this.#runtime = runtime;
    if (runtime.session.id !== this.#session.id) {
      this.#apiKeyOverride = undefined;
      this.#goalContinuationStreak = 0;
    }
    this.#session = runtime.session;
    this.#tools = runtime.tools;
    this.#mode = runtime.mode;
    this.#audit = runtime.audit;
    this.#providerId = runtime.providerId;
    this.#goalController = runtime.goalController;
    this.#refreshGoalStatus();
    if (runtime.mcpStatus !== undefined) {
      this.#mcp = runtime.mcpStatus;
      const enabled = new Set(runtime.mcpStatus.servers.map((server) => server.id));
      this.#mcpServers = this.#mcpServers.map((server) => ({
        ...server,
        enabled: enabled.has(server.id),
      }));
    } else if (this.#mcp?.disabledReason === undefined) this.#mcp = undefined;
    this.#skillStatus = runtime.skillStatus;
    this.#activity = { state: "idle" };
    this.#lastAssistantMsgid = undefined;
  }

  #switchRuntime(branchId: string, notice?: string): boolean {
    if (this.#createRuntime === undefined) {
      this.#transcript.pushError("当前未启用 runtime 切换");
      this.#render(true);
      return false;
    }

    const runtime = this.#createRuntime(this, {
      sessionId: this.#session.id,
      branchId,
      mode: this.#mode,
    });
    // 旧分支的排队消息不能带入新分支；retry 也只重发原 user message 一次。
    this.#session.clearQueues();
    this.#adoptRuntime(runtime);
    this.#transcript = new Transcript();
    this.#transcript.restore(runtime.session.messages);
    if (notice !== undefined) this.#transcript.pushNotice(notice);

    this.#layout = new TranscriptLayout<DisplayItem>();
    this.#viewState = initialHistoryView();
    this.#lastLayoutTotal = 0;
    this.#usage = { input: 0, output: 0 };
    this.#todoCache = undefined;
    this.#messageHits = [];
    this.#toolHits = [];
    this.#thinking.reset();
    this.#stopThinkingAnimation();
    this.#input = "";
    this.#cursor = 0;
    this.#render(true);
    return true;
  }

  /* --------------------------- 对话推进 --------------------------- */

  async #runTurn(
    input: string | undefined,
    retry = false,
    options: {
      appendUser?: boolean;
      goalContinuation?: boolean;
      fingerprintBefore?: string;
      turnId?: string;
    } = {},
  ): Promise<void> {
    const controller = new AbortController();
    const startedAt = Date.now();
    const turnId = options.turnId ?? `turn-${crypto.randomUUID()}`;
    const appendUser = options.appendUser ?? true;
    this.#busy = true;
    this.#abort = controller;
    this.#thinking.reset();
    this.#patchStreams.clear();
    this.#transcript.clearStreamingTools();
    this.#activity = retry
      ? { state: "retrying", detail: "重新请求" }
      : options.goalContinuation
        ? { state: "waiting", detail: "Goal continuation" }
        : { state: "waiting", detail: "连接模型" };
    this.#stopThinkingAnimation();
    this.#syncThinkingAnimation();
    this.#render();
    this.#syncTodoShimmer();

    const uiHooks: LoopHooks = {
      onUser: (message) => {
        this.#transcript.pushUser(storedText(message), message.msgid);
        this.#scheduleRender();
      },
      onText: (delta) => {
        this.#transcript.appendAssistantText(delta);
        this.#setActivity({ state: "responding", detail: "生成回复" });
      },
      // 思考链路：只进滚动缓冲，不进消息区、不落库
      onReasoning: (delta) => {
        this.#thinking.push(delta);
        this.#setActivity({ state: "thinking" });
      },
      // 一条 assistant 消息结束：断开流式块，下一条消息另起一块。
      // 漏掉这一步会把"工具调用前的说明"和"最终答复"拼进同一行。
      onAssistant: (message) => {
        // reasoning 不落 msgid；assistant 消息边界就是思考链路的生命周期边界。
        this.#thinking.reset();
        this.#lastAssistantMsgid = message.msgid;
        this.#transcript.endAssistant(message.msgid);
        this.#setActivity(
          message.toolCalls !== undefined && message.toolCalls.length > 0
            ? { state: "tool", detail: message.toolCalls.map((call) => call.name).join(", ") }
            : { state: "waiting", detail: "整理回复" },
        );
      },
      onToolCallDelta: (delta) => {
        if (delta.reset === true) {
          this.#patchStreams.clear();
          this.#transcript.clearStreamingTools();
          this.#scheduleRender();
          return;
        }

        this.#transcript.updateToolCallDelta(delta);
        if (delta.name === APPLY_PATCH_TOOL_NAME) {
          let stream = this.#patchStreams.get(delta.id);
          if (stream === undefined) {
            stream = new PatchStreamProgress();
            this.#patchStreams.set(delta.id, stream);
          }
          const progress = stream.push(delta.rawArgs);
          if (progress !== undefined) {
            this.#transcript.setToolPatchProgress(delta.id, progress);
          }
        }
        this.#setActivity({ state: "tool", detail: delta.name || "接收工具参数" });
        this.#scheduleRender();
      },
      onToolCall: (call) => {
        const patchStream = this.#patchStreams.get(call.id);
        if (patchStream !== undefined) {
          try {
            this.#transcript.setToolPatchProgress(call.id, patchStream.finish());
          } catch {
            // 真正的执行器会返回带行号的解析错误；预览失败不提前污染卡片。
          }
          this.#patchStreams.delete(call.id);
        }
        this.#transcript.startTool(call, this.#lastAssistantMsgid);
        const activity: AgentActivity =
          call.name === "create_goal" || call.name === "update_goal"
            ? { state: "goal_init", detail: call.name }
            : call.name === "update_plan"
              ? { state: "goal_plan", detail: "更新 Plan" }
              : call.name === "todo_write" && this.#goalController?.currentGoal() !== undefined
                ? { state: "goal_checkpoint", detail: "更新 Todo" }
                : call.name === "submit_checkpoint"
                  ? { state: "goal_review", detail: "验证与审查" }
                  : call.name === "get_handoff" || call.name === "handoff_update"
                    ? { state: "goal_handoff", detail: call.name }
                    : call.name === "final_audit"
                      ? { state: "goal_audit", detail: "最终审计" }
                      : { state: "tool", detail: call.name };
        this.#setActivity(activity);
      },
      // 运行中的流式输出：只保留末尾若干行，内存有界
      onToolProgress: (call, chunk, stream) => {
        this.#transcript.appendToolProgress(call.id, chunk, stream);
        this.#scheduleRender();
      },
      // 工具跑失败后请求一次性能力授权（如联网）—— 弹窗里带真实原因与报错
      onRequestCapability: (_call, escalation) => this.requestCapability(escalation),
      // ask_user：多页问答表单；用户中止时暂停自动 continuation，直到下一条输入。
      onAskUser: async (_call, questions) => {
        this.#setActivity({ state: "waiting_user", detail: "等待回答" });
        const answers = await this.askUser(questions);
        if (answers === undefined) this.#goalController?.deferForUser();
        else this.#goalController?.clearUserDeferral();
        this.#setActivity({ state: "waiting", detail: "处理回答" });
        return answers;
      },
      onToolResult: (call, result, message) => {
        this.#transcript.finishTool(
          call.id,
          result.output,
          result.ok,
          message?.msgid,
          result.presentation,
        );
        if (
          call.name === "get_goal" ||
          call.name === "create_goal" ||
          call.name === "update_goal" ||
          call.name === "update_plan" ||
          call.name === "todo_write"
        ) {
          this.#refreshGoalStatus();
        }
        this.#setActivity({ state: "waiting", detail: "读取工具结果" });
        this.#syncTodoShimmer();
      },
      onUsage: (usage) => {
        this.#usage = Transcript.mergeUsage(this.#usage, usage);
        this.#scheduleRender();
      },
      onExtensionRoleFallback: async (error) => {
        this.#setActivity({ state: "retrying", detail: "兼容性重发" });
        return this.#confirmExtensionRoleFallback(error);
      },
    };
    const hooks = combineHooks(uiHooks, this.#audit?.hooks());

    let completed = false;
    let failure: string | undefined;
    let turnUsage: Usage = { input: 0, output: 0 };
    try {
      const runOptions = {
        tools: this.#tools,
        cwd: this.#cwd,
        hooks,
        signal: controller.signal,
      };
      const result =
        appendUser && input !== undefined
          ? await runUserTurn(this.#session, input, runOptions)
          : await runTurn(this.#session, runOptions);
      turnUsage = result.usage;
      completed = result.reason !== "error";
      if (!completed) failure = "请求未完成";
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      this.#transcript.pushError(failure);
    } finally {
      const aborted = controller.signal.aborted;
      const endedAt = Date.now();
      this.#patchStreams.clear();
      this.#transcript.clearStreamingTools();
      this.#transcript.endAssistant();
      this.#thinking.reset();
      this.#busy = false;
      this.#stopTodoShimmer();
      this.#abort = undefined;
      this.#goalController?.revokeCreateAuthorization();

      const goal = this.#goalController?.currentGoal();
      if (goal !== undefined) {
        try {
          const completion = this.#goalController!.completeTurn({
            turnId,
            startedAt,
            endedAt,
            usage: turnUsage,
            ...(aborted
              ? { outcome: "aborted" as const }
              : failure !== undefined
                ? { outcome: "error" as const }
                : {}),
            ...(options.fingerprintBefore !== undefined
              ? { fingerprintBefore: options.fingerprintBefore }
              : {}),
          });
          if (completion.blocked) {
            this.#transcript.pushNotice("Goal 连续 3 轮无进展，已进入 blocked。");
          } else if (completion.budgetLimited) {
            this.#transcript.pushNotice("Goal 已达到 token budget，自动 continuation 已停止。");
          }
        } catch (error) {
          this.#transcript.pushError(
            `Goal usage 记账失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (
        failure !== undefined &&
        /usage limit|quota|rate limit|额度|配额/i.test(failure) &&
        goal?.status === "active"
      ) {
        try {
          this.#goalController?.markUsageLimited(failure);
        } catch {
          // 状态已被并发用户操作改变时不覆盖用户决定。
        }
      }
      this.#refreshGoalStatus();

      if (aborted) {
        this.#activity = { state: "aborted", detail: "用户中断" };
      } else if (failure !== undefined) {
        this.#activity = { state: "disconnected", detail: failure };
      } else {
        this.#activity = { state: "idle" };
      }
      this.#stopThinkingAnimation();

      const queued = this.#session.queuedUserCount;
      if (aborted && queued > 0) {
        this.#transcript.pushNotice(`已中断；[已排队 ${queued}] 保留，按 Enter 继续`);
      }
      this.#render();

      // 用户输入始终优先于 Goal continuation / context refresh。
      if (completed && !aborted) {
        if (this.#session.queuedUserCount > 0) this.#drainQueuedUser();
        else if (failure === undefined) {
          if (this.#goalController?.shouldAutoRefreshContext() === true) {
            void this.#refreshGoalContext();
          } else {
            this.#maybeContinueGoal();
          }
        }
      }
    }
  }

  async #refreshGoalContext(): Promise<void> {
    const controller = this.#goalController;
    if (controller === undefined || this.#busy || this.#session.queuedUserCount > 0) return;
    this.#busy = true;
    this.#activity = { state: "goal_handoff", detail: "创建 Context Epoch" };
    this.#render(true);
    try {
      const epoch = await controller.createContextEpoch("checkpoint");
      if (this.#switchRuntime(epoch.branchId, `Checkpoint 后已切换 Context Epoch ${epoch.epochId}`)) {
        this.#refreshGoalStatus();
        this.#render(true);
      }
    } catch (error) {
      this.#transcript.pushError(
        `Context Epoch 创建失败：${error instanceof Error ? error.message : String(error)}`,
      );
      this.#render(true);
    } finally {
      this.#busy = false;
      this.#activity = { state: "idle" };
      this.#refreshGoalStatus();
      this.#render(true);
      if (!this.#busy && this.#session.queuedUserCount === 0) this.#maybeContinueGoal();
    }
  }

  #maybeContinueGoal(): void {
    if (!this.#goalAutoContinue || this.#busy || this.#session.hasOpenToolBatch()) return;
    if (this.#session.queuedUserCount > 0) return;
    if (this.#goalContinuationStreak >= this.#maxGoalContinuationTurns) {
      this.#transcript.pushNotice(
        `Goal 已达到连续自动推进上限 ${this.#maxGoalContinuationTurns}，等待用户输入。`,
      );
      this.#render();
      return;
    }
    const controller = this.#goalController;
    if (controller === undefined) return;
    const check = controller.canAutoContinue();
    if (!check.allowed) {
      this.#refreshGoalStatus();
      return;
    }

    try {
      const start = controller.beginContinuation();
      this.#goalContinuationStreak += 1;
      void this.#runTurn(undefined, false, {
        appendUser: false,
        goalContinuation: true,
        fingerprintBefore: start.fingerprint,
        turnId: start.turnId,
      });
    } catch (error) {
      this.#transcript.pushError(error instanceof Error ? error.message : String(error));
      this.#render();
    }
  }

  /** 取队首用户消息，开始下一 turn；队列为空则 no-op。 */
  #drainQueuedUser(): void {
    if (this.#busy || this.#session.hasOpenToolBatch()) return;
    const next = this.#session.dequeueUserAfterTurn();
    if (next === undefined) return;
    void this.#runTurn(next);
  }

  /** developer role 不被端点接受时，询问是否用 system role 重发扩展清单。 */
  #confirmExtensionRoleFallback(error: unknown): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);
    return this.#openDialog({
      title: "兼容性回退 · developer role",
      body: [
        "当前 provider 可能不支持 developer role。",
        "MCP / skills 清单仍在 msgid1/msgid2，历史不会被改写。",
        "是否改用 system role 重新发送这两条清单？",
        "",
        oneLine(message, 72),
      ],
      hint: `${DIM}Esc / Enter 取消${RESET}`,
      actions: [
        { label: "改用 system role", value: true, tone: "warn", shortcut: "y" },
        { label: "取消", value: false, tone: "neutral", shortcut: "n" },
      ],
    });
  }

  #setActivity(activity: AgentActivity, render = true): void {
    this.#activity = activity;
    this.#syncThinkingAnimation();
    if (render) this.#scheduleRender();
  }

  /** 工作中的菊花动画；没有 active work 时不常驻定时器。 */
  #syncThinkingAnimation(): void {
    const active = this.#busy && isSpinningActivity(this.#activity);
    if (!active) {
      this.#stopThinkingAnimation();
      return;
    }
    if (this.#thinkingTimer !== undefined) return;

    this.#thinkingTimer = setInterval(() => {
      if (!this.#busy || !isSpinningActivity(this.#activity)) {
        this.#stopThinkingAnimation();
        return;
      }
      this.#thinkingFrame += 1;
      this.#render();
    }, 80);
  }

  #stopThinkingAnimation(): void {
    if (this.#thinkingTimer !== undefined) {
      clearInterval(this.#thinkingTimer);
      this.#thinkingTimer = undefined;
    }
    this.#thinkingFrame = 0;
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
    this.#syncThinkingAnimation();
    this.#syncTodoShimmer();

    const { width, height } = this.#terminal.size;
    if (this.#screen.resize(width, height)) force = true;
    if (force) this.#screen.invalidate();

    const lines = this.#compose(width, height);
    const output = this.#screen.draw(lines);
    if (output.length > 0) this.#terminal.write(`\x1b[?25l${output}`);
    this.#terminal.setCursor(this.#inputCursorRow, this.#inputCursorColumn);
  }

  #compose(width: number, height: number): string[] {
    const overlayOpen =
      this.#pendingDialog !== undefined ||
      this.#pendingMessageMenu !== undefined ||
      this.#askFlow !== undefined;
    const dialogLines = overlayOpen ? this.#paintDialog(this.#renderDialog(width)) : [];
    // 弹窗占用输入框区域，不再覆盖消息区；终端再小也至少给消息区留 1 行。
    const maxDialogRows = Math.max(0, height - 2);
    const dialogBlock = dialogLines
      .slice(0, maxDialogRows)
      .map((line) => centerLine(line, width));
    const dialogRows = dialogBlock.length;

    // 思考区固定预留（默认 3 行，小终端自动收缩），不思考时是全空白 ——
    // 这块空间同时充当输入框上方的呼吸留白。
    // 有弹窗时隐藏思考区，把空间让给正文与弹窗。
    const thinkingRows =
      dialogRows > 0 ? 0 : Math.min(THINKING_BLOCK_ROWS, Math.max(1, height - 4));
    const thinkingBlock =
      dialogRows > 0
        ? []
        : composeThinkingBlock(this.#thinking, width, {
            rows: thinkingRows,
            frame: this.#thinkingFrame,
            activity: this.#activity,
          });

    // sticky 待办面板：不能吃掉太多屏幕，最多占 40% 且必须给消息区留位置。
    const panelBudget = Math.max(
      0,
      Math.min(
        Math.floor(height * 0.4),
        dialogRows > 0
          ? height - 2 - dialogRows
          : height - 3 - thinkingBlock.length,
      ),
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

    const bodyHeight =
      dialogRows > 0
        ? Math.max(1, height - 1 - todoPanel.length - dialogRows)
        : Math.max(
            1,
            height - 2 - (INPUT_ROWS - 1) - todoPanel.length - thinkingBlock.length,
          );
    const body = this.#composeBody(width, bodyHeight);
    const scrollbarViewportHeight = Math.max(1, bodyHeight - this.#bodyContentOffset);
    this.#scrollbar = this.#viewState.historyOpen
      ? undefined
      : createScrollbarMetrics({
          trackTop: 2 + this.#bodyContentOffset,
          trackHeight: scrollbarViewportHeight,
          trackColumn: width,
          totalLines: this.#layout.totalLines,
          viewportHeight: scrollbarViewportHeight,
          scrollOffset: this.#viewState.scrollOffset,
          maxOffset: maxScrollOffset(this.#layout.totalLines, bodyHeight),
        });
    const bodyView =
      this.#scrollbar === undefined
        ? body
        : composeScrollbar(body, width, this.#scrollbar, 2);

    if (dialogRows > 0) {
      // 0-based 屏幕行号；鼠标命中与 ask_user 点击都用它换算。
      this.#dialogTopRow = 1 + bodyHeight + todoPanel.length;
      this.#dialogHeight = dialogRows;
    } else {
      this.#dialogTopRow = -1;
      this.#dialogHeight = 0;
      this.#dialogButtonHits = [];
      this.#messageButtonHits = [];
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

    if (dialogRows > 0) {
      // 弹窗直接取代输入面板；弹窗打开期间按键都路由给弹窗，输入框本来也不可用。
      const askCursor = this.#askFlow?.cursorPosition();
      const inner = dialogInnerWidth(width);
      if (
        width >= inner + 2 &&
        askCursor !== undefined &&
        askCursor.line < dialogRows
      ) {
        const leftPadding = Math.max(0, Math.floor((width - (inner + 2)) / 2));
        this.#inputCursorRow = this.#dialogTopRow + askCursor.line + 1;
        this.#inputCursorColumn = leftPadding + askCursor.column + 3;
      } else {
        this.#inputCursorRow = undefined;
      }
      return [this.#composeStatus(width), ...bodyView, ...todoPanel, ...dialogBlock];
    }

    const inputTopRow = bodyHeight + todoPanel.length + thinkingBlock.length + 2;
    const inputRows = this.#composeInput(width);
    this.#inputCursorRow =
      height >= INPUT_ROWS + 2 && inputTopRow + INPUT_ROWS - 1 <= height
        ? inputTopRow + this.#inputCursorOffset
        : undefined;

    return [
      this.#composeStatus(width),
      ...bodyView,
      ...todoPanel,
      ...thinkingBlock,
      ...inputRows,
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

  /**
   * 给弹窗整体铺独立底色。
   *
   * 每个 RESET 后面都要重新贴一次背景色，否则按钮/标题内部一旦 RESET，
   * 后面的 padding 就会掉回终端默认底色，出现断裂的色带。
   */
  #paintDialog(lines: readonly string[]): string[] {
    const background = bg(COLOR.dialogBg);
    return lines.map((line) => {
      const painted = line.replaceAll(RESET, `${RESET}${background}`);
      return `${background}${painted}${RESET}`;
    });
  }

  #renderDialog(width: number): string[] {
    this.#dialogButtonHits = [];
    this.#messageButtonHits = [];
    const inner = dialogInnerWidth(width);
    const color = fg(COLOR.dialogBorder);
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

    if (this.#pendingMessageMenu !== undefined) {
      const menu = this.#pendingMessageMenu;
      const lines = [
        `${color}┌${"─".repeat(inner)}┐${RESET}`,
        row(` ${BOLD}${truncateAnsi(menu.title, inner - 2)}${RESET}`),
      ];
      for (const entry of menu.body) lines.push(row(` ${truncateAnsi(entry, inner - 2)}`));
      lines.push(row(""));

      const hovered =
        this.#hoveredButton?.kind === "message" ? this.#hoveredButton.value : undefined;
      const pressed =
        this.#pressedButton?.kind === "message" ? this.#pressedButton.value : undefined;

      for (let offset = 0; offset < menu.actions.length; offset += 3) {
        const actions = composeDialogActions<MessageAction>(
          menu.actions.slice(offset, offset + 3),
          {
            ...(hovered !== undefined ? { hovered } : {}),
            ...(pressed !== undefined ? { pressed } : {}),
          },
        );
        lines.push(row(actions.text));
        const actionLine = lines.length - 1;
        this.#messageButtonHits.push(
          ...actions.hits.map((hit) => ({ line: actionLine, hit })),
        );
      }

      lines.push(row(` ${menu.hint}`));
      lines.push(`${color}└${"─".repeat(inner)}┘${RESET}`);
      return lines;
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

    const hovered =
      this.#hoveredButton?.kind === "dialog" ? this.#hoveredButton.value : undefined;
    const pressed =
      this.#pressedButton?.kind === "dialog" ? this.#pressedButton.value : undefined;
    const actions = composeDialogActions(dialog.actions, {
      ...(hovered !== undefined ? { hovered } : {}),
      ...(pressed !== undefined ? { pressed } : {}),
    });
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
    const goalTag =
      this.#goalStatusLine === undefined
        ? ""
        : ` ${DIM}·${RESET} ${fg(COLOR.tool)}${this.#goalStatusLine}${RESET}`;
    const left = `${BOLD}bugent${RESET} ${DIM}${this.#session.client.id}${RESET} ${badge}${goalTag}`;
    const queued = this.#session.queuedUserCount;
    const queueTag = queued > 0 ? ` ${fg(COLOR.warn)}[已排队 ${queued}]${RESET}` : "";
    const right = this.#busy
      ? `${fg(COLOR.busy)}● 运行中${RESET}${queueTag}`
      : `${fg(COLOR.ok)}○ idle${RESET} ${DIM}turn ${this.#session.turn} · ↑${this.#usage.input} ↓${this.#usage.output}${
          this.#usage.cached !== undefined ? ` ⚡${this.#usage.cached}` : ""
        }${RESET}${queueTag}`;
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
    return truncateAnsi(left + " ".repeat(gap) + right, width);
  }

  /**
   * 输入面板：固定 4 行视窗。
   *
   * 输入内容按终端宽度折行，显式换行也会产生新视觉行；超过 4 行时只滚动
   * 显示光标附近的行。真实光标仍由 Terminal.setCursor 定位。
   */
  #composeInput(width: number): string[] {
    // 末尾留一格：写满整行会让终端自动折行，把布局顶乱
    const fill = Math.max(0, width - 1);
    const background = bg(COLOR.inputBg);
    const available = Math.max(1, width - 4);
    const layout = layoutInput(this.#input, this.#cursor, available);
    const maxStart = Math.max(0, layout.lines.length - INPUT_ROWS);
    const startRow = Math.max(
      0,
      Math.min(layout.cursorRow - INPUT_ROWS + 1, maxStart),
    );
    this.#inputCursorOffset = layout.cursorRow - startRow;
    this.#inputCursorColumn = layout.cursorColumn + 3;

    const rows: string[] = [];
    for (let index = 0; index < INPUT_ROWS; index += 1) {
      const lineIndex = startRow + index;
      const text = layout.lines[lineIndex];
      let raw = "";
      if (text !== undefined) {
        const prefix =
          lineIndex === 0
            ? `${fg(COLOR.inputEdge)}▌${RESET} `
            : "  ";
        raw = `${prefix}${fg(COLOR.inputText)}${text}${RESET}`;
      }

      // 关键：RESET([0m) 会把**背景色一起清掉**，于是 `▌` 之后的
      // 整行都失去底色，看起来就是"输入框和灰蓝色分离"。
      // 在每个 RESET 之后重新贴上背景色即可。
      const content = raw.replaceAll(RESET, `${RESET}${background}`);
      const padding = " ".repeat(Math.max(0, fill - visibleWidth(raw)));

      rows.push(`${background}${content}${padding}${RESET}`);
    }
    return rows;
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
      this.#messageHits = [];
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
    this.#messageHits = viewport.blocks.flatMap((block) => {
      const msgid = displayMsgId(block.item);
      const undoMsgid = displayActionMsgId(block.item);
      return msgid === undefined || undoMsgid === undefined
        ? []
        : [{ msgid, undoMsgid, start: block.start, end: block.contentEnd }];
    });

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
