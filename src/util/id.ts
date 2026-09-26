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

/**
 * provider 返回的 tool_call id 的安全形态。
 *
 * id 会拼进 `~/.bugent/output/<session>/` 下的产物文件名（spill.ts）、写进
 * SQLite 和 JSON 状态 —— 它是**外部输入**（provider / 中间代理返回什么就
 * 是什么），不能原样信：`../` 这类值就是一次绕过沙箱与工作区边界的
 * 任意路径写。
 */
export const TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 把 tool_call id 规整成可安全落盘/入库的值。
 *
 * 合法形态原样保留；不合法的退到 `call_<index>`（与 openai-chat 对缺失 id
 * 的兜底一致）。按位置替换而不是字符替换，避免两个不同 id 规整后相撞。
 * 规整在 loop 的入口做一次，之后 assistant 消息与 tool result 全程使用
 * 同一个值，协议两侧保持一致。
 */
export function safeToolCallId(value: string, index: number): string {
  if (TOOL_CALL_ID_PATTERN.test(value)) return value;
  return `call_${index}`;
}
