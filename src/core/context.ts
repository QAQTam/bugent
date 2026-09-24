/**
 * 上下文构建 —— Phase 2 的核心，也是"缓存命中优先"的实现处。
 *
 * 两条保证：
 *   1. **确定性**：同一组消息，永远产出同一个 ChatMessage[]。
 *   2. **前缀稳定**：只往尾部追加时，已冻结前缀的规范序列化结果逐字节不变。
 *      测试 tests/context.test.ts 会盯着这一点。
 */

import type { ChatMessage } from "../provider/types.ts";
import { SYSTEM_MSGID, toChatMessage, type MsgId, type StoredMessage } from "./message.ts";

/**
 * 稳定序列化：对象键排序、跳过 undefined，保证同一语义永远得到同一串字节。
 * 不要换成 JSON.stringify —— 它依赖键的插入顺序。
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",");
  return `{${body}}`;
}

/** 校验并排序：msgid 0 必须存在、必须是 system，且全局无重复 msgid。 */
export function sortForContext(messages: readonly StoredMessage[]): StoredMessage[] {
  const seen = new Set<MsgId>();
  let system: StoredMessage | undefined;
  const rest: StoredMessage[] = [];

  for (const msg of messages) {
    if (seen.has(msg.msgid)) {
      throw new Error(`msgid 重复：${msg.msgid}`);
    }
    seen.add(msg.msgid);

    if (msg.msgid === SYSTEM_MSGID) {
      if (msg.role !== "system") {
        throw new Error(`msgid ${SYSTEM_MSGID} 必须是 system 角色，实际是 ${msg.role}`);
      }
      system = msg;
    } else {
      rest.push(msg);
    }
  }

  if (system === undefined) {
    throw new Error(`上下文缺少 msgid ${SYSTEM_MSGID} 的 system prompt`);
  }

  rest.sort((a, b) => a.msgid - b.msgid);
  return [system, ...rest];
}

export interface BuildContextOptions {
  /** MCP/skills manifest 的协议 role；默认 developer，兼容性回退时用 system。 */
  extensionRole?: "developer" | "system";
}

/** 存储态 -> 归一化协议态（按上下文顺序）。 */
export function buildContext(
  messages: readonly StoredMessage[],
  options: BuildContextOptions = {},
): ChatMessage[] {
  return sortForContext(messages).map((message) => toChatMessage(message, options));
}

/**
 * 取"已冻结前缀"：msgid <= uptoMsgId 的那些消息，按上下文顺序。
 * `uptoMsgId` 省略时取全部（用于对已落盘历史做校验）。
 */
export function stablePrefix(
  messages: readonly StoredMessage[],
  uptoMsgId?: MsgId,
): StoredMessage[] {
  const ordered = sortForContext(messages);
  if (uptoMsgId === undefined) return ordered;
  return ordered.filter((msg) => msg.msgid <= uptoMsgId);
}

/** 前缀指纹：前缀的规范序列化的 sha256。用于断言缓存前缀没被改动。 */
export function prefixHash(
  messages: readonly StoredMessage[],
  uptoMsgId?: MsgId,
  options: BuildContextOptions = {},
): string {
  const payload = canonicalize(buildContext(stablePrefix(messages, uptoMsgId), options));
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(payload);
  return hasher.digest("hex");
}

/** 当前上下文里最大的 msgid（空列表返回 -1）。 */
export function lastMsgId(messages: readonly StoredMessage[]): MsgId {
  let max = -1;
  for (const msg of messages) if (msg.msgid > max) max = msg.msgid;
  return max;
}
