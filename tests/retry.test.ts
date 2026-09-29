import { afterEach, describe, expect, test } from "bun:test";
import { AgentSession } from "../src/core/session.ts";
import { runTurn } from "../src/core/loop.ts";
import type { ModelClient } from "../src/provider/types.ts";
import type { ChatChunk, ChatRequest } from "../src/provider/types.ts";
import {
  RETRY_DELAYS_MS,
  isRetryableProviderError,
  parseRetryAfterMs,
  retryDelayMs,
  sleepWithSignal,
} from "../src/provider/retry.ts";

afterEach(() => {
  // 恢复退避表，避免影响其它测试文件
  RETRY_DELAYS_MS.length = 0;
  RETRY_DELAYS_MS.push(5_000, 10_000, 30_000, 60_000, 90_000);
});

function shortDelays(): void {
  RETRY_DELAYS_MS.length = 0;
  RETRY_DELAYS_MS.push(1, 1, 1, 1, 1);
}

describe("provider 退避重试 · 判定", () => {
  test("429 / 5xx / 限流 / 过载可重试", () => {
    expect(isRetryableProviderError(new Error("openai-chat 429 Too Many Requests: ..."))).toBe(true);
    expect(isRetryableProviderError(new Error("anthropic-messages 529: overloaded"))).toBe(true);
    expect(isRetryableProviderError(new Error("openai-chat 503 Service Unavailable"))).toBe(true);
    expect(isRetryableProviderError(new Error("upstream rate limit exceeded"))).toBe(true);
  });

  test("鉴权 / 参数 / 中止错误不可重试", () => {
    expect(isRetryableProviderError(new Error("openai-chat 401 Unauthorized: bad key"))).toBe(false);
    expect(isRetryableProviderError(new Error("anthropic-messages 400: invalid_request_error"))).toBe(false);
    expect(isRetryableProviderError(new Error("The operation was aborted."))).toBe(false);
  });

  test("retry-after 解析与 max(调度值, retry-after)", () => {
    expect(parseRetryAfterMs(new Error("... (retry-after: 17)"))).toBe(17_000);
    expect(parseRetryAfterMs(new Error("... (retry-after: 0.5s)"))).toBe(500);
    expect(parseRetryAfterMs(new Error("no header here"))).toBeUndefined();
    expect(retryDelayMs(new Error("429 (retry-after: 17)"), 5_000)).toBe(17_000);
    expect(retryDelayMs(new Error("429"), 5_000)).toBe(5_000);
  });
});

describe("provider 退避重试 · sleep", () => {
  test("正常等待后 resolve；signal 中止时抛 AbortError", async () => {
    await sleepWithSignal(1, undefined);

    const controller = new AbortController();
    const pending = sleepWithSignal(60_000, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

/** 可编排的假 client：按脚本逐次抛错或吐 chunk。 */
function scriptedClient(script: ((req: ChatRequest) => AsyncIterable<ChatChunk>)[]): ModelClient {
  let call = 0;
  return {
    id: "scripted/test",
    chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      const step = script[Math.min(call, script.length - 1)]!;
      call += 1;
      return step(req);
    },
  };
}

function makeSession(client: ModelClient): AgentSession {
  return new AgentSession({
    id: "retry-test",
    system: "SYS",
    client,
    model: "test-model",
    now: () => 0,
  });
}

function textStream(text: string): AsyncIterable<ChatChunk> {
  return (async function* () {
    yield { type: "text", delta: text };
    yield { type: "done", reason: "stop" };
  })();
}

describe("provider 退避重试 · loop 集成", () => {
  test("可重试错误按退避表重发最新上下文，并回调 onProviderRetry", async () => {
    shortDelays();
    let calls = 0;
    const contexts: string[] = [];
    const client = scriptedClient([
      () => {
        calls += 1;
        throw new Error("anthropic-messages 429 Too Many Requests: slow down");
      },
      () => {
        calls += 1;
        throw new Error("anthropic-messages 529: overloaded");
      },
      (req) => {
        calls += 1;
        contexts.push(JSON.stringify(req.messages));
        return textStream("ok");
      },
    ]);
    const session = makeSession(client);

    const retries: { attempt: number; total: number; delayMs: number; error: string }[] = [];
    const result = await runTurn(session, {
      hooks: {
        onProviderRetry: (info) => retries.push(info),
      },
    });

    expect(result.text).toBe("ok");
    expect(calls).toBe(3);
    expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
    expect(retries.every((r) => r.total === 5)).toBe(true);
    // 每次重试都重建了上下文（buildContext 的产物重新发出去）
    expect(contexts).toHaveLength(1);
  });

  test("重试次数用尽后把错误抛出去", async () => {
    shortDelays();
    let calls = 0;
    const client = scriptedClient([
      () => {
        calls += 1;
        throw new Error("openai-chat 429: still busy");
      },
    ]);
    const session = makeSession(client);

    let retries = 0;
    await expect(
      runTurn(session, {
        hooks: {
          onProviderRetry: () => retries += 1,
        },
      }),
    ).rejects.toThrow(/429/);
    // 1 次初始 + 5 次重试
    expect(calls).toBe(6);
    expect(retries).toBe(5);
  });

  test("不可重试错误不重试；已产出内容后不再重发", async () => {
    shortDelays();
    let calls = 0;
    const client = scriptedClient([
      () => {
        calls += 1;
        throw new Error("openai-chat 401 Unauthorized: bad key");
      },
    ]);
    await expect(runTurn(makeSession(client), {})).rejects.toThrow(/401/);
    expect(calls).toBe(1);

    // 流已吐出文本后才报错：重发会造成重复内容，直接失败
    let midStreamCalls = 0;
    const midStream = scriptedClient([
      async function* () {
        midStreamCalls += 1;
        yield { type: "text", delta: "partial" };
        throw new Error("openai-chat 500: boom mid-stream");
      },
    ]);
    await expect(runTurn(makeSession(midStream), {})).rejects.toThrow(/500/);
    expect(midStreamCalls).toBe(1);
  });
});
