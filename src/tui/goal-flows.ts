/**
 * Goal 流程编排 —— `/goal` 命令族、Checkpoint 后的 Context 刷新、
 * 自动 continuation 与状态栏行的维护。
 *
 * 从 TuiApp 抽出来的原因：这些流程认识 Goal 领域（controller 生命周期、
 * continuation 上限、Context Epoch 切换），但不认识渲染 —— 它们对界面的
 * 全部需求就是"说一句话 / 弹一个框 / 跑一轮 / 切 runtime"。宿主通过
 * GoalFlowHost 注入这些能力，本模块不 import 任何渲染组件。
 */

import {
  GOAL_INITIALIZATION_INSTRUCTION,
  type GoalController,
} from "../goal/controller.ts";
import type { AgentSession } from "../core/session.ts";
import type { PendingDialog } from "./dialog-view.ts";
import { DIM, RESET } from "./markdown/markdown.ts";

/** 宿主（TuiApp）必须提供的能力；全部是 Goal 流程用到的界面动作。 */
export interface GoalFlowHost {
  readonly session: AgentSession;
  pushError(message: string): void;
  pushNotice(message: string): void;
  requestFrame(force?: boolean): void;
  openDialog(dialog: Omit<PendingDialog, "resolve">): Promise<boolean>;
  promptText(question: string): Promise<string | undefined>;
  runTurn(
    input: string | undefined,
    options?: { appendUser?: boolean; fingerprintBefore?: string; turnId?: string },
  ): Promise<void>;
  switchRuntime(branchId: string, notice?: string): boolean;
  /** 进入/退出独占工作态（busy + spinner + 重绘）。 */
  beginWork(): void;
  endWork(): void;
  readonly busy: boolean;
}

export interface GoalFlowsOptions {
  controller?: GoalController;
  autoContinue?: boolean;
  maxContinuationTurns?: number;
}

export class GoalFlows {
  readonly #host: GoalFlowHost;
  #controller: GoalController | undefined;
  #autoContinue: boolean;
  #maxContinuationTurns: number;
  #continuationStreak = 0;
  #statusLine: string | undefined;

  constructor(host: GoalFlowHost, options: GoalFlowsOptions = {}) {
    this.#host = host;
    this.#controller = options.controller;
    this.#autoContinue = options.autoContinue ?? false;
    this.#maxContinuationTurns = options.maxContinuationTurns ?? 50;
    this.refreshStatus();
  }

  get controller(): GoalController | undefined {
    return this.#controller;
  }

  /** 状态栏那一行（composeStatus 每帧读）。 */
  get statusLine(): string | undefined {
    return this.#statusLine;
  }

  get autoContinue(): boolean {
    return this.#autoContinue;
  }

  /** runtime 切换后接管新的 controller；会话变了 continuation 计数清零。 */
  adoptController(controller: GoalController | undefined, sessionChanged: boolean): void {
    this.#controller = controller;
    if (sessionChanged) this.#continuationStreak = 0;
    this.refreshStatus();
  }

  refreshStatus(): void {
    this.#statusLine = this.#controller?.statusLine();
  }

  resetContinuationStreak(): void {
    this.#continuationStreak = 0;
  }

