import { describe, expect, test } from "bun:test";
import {
  createOpenAIResponsesClient,
  mapStreamEvent,
  toWireRequest,
  type ToolIdentity,
} from "../src/provider/adapters/openai-responses.ts";
import type { ChatChunk, ChatMessage } from "../src/provider/types.ts";

const TOOL_SCHEMA = {
  name: "bash",
  description: "跑命令",
  parameters: { type: "object" as const, properties: { cmd: { type: "string" as const } }, required: ["cmd"] },
};

const FREEFORM_SCHEMA = {
  name: "draft",
  description: "自由文本工具",
  parameters: { type: "object" as const, properties: {} },
  format: "freeform" as const,
};

function identity(): ToolIdentity {
  return new Map();
}

describe("openai-responses · 归一化 -> wire", () => {
  test("system/developer 进顶层 instructions，user/assistant 映射成 message items", () => {
    const messages: ChatMessage[] = [
      { role: "system", parts: [{ type: "text", text: "SYS" }] },
      { role: "developer", parts: [{ type: "text", text: "DEV" }] },
      { role: "user", parts: [{ type: "text", text: "你好" }] },
      { role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ];
    const wire = toWireRequest(messages, undefined);
    expect(wire.instructions).toBe("SYS\n\nDEV");
    expect(wire.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ]);
  });

  test("assistant toolCalls 变 function_call items，tool 结果变 function_call_output（平铺、不合并）", () => {
    const wire = toWireRequest(
      [
        { role: "user", parts: [{ type: "text", text: "列目录" }] },
        {
          role: "assistant",
          parts: [],
          toolCalls: [
            { id: "t1", name: "bash", args: { cmd: "ls" } },
            { id: "t2", name: "bash", args: { cmd: "pwd" } },
          ],
        },
        { role: "tool", parts: [{ type: "text", text: "a.txt" }], toolCallId: "t1" },
        { role: "tool", parts: [{ type: "text", text: "/tmp" }], toolCallId: "t2" },
      ],
      [TOOL_SCHEMA],
    );
    expect(wire.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "列目录" }] },
      { type: "function_call", call_id: "t1", name: "bash", arguments: '{"cmd":"ls"}' },
      { type: "function_call", call_id: "t2", name: "bash", arguments: '{"cmd":"pwd"}' },
      { type: "function_call_output", call_id: "t1", output: "a.txt" },
      { type: "function_call_output", call_id: "t2", output: "/tmp" },
    ]);
  });

  test("freeform 工具走 custom tool：调用为 custom_tool_call，结果为 custom_tool_call_output", () => {
    const wire = toWireRequest(
      [
        {
          role: "assistant",
          parts: [],
          toolCalls: [{ id: "c1", name: "draft", args: "直接一段自由文本" }],
        },
        { role: "tool", parts: [{ type: "text", text: "已收到" }], toolCallId: "c1" },
      ],
      [FREEFORM_SCHEMA],
    );
    expect(wire.tools).toEqual([
      { type: "custom", name: "draft", description: "自由文本工具", format: { type: "text" } },
    ]);
    expect(wire.input).toEqual([
      { type: "custom_tool_call", call_id: "c1", name: "draft", input: "直接一段自由文本" },
      { type: "custom_tool_call_output", call_id: "c1", output: "已收到" },
    ]);
  });

  test("function 工具 schema 发成平铺的 function 定义（strict 关闭）", () => {
    const wire = toWireRequest([{ role: "user", parts: [{ type: "text", text: "hi" }] }], [TOOL_SCHEMA]);
    expect(wire.tools).toEqual([
      {
        type: "function",
        name: "bash",
        description: "跑命令",
        parameters: TOOL_SCHEMA.parameters,
        strict: false,
      },
    ]);
  });

  test("空文本段丢弃，图片走 data URL；args 字符串原样透传", () => {
    const wire = toWireRequest(
      [
        {
          role: "user",
          parts: [
            { type: "text", text: "" },
            { type: "image", mime: "image/png", data: "AAAA" },
          ],
        },
        {
          role: "assistant",
          parts: [],
          toolCalls: [{ id: "s1", name: "bash", args: '{"cmd":"ls"}' }],
        },
      ],
      undefined,
    );
    expect(wire.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    });
    expect(wire.input[1]).toEqual({
      type: "function_call",
      call_id: "s1",
      name: "bash",
      arguments: '{"cmd":"ls"}',
    });
  });
});

