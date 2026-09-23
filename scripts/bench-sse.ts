/**
 * SSE 解析性能测试。
 *
 * 目标：确认解析能顶住 **300 tok/s**（真实模型的典型上限），
 * 并留出足够余量应对突发。
 *
 * 三个维度：
 *   1. 节流测试 —— 按 300 tok/s 的节奏喂，验证不积压、不漂移
 *   2. 突发测试 —— 不节流猛灌，测原始解析吞吐上限
 *   3. 大 payload —— 单条超长 delta（比如一次吐一大段代码）不会拖慢
 *
 * 用法：bun run scripts/bench-sse.ts
 */

import { createOpenAIChatClient } from "../src/provider/adapters/openai-chat.ts";

const TARGET_TOKENS_PER_SEC = 300;

function event(delta: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
}

function sseBody(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of events) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>, baseUrl: string): Promise<number> {
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
  void baseUrl;
  return count;
}

function report(label: string, tokens: number, ms: number): void {
  const perSec = tokens / (ms / 1000);
  const headroom = perSec / TARGET_TOKENS_PER_SEC;
  const verdict = perSec >= TARGET_TOKENS_PER_SEC ? "✅" : "❌";
  console.log(
    `  ${label.padEnd(28)} ${String(tokens).padStart(7)} tok / ${ms.toFixed(1).padStart(8)} ms` +
      ` = ${Math.round(perSec).toString().padStart(9)} tok/s  余量 ${headroom.toFixed(1)}x ${verdict}`,
  );
}

console.log(`目标：≥ ${TARGET_TOKENS_PER_SEC} tok/s\n`);

/* 1. 原始解析吞吐（突发） */
{
  const tokens = 200_000;
  const events = Array.from({ length: tokens }, (_, i) => event(`t${i} `));
  const started = Bun.nanoseconds();
  const count = await drain(sseBody(events), "");
  report("突发 20 万条", count, (Bun.nanoseconds() - started) / 1e6);
}

/* 2. 节流到 300 tok/s：验证不会积压 */
{
  const durationMs = 3000;
  const tokens = Math.round((TARGET_TOKENS_PER_SEC * durationMs) / 1000);
  const intervalMs = 1000 / TARGET_TOKENS_PER_SEC;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (let i = 0; i < tokens; i += 1) {
        controller.enqueue(encoder.encode(event(`t${i} `)));
        await Bun.sleep(intervalMs);
      }
      controller.close();
    },
  });

  const started = Bun.nanoseconds();
  const count = await drain(stream, "");
  const elapsed = (Bun.nanoseconds() - started) / 1e6;
  report(`节流 ${TARGET_TOKENS_PER_SEC} tok/s`, count, elapsed);
  console.log(
    `  ${"  └ 节奏偏差".padEnd(26)} 期望 ${durationMs} ms，实际 ${elapsed.toFixed(0)} ms（含解析开销）`,
  );
}

/* 3. 单条超长 delta（一次性吐一大段代码） */
{
  const tokens = 200;
  const bigChunk = `${"x".repeat(50_000)}\n`;
  const events = Array.from({ length: tokens }, () => event(bigChunk));
  const started = Bun.nanoseconds();
  const count = await drain(sseBody(events), "");
  const elapsed = (Bun.nanoseconds() - started) / 1e6;
  const totalMb = (tokens * bigChunk.length) / 1024 / 1024;
  console.log(
    `  ${"超大 delta（共 " + totalMb.toFixed(1) + " MB）".padEnd(26)} ${String(count).padStart(7)} 条 / ${elapsed.toFixed(1).padStart(8)} ms = ${(totalMb / (elapsed / 1000)).toFixed(0)} MB/s`,
  );
}
