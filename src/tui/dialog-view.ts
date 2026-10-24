/**
 * 弹窗视图 —— 覆盖层（授权弹窗 / 消息菜单 / ask_user 表单 / 设置面板）的
 * 内容渲染，纯函数：输入"当前有哪些覆盖层状态 + 悬停/按下目标"，输出
 * 行与按钮的**弹窗局部坐标**。
 *
 * 局部坐标 -> 屏幕坐标的换算留在宿主的 compose 里做：那时才知道弹窗画在
 * 屏幕的哪一行、水平居中留白是多少（行数依赖渲染结果，算位置又依赖行数）。
 */

import { BOLD, RESET, bg, fg } from "./markdown/markdown.ts";
import { COLOR } from "./core/theme.ts";
import { padAnsi, truncateAnsi } from "./core/ansi.ts";
import {
  composeDialogActions,
  dialogInnerWidth,
  type DialogAction,
} from "./widgets/dialog.ts";
import type { SettingsPanel } from "./widgets/settings-panel.ts";
import type { AskUserFlow } from "./widgets/ask-user.ts";
import type { ButtonShape } from "./widgets/button.ts";
import type { ButtonTarget } from "./hit-regions.ts";
import type { HitTarget } from "./hit-target.ts";
import type { MessageAction } from "./widgets/message-actions.ts";
import type { MsgId } from "../core/message.ts";
import { formatCountdown } from "../permission/authorization.ts";

/** 弹窗渲染结果：行 + 按钮（弹窗局部坐标）。 */
export interface RenderedDialog {
  lines: string[];
  buttons: {
    target: HitTarget;
    /** 按钮首行（弹窗局部 0-based 行号）。 */
    line: number;
    /** 按钮占几行：框形态 3 行，紧凑形态 1 行。 */
    lineSpan: number;
    left: number;
    right: number;
    /** 左上角字形，自检锚点用它比对画面。 */
    glyph: string;
  }[];
  /** 设置面板的可点行（弹窗局部 0-based 行号 -> 行下标）。 */
  settingsRows?: { line: number; index: number }[];
}

/**
 * 通用对话框。
 *
 * 权限确认、能力授权都用它；将来 `ask_user` 也接这里 ——
 * 区别只是 body 的行数与是否需要文本输入。
 */
export interface PendingDialog {
  title: string;
  body: string[];
  /** 按键提示。 */
  hint: string;
  /** 可鼠标点击的按钮。键盘路径仍然保留。 */
  actions: readonly DialogAction[];
  /**
   * 授权窗口剩余毫秒。有值时标题右侧画倒计时（`需要授权 · 访问网络 · 还剩 47s`）。
   *
   * 存成取值函数而不是数字：窗口每秒回调一次，渲染时现取，免得再同步一份状态。
   */
  countdown?: () => number;
  resolve: (value: boolean) => void;
}

/** 点击消息后弹出的操作菜单；动作不是布尔值，所以与授权弹窗分开存。 */
export interface PendingMessageMenu {
  /** 用于复制 / 检查 / 分叉 / 重试的实际消息。 */
  msgid: MsgId;
  /** 用于撤回的分支锚点；工具卡片通常指向 assistant tool-call。 */
  undoMsgid: MsgId;
  title: string;
  body: string[];
  hint: string;
  actions: readonly DialogAction<MessageAction>[];
}

/** 渲染时的覆盖层状态快照。 */
export interface DialogViewState {
  settingsPanel: SettingsPanel | undefined;
  askFlow: AskUserFlow | undefined;
  messageMenu: PendingMessageMenu | undefined;
  dialog: PendingDialog | undefined;
  hover: ButtonTarget | undefined;
  pressed: ButtonTarget | undefined;
}

export interface DialogViewOutput {
  rendered: RenderedDialog;
  /** 设置面板编辑态的硬件光标（面板局部坐标）；非面板覆盖层为 undefined。 */
  settingsCursor: { line: number; column: number } | undefined;
}

/**
 * 给弹窗整体铺独立底色。
 *
 * 每个 RESET 后面都要重新贴一次背景色，否则按钮/标题内部一旦 RESET，
 * 后面的 padding 就会掉回终端默认底色，出现断裂的色带。
 */
export function paintDialog(lines: readonly string[]): string[] {
  const background = bg(COLOR.dialogBg);
  return lines.map((line) => {
    const painted = line.replaceAll(RESET, `${RESET}${background}`);
    return `${background}${painted}${RESET}`;
  });
}

/**
 * 渲染当前覆盖层。
 *
 * 按钮默认画成框（3 行）；`maxRows` 放不下时整体退化成紧凑形态（1 行）再画
 * 一次 —— 小终端上宁可按钮矮一点，也不能把动作截掉一半。
 * 设置面板自己按预算算行数与滚动窗口，不需要 compact 退化。
 */
export function renderDialogView(
  width: number,
  maxRows: number,
  state: DialogViewState,
): DialogViewOutput {
  const boxed = composeDialogContent(width, "box", maxRows, state);
  if (state.settingsPanel !== undefined) return boxed;
  if (boxed.rendered.lines.length <= maxRows) return boxed;
  return composeDialogContent(width, "compact", maxRows, state);
}

