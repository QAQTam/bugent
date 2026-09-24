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
  | { kind: "tool"; callId: string }
  | { kind: "message"; msgid: MsgId; undoMsgid: MsgId };

export interface HitRegionEntry {
  target: HitTarget;
  rect: HitRect;
  button: ProbeButton;
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
    case "tool":
      return `tool:${target.callId}`;
    case "message":
      return `message:${target.msgid}`;
  }
}
