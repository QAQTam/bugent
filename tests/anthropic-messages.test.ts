import { describe, expect, test } from "bun:test";
import {
  createAnthropicMessagesClient,
  mapStopReason,
  mapStreamEvent,
  toWireRequest,
} from "../src/provider/adapters/anthropic-messages.ts";
import type { ChatChunk, ChatMessage } from "../src/provider/types.ts";

const TOOL_SCHEMA = {
  name: "bash",
  description: "跑命令",
  parameters: { type: "object" as const, properties: { cmd: { type: "string" as const } }, required: ["cmd"] },
};

describe("anthropic-messages · 归一化 -> wire", () => {
  test("system 进顶层参数，user/assistant 照常映射", () => {
    const messages: ChatMessage[] = [
      { role: "system", parts: [{ type: "text", text: "SYS" }] },
      { role: "user", parts: [{ type: "text", text: "你好" }] },
      { role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ];
    const wire = toWireRequest(messages, undefined);
    expect(wire.system).toEqual([{ type: "text", text: "SYS" }]);
    expect(wire.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "你好" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  test("developer role 按 system 处理", () => {
    const wire = toWireRequest([{ role: "developer", parts: [{ type: "text", text: "DEV" }] }], undefined);
    expect(wire.system).toEqual([{ type: "text", text: "DEV" }]);
  });

  test("tool 结果变成 user 消息里的 tool_result block", () => {
    const wire = toWireRequest(
      [
        { role: "user", parts: [{ type: "text", text: "列目录" }] },
        {
          role: "assistant",
          parts: [],
          toolCalls: [{ id: "t1", name: "bash", args: { cmd: "ls" } }],
        },
        { role: "tool", parts: [{ type: "text", text: "a.txt" }], toolCallId: "t1" },
      ],
      undefined,
    );
    expect(wire.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } }],
    });
    expect(wire.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }],
    });
  });

  test("连续的 tool 消息合并进同一条 user 消息（API 要求严格交替）", () => {
    const wire = toWireRequest(
      [
        { role: "tool", parts: [{ type: "text", text: "a" }], toolCallId: "t1" },
        { role: "tool", parts: [{ type: "text", text: "b" }], toolCallId: "t2" },
      ],
      undefined,
    );
    expect(wire.messages).toHaveLength(1);
    expect(wire.messages[0]?.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "a" },
      { type: "tool_result", tool_use_id: "t2", content: "b" },
    ]);
  });

  test("空文本块被丢弃，图片走 base64 source", () => {
    const wire = toWireRequest(
      [
        {
          role: "user",
          parts: [
            { type: "text", text: "" },
            { type: "image", mime: "image/png", data: "AAAA" },
          ],
        },
      ],
      undefined,
    );
    expect(wire.messages[0]?.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });

  test("工具 schema 发成 name/description/input_schema", () => {
    const wire = toWireRequest([{ role: "user", parts: [{ type: "text", text: "hi" }] }], [TOOL_SCHEMA]);
    expect(wire.tools).toEqual([
      {
        name: "bash",
        description: "跑命令",
        input_schema: TOOL_SCHEMA.parameters,
      },
    ]);
  });

  test("reasoning 默认不回放；显式开启时以 thinking block 回放", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", parts: [{ type: "text", text: "answer" }], reasoning: "hmm" },
    ];
    expect(toWireRequest(messages, undefined).messages[0]?.content).toEqual([
      { type: "text", text: "answer" },
    ]);

    const replayed = toWireRequest(messages, undefined, "reasoning");
    expect(replayed.messages[0]?.content[0]).toEqual({ type: "thinking", thinking: "hmm" });
    expect(replayed.messages[0]?.content[1]).toEqual({ type: "text", text: "answer" });
  });
});