function composeDialogContent(
  width: number,
  shape: ButtonShape,
  maxRows: number,
  state: DialogViewState,
): DialogViewOutput {
  const buttons: RenderedDialog["buttons"] = [];
  const inner = dialogInnerWidth(width);
  const color = fg(COLOR.dialogBorder);
  const bar = `${color}│${RESET}`;
  const row = (text: string): string =>
    `${bar}${padAnsi(truncateAnsi(text, inner), inner)}${bar}`;

  // 设置面板：内容与滚动窗口都由面板自己按 maxRows 算好，这里只加边框。
  // 行号换算要 +1 —— 面板返回的是它自己的局部行，上面还有一行上边框。
  const panel = state.settingsPanel;
  if (panel !== undefined) {
    const rendered = panel.render(inner, maxRows);
    const settingsRows: NonNullable<RenderedDialog["settingsRows"]> = [];
    for (const [line, index] of rendered.rowLines) settingsRows.push({ line: line + 1, index });
    return {
      rendered: {
        lines: [
          `${color}┌${"─".repeat(inner)}┐${RESET}`,
          ...rendered.lines.map((line) => row(line)),
          `${color}└${"─".repeat(inner)}┘${RESET}`,
        ],
        buttons,
        settingsRows,
      },
      settingsCursor: rendered.cursor,
    };
  }

  // 非设置面板的覆盖层：面板光标必须清空，否则硬件光标会漂。
  // ask_user：分页表单，内容由 AskUserFlow 自己渲染。
  if (state.askFlow !== undefined) {
    return {
      rendered: {
        lines: [
          `${color}┌${"─".repeat(inner)}┐${RESET}`,
          ...state.askFlow.render(inner).map((line) => row(` ${line}`)),
          `${color}└${"─".repeat(inner)}┘${RESET}`,
        ],
        buttons,
      },
      settingsCursor: undefined,
    };
  }

  const menu = state.messageMenu;
  if (menu !== undefined) {
    const lines = [
      `${color}┌${"─".repeat(inner)}┐${RESET}`,
      row(` ${BOLD}${truncateAnsi(menu.title, inner - 2)}${RESET}`),
    ];
    for (const entry of menu.body) lines.push(row(` ${truncateAnsi(entry, inner - 2)}`));
    lines.push(row(""));

    const hovered =
      state.hover?.kind === "message" ? state.hover.value : undefined;
    const pressed =
      state.pressed?.kind === "message" ? state.pressed.value : undefined;

    for (let offset = 0; offset < menu.actions.length; offset += 3) {
      // 框形态下两组之间空一行，否则两排方框会贴成一堵墙
      if (offset > 0 && shape === "box") lines.push(row(""));
      const actions = composeDialogActions<MessageAction>(
        menu.actions.slice(offset, offset + 3),
        {
          ...(hovered !== undefined ? { hovered } : {}),
          ...(pressed !== undefined ? { pressed } : {}),
        },
        { shape },
      );
      for (const line of actions.lines) lines.push(row(line));
      const first = lines.length - actions.lines.length;
      for (const hit of actions.hits) {
        buttons.push({
          target: { kind: "messageButton", value: hit.value },
          line: first + hit.row,
          lineSpan: hit.rowSpan,
          left: hit.start,
          right: hit.end,
          glyph: hit.glyph,
        });
      }
    }

    lines.push(row(` ${menu.hint}`));
    lines.push(`${color}└${"─".repeat(inner)}┘${RESET}`);
    return { rendered: { lines, buttons }, settingsCursor: undefined };
  }

  const dialog = state.dialog;
  if (dialog === undefined) return { rendered: { lines: [], buttons }, settingsCursor: undefined };

  // 授权弹窗把倒计时接在标题后面 —— 用户要能一眼看到"还有多久算拒绝"。
  const remaining = dialog.countdown?.();
  const title =
    remaining === undefined ? dialog.title : `${dialog.title} · ${formatCountdown(remaining)}`;

  const lines = [
    `${color}┌${"─".repeat(inner)}┐${RESET}`,
    row(` ${BOLD}${truncateAnsi(title, inner - 2)}${RESET}`),
  ];
  for (const entry of dialog.body) {
    lines.push(row(` ${truncateAnsi(entry, inner - 2)}`));
  }
  lines.push(row(""));

  const hovered =
    state.hover?.kind === "dialog" ? state.hover.value : undefined;
  const pressed =
    state.pressed?.kind === "dialog" ? state.pressed.value : undefined;
  const actions = composeDialogActions(
    dialog.actions,
    {
      ...(hovered !== undefined ? { hovered } : {}),
      ...(pressed !== undefined ? { pressed } : {}),
    },
    { shape },
  );
  for (const line of actions.lines) lines.push(row(line));
  const first = lines.length - actions.lines.length;
  for (const hit of actions.hits) {
    buttons.push({
      target: { kind: "dialogButton", value: hit.value },
      line: first + hit.row,
      lineSpan: hit.rowSpan,
      left: hit.start,
      right: hit.end,
      glyph: hit.glyph,
    });
  }

  lines.push(row(` ${dialog.hint}`));
  lines.push(`${color}└${"─".repeat(inner)}┘${RESET}`);
  return { rendered: { lines, buttons }, settingsCursor: undefined };
}