describe("openai-responses · SSE 归一化", () => {
  test("output_item.added 登记身份，arguments.delta 补上 id", () => {
    const byItem = identity();

    const added = mapStreamEvent(
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "function_call", id: "item_1", call_id: "call_1", name: "bash" },
      },
      byItem,
    );
    expect(added.chunks).toEqual([{ type: "tool_call", id: "call_1", name: "bash", argsDelta: "" }]);

    const delta1 = mapStreamEvent(
      { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"cmd"' },
      byItem,
    );
    const delta2 = mapStreamEvent(
      { type: "response.function_call_arguments.delta", item_id: "item_1", delta: ':"ls"}' },
      byItem,
    );
    expect(delta1.chunks).toEqual([{ type: "tool_call", id: "call_1", name: "", argsDelta: '{"cmd"' }]);
    expect(delta2.chunks).toEqual([{ type: "tool_call", id: "call_1", name: "", argsDelta: ':"ls"}' }]);
  });

  test("completed 带 usage 与缓存命中；incomplete 映射成 length", () => {
    const completed = mapStreamEvent(
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_token_details: { cached_tokens: 80 },
            output_token_details: { reasoning_tokens: 6 },
          },
        },
      },
      identity(),
    );
    expect(completed.chunks).toEqual<ChatChunk[]>([
      { type: "usage", usage: { input: 100, output: 20, cached: 80, reasoning: 6 } },
    ]);
    expect(completed.finish).toBeUndefined();

    const incomplete = mapStreamEvent(
      {
        type: "response.completed",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      },
      identity(),
    );
    expect(incomplete.finish).toBe("length");
  });

  test("text / reasoning summary delta 分别映射成 text / reasoning；未知事件静默", () => {
    expect(mapStreamEvent({ type: "response.output_text.delta", delta: "你" }, identity()).chunks).toEqual([
      { type: "text", delta: "你" },
    ]);
    expect(
      mapStreamEvent({ type: "response.reasoning_summary_text.delta", delta: "想" }, identity()).chunks,
    ).toEqual([{ type: "reasoning", delta: "想" }]);
    expect(mapStreamEvent({ type: "response.created" }, identity()).chunks).toEqual([]);
    expect(mapStreamEvent({ type: "response.output_item.done" }, identity()).chunks).toEqual([]);
  });

  test("流内 failed / error 事件抛错", () => {
    expect(() =>
      mapStreamEvent(
        { type: "response.failed", response: { error: { message: "boom" } } },
        identity(),
      ),
    ).toThrow(/stream error/);
    expect(() => mapStreamEvent({ type: "error" }, identity())).toThrow(/stream error/);
  });
});

describe("openai-responses · 端到端（本地 Bun.serve 回放）", () => {
  test("请求形状正确，SSE 流被归一化成完整 chunk 序列", async () => {
    const sse = [
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      'data: {"type":"response.output_text.delta","delta":"你"}',
      'data: {"type":"response.output_text.delta","delta":"好"}',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"item_1","call_id":"call_1","name":"bash"}}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"cmd\\""}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":":\\"ls\\"}"}',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":7,"input_token_details":{"cached_tokens":4}}}}',
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
      const client = createOpenAIResponsesClient("gpt-fake", {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-test",
      });

      const chunks: ChatChunk[] = [];
      for await (const chunk of client.chat({
        model: "gpt-fake",
        messages: [
          { role: "system", parts: [{ type: "text", text: "SYS" }] },
          { role: "user", parts: [{ type: "text", text: "你好" }] },
        ],
        tools: [TOOL_SCHEMA],
      })) {
        chunks.push(chunk);
      }

      // 请求形状：instructions 顶层、max_output_tokens 兜底、平铺 tools、
      // Bearer 鉴权、store 关闭、路径 /v1/responses
      expect(server.port).toBeGreaterThan(0);
      expect(seenBody?.instructions).toBe("SYS");
      expect(seenBody?.max_output_tokens).toBe(8192);
      expect(seenBody?.model).toBe("gpt-fake");
      expect(seenBody?.store).toBe(false);
      expect(seenHeaders?.["authorization"]).toBe("Bearer sk-test");

      // 流归一化
      expect(chunks).toEqual<ChatChunk[]>([
        { type: "text", delta: "你" },
        { type: "text", delta: "好" },
        { type: "tool_call", id: "call_1", name: "bash", argsDelta: "" },
        { type: "tool_call", id: "call_1", name: "", argsDelta: '{"cmd"' },
        { type: "tool_call", id: "call_1", name: "", argsDelta: ':"ls"}' },
        { type: "usage", usage: { input: 12, output: 7, cached: 4 } },
        { type: "done", reason: "tool_calls" },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("HTTP 错误被抛成带 endpoint 前缀的 Error，retry-after 拼进消息", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ error: { message: "bad request" } }), {
          status: 429,
          headers: { "retry-after": "7" },
        }),
    });
    try {
      const client = createOpenAIResponsesClient("gpt-fake", {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      });
      let message = "";
      try {
        for await (const _chunk of client.chat({
          model: "gpt-fake",
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        })) {
          void _chunk;
        }
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("openai-responses 429");
      expect(message).toContain("(retry-after: 7)");
    } finally {
      server.stop(true);
    }
  });
});
