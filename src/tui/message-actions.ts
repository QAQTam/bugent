/**
 * 消息操作菜单的稳定语义。
 *
 * 渲染仍复用通用 Dialog 组件；这里只定义动作集合，避免 TUI 主类散落
 * 字符串 switch。
 */

export type MessageAction = "undo" | "fork" | "retry" | "copy" | "inspect" | "cancel";

export interface MessageActionItem {
  action: MessageAction;
  label: string;
  tone?: "ok" | "warn" | "error";
}

export const MESSAGE_ACTIONS: readonly MessageActionItem[] = [
  { action: "undo", label: "撤回到这里", tone: "warn" },
  { action: "fork", label: "从这里分叉", tone: "ok" },
  { action: "retry", label: "重试此轮" },
  { action: "copy", label: "复制" },
  { action: "inspect", label: "检查" },
  { action: "cancel", label: "取消", tone: "error" },
];

export function messageActionFromKey(key: string): MessageAction | undefined {
  switch (key.toLowerCase()) {
    case "u":
      return "undo";
    case "f":
      return "fork";
    case "r":
      return "retry";
    case "c":
      return "copy";
    case "i":
      return "inspect";
    case "q":
      return "cancel";
    default:
      return undefined;
  }
}