describe("anthropic-messages · SSE 归一化", () => {
  test("message_start 带输入侧 usage 与缓存命中", () => {
    const mapped = mapStreamEvent(
      {
        type: "message_start",
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 80 } },
      },
      new Map(),
    );
    expect(mapped.chunks).toEqual<ChatChunk[]>([
      { type: "usage", usage: { input: 100, output: 0, cached: 80 } },
    ]);
  });

  test("text_delta 与 thinking_delta 分别映射成 text / reasoning", () => {
    const text = mapStreamEvent(
      { type: "content_block_delta", delta: { type: "text_delta", text: "你" } },
      new Map(),
    );
    expect(text.chunks).toEqual([{ type: "text", delta: "你" }]);

    const thinking = mapStreamEvent(
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "想" } },
      new Map(),
    );
    expect(thinking.chunks).toEqual([{ type: "reasoning", delta: "想" }]);
  });

  test("tool_use block 登记后 input_json_delta 补上 id，args 分片拼接", () => {
    const byIndex = new Map<number, { id: string; name: string }>();

    const start = mapStreamEvent(
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "bash" } },
      byIndex,
    );
    expect(start.chunks).toEqual([{ type: "tool_call", id: "tu_1", name: "bash", argsDelta: "" }]);

    const delta1 = mapStreamEvent(
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"cmd"' } },
      byIndex,
    );
    const delta2 = mapStreamEvent(
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ':"ls"}' } },
      byIndex,
    );
    expect(delta1.chunks).toEqual([{ type: "tool_call", id: "tu_1", name: "", argsDelta: '{"cmd"' }]);
    expect(delta2.chunks).toEqual([{ type: "tool_call", id: "tu_1", name: "", argsDelta: ':"ls"}' }]);
  });

  test("message_delta 带输出侧 usage 与 stop_reason", () => {
    const mapped = mapStreamEvent(
      { type: "message_delta", delta: { type: "message_delta", stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
      new Map(),
    );
    expect(mapped.finish).toBe("tool_calls");
    expect(mapped.chunks).toEqual<ChatChunk[]>([{ type: "usage", usage: { input: 0, output: 42 } }]);
  });

  test("stop_reason 映射：max_tokens -> length，其余 -> stop", () => {
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("tool_use")).toBe("tool_calls");
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("pause_turn")).toBe("stop");
    expect(mapStopReason(undefined)).toBe("stop");
  });

  test("流内 error 事件抛错；ping / stop 事件静默", () => {
    expect(() => mapStreamEvent({ type: "error", delta: { type: "overloaded_error" } }, new Map())).toThrow(
      /stream error/,
    );
    expect(mapStreamEvent({ type: "ping" }, new Map()).chunks).toEqual([]);
    expect(mapStreamEvent({ type: "content_block_stop" }, new Map()).chunks).toEqual([]);
  });
});

describe("anthropic-messages · 端到端（本地 Bun.serve 回放）", () => {
  test("请求形状正确，SSE 流被归一化成完整 chunk 序列", async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":4}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
      'data: {"type":"message_stop"}',
      "",
      "",
    ].join("\n\n");

    let seenBody: Record<string, unknown> | undefined;
    let seenHeaders: Record<string, string> | undefined;

    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seenBody = (await req.json()) as Record<string, unknown>;
        seenHeaders = Object.fromEntries(req.headers.entries());
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      },
    });

    try {
      const client = createAnthropicMessagesClient("claude-fake", {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-test",
      });

      const chunks: ChatChunk[] = [];
      for await (const chunk of client.chat({
        model: "claude-fake",
        messages: [
          { role: "system", parts: [{ type: "text", text: "SYS" }] },
          { role: "user", parts: [{ type: "text", text: "你好" }] },
        ],
        tools: [TOOL_SCHEMA],
      })) {
        chunks.push(chunk);
      }

      // 请求形状：system 顶层、max_tokens 兜底、tools、鉴权头、路径 /v1/messages
      expect(server.port).toBeGreaterThan(0);
      expect(seenBody?.system).toEqual([{ type: "text", text: "SYS" }]);
      expect(seenBody?.max_tokens).toBe(8192);
      expect(seenBody?.model).toBe("claude-fake");
      expect(seenHeaders?.["x-api-key"]).toBe("sk-test");
      expect(seenHeaders?.["anthropic-version"]).toBe("2023-06-01");

      // 流归一化
      expect(chunks).toEqual<ChatChunk[]>([
        { type: "usage", usage: { input: 12, output: 0, cached: 4 } },
        { type: "text", delta: "你" },
        { type: "text", delta: "好" },
        { type: "usage", usage: { input: 0, output: 7 } },
        { type: "done", reason: "stop" },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("HTTP 错误被抛成带 endpoint 前缀的 Error", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error" } }), { status: 400 }),
    });
    try {
      const client = createAnthropicMessagesClient("claude-fake", {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      });
      let message = "";
      try {
        for await (const _chunk of client.chat({
          model: "claude-fake",
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        })) {
          void _chunk;
        }
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("anthropic-messages 400");
    } finally {
      server.stop(true);
    }
  });
});
