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
  tone?: "ok" | "warn" | "error" | "neutral";
  shortcut?: string;
}

export const MESSAGE_ACTIONS: readonly MessageActionItem[] = [
  { action: "undo", label: "撤回到这里", tone: "warn", shortcut: "u" },
  { action: "fork", label: "从这里分叉", tone: "ok", shortcut: "f" },
  { action: "retry", label: "重试此轮", tone: "neutral", shortcut: "r" },
  { action: "copy", label: "复制", tone: "neutral", shortcut: "c" },
  { action: "inspect", label: "检查", tone: "neutral", shortcut: "i" },
  { action: "cancel", label: "取消", tone: "neutral", shortcut: "Esc" },
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

/** 复制成功的用户反馈；按 Unicode code point 计数，避免 CJK/emoji 被按 UTF-16 长度误报。 */
export function copyNotice(text: string): string {
  return `[已复制 ${Array.from(text).length} 字符]`;
}
