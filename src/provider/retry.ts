/**
 * 临时退避重试机制（provider 层公共判定，不含 wire 知识）。
 *
 * schedule：T+5s / T+10s / T+30s / T+60s / T+90s，共 5 次重试，每次都用
 * loop 重建的**最新上下文**重发。命中 `Retry-After` 头时取
 * max(调度值, Retry-After)。
 *
 * 这是临时实现：判定基于错误消息文本（adapter 抛错时把状态码和
 * `retry-after` 头写进 message），后续若转正应把错误结构化。
 */

/** 重试退避表；索引 i 是第 i+1 次重试前的等待毫秒数。测试可临时改写。 */
export const RETRY_DELAYS_MS: number[] = [5_000, 10_000, 30_000, 60_000, 90_000];

/** 429 / 限流 / 上游过载 / 服务端 5xx 一律视为可重试。 */
const RETRYABLE_PATTERN =
  /\b(429|500|502|503|504|529)\b|rate.?limit|too many requests|overloaded|temporarily.?unavailable|retry/i;

export function isRetryableProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_PATTERN.test(message);
}

/**
 * 从错误消息里解析 `retry-after`（秒）；adapter 抛错时应把它拼进 message，
 * 形如 `... (retry-after: 17)`。
 */
export function parseRetryAfterMs(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = /retry-after:\s*(\d+(?:\.\d+)?)\s*s?/i.exec(message);
  if (match === null) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
}

/** 实际等待 = max(调度值, Retry-After)。 */
export function retryDelayMs(error: unknown, scheduledMs: number): number {
  return Math.max(scheduledMs, parseRetryAfterMs(error) ?? 0);
}

/**
 * 可被 AbortSignal 打断的 sleep；被打断时抛出与 fetch 中断一致的
 * AbortError，让上层按"用户中止"收尾。
 */
export function sleepWithSignal(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(abortError(signal));
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
