/**
 * 命中目标的词表。
 *
 * 一个目标 = 一块屏幕矩形 + 用哪个键。**判定顺序由列表顺序表达**：鼠标处理和
 * 命中自检都只遍历同一个列表，所以优先级只有一处定义，不会出现"处理器按 A
 * 顺序、自检按 B 顺序"这种分叉。
 */

import type { MsgId } from "../core/message.ts";
import type { HitRect } from "./hit.ts";
import type { MessageAction } from "./message-actions.ts";

/** 用哪个键点。同一个矩形在左右键下可能命中不同目标（工具卡片就是如此）。 */
export type ProbeButton = "left" | "right";

export type HitTarget =
  | { kind: "scrollbar" }
  | { kind: "dialogButton"; value: boolean }
  | { kind: "messageButton"; value: MessageAction }
  /** 弹窗范围内、按钮之外：事件被吞掉，不穿透到下面的消息列表。 */
  | { kind: "dialogBody" }
  | { kind: "askLine"; line: number }
  | { kind: "input"; index: number }
  | { kind: "returnToLatest" }
  | { kind: "moreHistory" }
  /** 待办面板的展开/收起按钮。 */
  | { kind: "todoToggle" }
  | { kind: "tool"; callId: string }
  | { kind: "message"; msgid: MsgId; undoMsgid: MsgId };

export interface HitRegionEntry {
  target: HitTarget;
  rect: HitRect;
  button: ProbeButton;
}

/**
 * 消息区的按键语义：工具卡片与普通消息的矩形本来就重合，谁管哪个键在这里一次定死。
 *
 * - 工具卡片：左键展开 / 收起，右键开消息菜单 —— 同一个矩形两种键各管一件事。
 * - 普通消息：只有右键开菜单。左键落在正文上不登记任何区域，也就是空操作，
 *   免得在聊天区随手一点就弹出撤回 / 分叉的菜单。
 *
 * 抽成纯函数是为了让"哪个键管什么"能被单测钉住，而不是只靠 PTY 里点一下。
 */
export function messageRegions(
  tools: readonly { callId: string; rect: HitRect }[],
  messages: readonly { msgid: MsgId; undoMsgid: MsgId; rect: HitRect }[],
): HitRegionEntry[] {
  const regions: HitRegionEntry[] = [];
  for (const hit of tools) {
    regions.push({
      target: { kind: "tool", callId: hit.callId },
      rect: hit.rect,
      button: "left",
    });
  }
  for (const hit of messages) {
    const target: HitTarget = { kind: "message", msgid: hit.msgid, undoMsgid: hit.undoMsgid };
    regions.push({ target, rect: hit.rect, button: "right" });
  }
  return regions;
}

/** 稳定 id：自检比较与报错定位都用它。 */
export function hitTargetName(target: HitTarget): string {
  switch (target.kind) {
    case "scrollbar":
      return "scrollbar";
    case "dialogButton":
      return `dialog:action:${String(target.value)}`;
    case "messageButton":
      return `dialog:message:${target.value}`;
    case "dialogBody":
      return "dialog:body";
    case "askLine":
      return `ask:line:${target.line}`;
    case "input":
      return `input:${target.index}`;
    case "returnToLatest":
      return "returnToLatest";
    case "moreHistory":
      return "moreHistory";
    case "todoToggle":
      return "todoToggle";
    case "tool":
      return `tool:${target.callId}`;
    case "message":
      return `message:${target.msgid}`;
  }
}
