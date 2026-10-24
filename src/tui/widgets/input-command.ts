/**
 * 输入框的 slash command 判定。
 *
 * 不能简单地用 `startsWith("/")`：绝对路径同样以 `/` 开头。命令只允许
 * 第一段是单个命令名，例如 `/model`、`/goal status`；`/home/user`、
 * `/usr/bin/env` 这类含路径分隔的输入必须继续作为普通消息发送。
 */

const COMMAND_NAME = /^\/[A-Za-z][A-Za-z0-9_-]*$/;

export function looksLikeSlashCommand(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return false;
  if (trimmed === "/") return true;

  const whitespace = trimmed.search(/\s/);
  const token = whitespace < 0 ? trimmed : trimmed.slice(0, whitespace);
  return COMMAND_NAME.test(token);
}
