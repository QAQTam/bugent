/**
 * 会话 id 生成。
 *
 * session 是业务隔离和 daemon 路由的边界，必须全局唯一；因此使用标准
 * UUID v4，而不是时间戳 + 随机短后缀。旧短 id 仍可通过 `--resume` 兼容读取。
 */

export const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newSessionId(): string {
  return crypto.randomUUID();
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}