  /**
   * `/goal` 是 Goal 的唯一显式入口。
   *
   * 有参数时只授予一次创建权并启动初始化 turn；真正创建仍由模型调用
   * `create_goal` 完成，但普通 turn 永远拿不到该权限。
   */
  async handleCommand(argument: string): Promise<void> {
    const controller = this.#controller;
    const host = this.#host;
    if (controller === undefined) {
      host.pushError("当前 session 未启用持久化，无法使用 Goal 模式");
      host.requestFrame(true);
      return;
    }

    const goal = controller.currentGoal();
    if (argument === "pause") {
      if (goal === undefined) {
        host.pushError("当前 session 没有 Goal");
      } else {
        try {
          controller.pause("用户通过 /goal pause 暂停");
          this.refreshStatus();
          host.pushNotice("Goal 已暂停。输入 `/goal resume` 恢复。");
        } catch (error) {
          host.pushError(error instanceof Error ? error.message : String(error));
        }
      }
      host.requestFrame(true);
      return;
    }
    if (argument === "resume") {
      if (goal === undefined) {
        host.pushError("当前 session 没有 Goal");
      } else {
        try {
          controller.resume();
          this.refreshStatus();
          host.pushNotice("Goal 已恢复。");
        } catch (error) {
          host.pushError(error instanceof Error ? error.message : String(error));
        }
      }
      host.requestFrame(true);
      return;
    }
    if (argument === "continue") {
      if (goal === undefined) {
        host.pushError("当前 session 没有 Goal");
        host.requestFrame(true);
        return;
      }
      if (host.busy || host.session.hasOpenToolBatch()) {
        host.pushError("当前一轮还在跑，先结束或中断再刷新 Context Epoch");
        host.requestFrame(true);
        return;
      }
      try {
        const epoch = await controller.createContextEpoch("manual");
        if (host.switchRuntime(epoch.branchId, `已创建 Context Epoch ${epoch.epochId}`)) {
          this.refreshStatus();
          host.requestFrame(true);
        }
      } catch (error) {
        host.pushError(error instanceof Error ? error.message : String(error));
        host.requestFrame(true);
      }
      return;
    }
    if (argument === "checkpoints") {
      if (goal === undefined) {
        host.pushError("当前 session 没有 Goal");
        host.requestFrame(true);
        return;
      }
      const checkpoints = controller.repository.listCheckpoints(goal.id);
      await host.openDialog({
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
        host.pushError("当前 session 没有 Goal");
        host.requestFrame(true);
        return;
      }
      if (host.busy || host.session.hasOpenToolBatch()) {
        host.pushError("当前一轮还在跑，先结束或中断再执行 final audit");
        host.requestFrame(true);
        return;
      }
      host.beginWork();
      try {
        const result = await controller.finalAudit();
        host.pushNotice(
          result.approved
            ? "Goal final audit 通过，Goal 已完成。"
            : `Goal final audit 未通过：${result.errors.join("；")}`,
        );
      } catch (error) {
        host.pushError(error instanceof Error ? error.message : String(error));
      } finally {
        host.endWork();
        this.#continuationStreak = 0;
        this.refreshStatus();
        host.requestFrame(true);
      }
      return;
    }
    if (argument === "edit") {
      if (goal === undefined) {
        host.pushError("当前 session 没有 Goal");
        host.requestFrame(true);
        return;
      }
      const objective = await host.promptText(`Goal objective（当前：${goal.objective}）`);
      if (objective === undefined) return;
      const criteriaText = await host.promptText("成功标准（用 ; 分隔）");
      if (criteriaText === undefined) return;
      const constraintsText = await host.promptText("约束（用 ; 分隔，可留空）");
      const nonGoalsText = await host.promptText("非目标（用 ; 分隔，可留空）");
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
        this.refreshStatus();
        host.pushNotice("Goal Contract 已更新。");
      } catch (error) {
        host.pushError(error instanceof Error ? error.message : String(error));
      }
      host.requestFrame(true);
      return;
    }
    if (argument === "clear") {
      if (goal === undefined) {
        host.pushError("当前 session 没有 Goal");
        host.requestFrame(true);
        return;
      }
      const confirmed = await host.openDialog({
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
          this.#continuationStreak = 0;
          this.refreshStatus();
          host.pushNotice(`Goal 已清除：${cleared}`);
        } catch (error) {
          host.pushError(error instanceof Error ? error.message : String(error));
        }
        host.requestFrame(true);
      }
      return;
    }
    if (argument === "status" || (goal !== undefined && argument.length === 0)) {
      if (goal === undefined) {
        host.pushError("当前 session 没有 Goal。使用 `/goal <目标>` 初始化。");
        host.requestFrame(true);
        return;
      }
      await this.#showStatus(controller);
      return;
    }
    if (goal !== undefined) {
      host.pushError(
        "当前 session 已有 Goal。可用子命令：`/goal status`、`/goal checkpoints`、`/goal continue`、`/goal finalize`、`/goal pause`、`/goal resume`、`/goal edit`、`/goal clear`。",
      );
      host.requestFrame(true);
      return;
    }

    const rawIntent = argument.length > 0 ? argument : await host.promptText("输入 Goal 原始意图");
    if (rawIntent === undefined) return;
    await this.initialize(rawIntent);
  }

