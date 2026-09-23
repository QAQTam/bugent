/**
 * 会话 id 生成。
 *
 * 用「时间戳(36 进制) + 随机后缀」而不是 UUID：
 * 短、可排序、肉眼能看出创建时间，方便在 `--resume` 里手打。
 */

export function newSessionId(now = Date.now()): string {
  const time = now.toString(36);
  const random = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `${time}-${random}`;
}
