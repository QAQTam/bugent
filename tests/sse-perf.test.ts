/**
 * SSE 解析性能回归。
 *
 * 门槛故意设得比实测低很多（实测约 88 万 tok/s）——
 * 这个测试的目的是**发现数量级的退化**（比如不小心引入 O(n²) 字符串拼接），
 * 不是卡 CI 的毫秒数。
 */

import { describe, expect, test } from "bun:test";
import { createOpenAIChatClient } from "../src/provider/adapters/openai-chat.ts";

const TARGET_TOKENS_PER_SEC = 300;

function event(delta: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
}

async function consume(events: string[]): Promise<number> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of events) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  });
  const client = createOpenAIChatClient("bench", { baseUrl: `http://127.0.0.1:${server.port}/v1` });

  let count = 0;
  try {
    for await (const chunk of client.chat({
      model: "bench",
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    })) {
      if (chunk.type === "text") count += 1;
    }
  } finally {
    server.stop(true);
  }
  return count;
}

describe("SSE 性能", () => {
  test(
    "突发 2 万条 token 能在 2 秒内解析完（目标 300 tok/s 的 100 倍余量）",
    async () => {
      const tokens = 20_000;
      const events = Array.from({ length: tokens }, (_, i) => event(`t${i} `));

      const started = Bun.nanoseconds();
      const count = await consume(events);
      const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

      expect(count).toBe(tokens);

      const tokensPerSec = tokens / (elapsedMs / 1000);
      // 2 秒 = 1 万 tok/s，是目标 300 tok/s 的 33 倍；实测有 88 万，留足余量
      expect(elapsedMs).toBeLessThan(2000);
      expect(tokensPerSec).toBeGreaterThan(TARGET_TOKENS_PER_SEC * 30);
    },
    30_000,
  );

  test(
    "单条超大 delta 不会拖垮解析",
    async () => {
      const big = `${"x".repeat(200_000)}\n`;
      const started = Bun.nanoseconds();
      const count = await consume(Array.from({ length: 20 }, () => event(big)));
      const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

      expect(count).toBe(20);
      expect(elapsedMs).toBeLessThan(2000);
    },
    30_000,
  );

  test("分片到达的 JSON（跨 chunk 切断）能被正确拼回", async () => {
    const encoder = new TextEncoder();
    const full = event("hello world");
    // 故意在 JSON 中间切断
    const pieces = [full.slice(0, 10), full.slice(10, 25), full.slice(25)];

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      },
    });

    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });
    const client = createOpenAIChatClient("bench", {
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    });

    let text = "";
    try {
      for await (const chunk of client.chat({
        model: "bench",
        messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      })) {
        if (chunk.type === "text") text += chunk.delta;
      }
    } finally {
      server.stop(true);
    }

    expect(text).toBe("hello world");
  });
});