  async initialize(rawIntent: string): Promise<void> {
    const controller = this.#controller;
    const host = this.#host;
    if (controller === undefined) return;
    if (host.busy || host.session.hasOpenToolBatch()) {
      host.pushError("当前一轮还在跑，先按 ESC 中断再初始化 Goal");
      host.requestFrame(true);
      return;
    }
    if (host.session.queuedUserCount > 0) {
      host.pushError("当前 session 还有排队消息，先处理完再初始化 Goal");
      host.requestFrame(true);
      return;
    }

    controller.authorizeCreate();
    host.session.enqueueInjection(GOAL_INITIALIZATION_INSTRUCTION, "goal");
    host.pushNotice("Goal 初始化已开始：模型会先澄清契约，不会立即改代码。");
    this.refreshStatus();
    host.requestFrame(true);
    await host.runTurn(rawIntent);
  }

  async #showStatus(controller: GoalController): Promise<void> {
    const host = this.#host;
    const goal = controller.currentGoal();
    if (goal === undefined) return;
    const canResume =
      goal.status === "paused" ||
      goal.status === "blocked" ||
      goal.status === "usage_limited";
    const action = await host.openDialog({
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
        host.pushNotice("Goal 已暂停。");
      } else if (canResume) {
        controller.resume();
        host.pushNotice("Goal 已恢复。");
      }
      this.refreshStatus();
    } catch (error) {
      host.pushError(error instanceof Error ? error.message : String(error));
    }
    host.requestFrame(true);
  }

  /** Checkpoint 达成后刷新 Context Epoch（切分支），再视情况自动继续。 */
  async refreshContext(): Promise<void> {
    const controller = this.#controller;
    const host = this.#host;
    if (controller === undefined || host.busy || host.session.queuedUserCount > 0) return;
    host.beginWork();
    try {
      const epoch = await controller.createContextEpoch("checkpoint");
      if (host.switchRuntime(epoch.branchId, `Checkpoint 后已切换 Context Epoch ${epoch.epochId}`)) {
        this.refreshStatus();
        host.requestFrame(true);
      }
    } catch (error) {
      host.pushError(
        `Context Epoch 创建失败：${error instanceof Error ? error.message : String(error)}`,
      );
      host.requestFrame(true);
    } finally {
      host.endWork();
      this.refreshStatus();
      host.requestFrame(true);
      if (!host.busy && host.session.queuedUserCount === 0) this.maybeContinue();
    }
  }

  /** 自动 continuation：Goal 允许且未达上限时，不等用户输入直接跑下一轮。 */
  maybeContinue(): void {
    const host = this.#host;
    if (!this.#autoContinue || host.busy || host.session.hasOpenToolBatch()) return;
    if (host.session.queuedUserCount > 0) return;
    if (this.#continuationStreak >= this.#maxContinuationTurns) {
      host.pushNotice(
        `Goal 已达到连续自动推进上限 ${this.#maxContinuationTurns}，等待用户输入。`,
      );
      host.requestFrame();
      return;
    }
    const controller = this.#controller;
    if (controller === undefined) return;
    const check = controller.canAutoContinue();
    if (!check.allowed) {
      this.refreshStatus();
      return;
    }

    try {
      const start = controller.beginContinuation();
      this.#continuationStreak += 1;
      void host.runTurn(undefined, {
        appendUser: false,
        fingerprintBefore: start.fingerprint,
        turnId: start.turnId,
      });
    } catch (error) {
      host.pushError(error instanceof Error ? error.message : String(error));
      host.requestFrame();
    }
  }
}
