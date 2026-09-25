import { describe, expect, test } from "bun:test";
import { mapStreamEvent, toWireMessages, toWireTools } from "../src/provider/adapters/openai-chat.ts";
import type { ChatChunk, ChatMessage } from "../src/provider/types.ts";

describe("P1 · openai-chat 归一化", () => {
  test("assistant 的工具调用被翻译成 tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "system", parts: [{ type: "text", text: "SYS" }] },
      { role: "user", parts: [{ type: "text", text: "你好" }] },
      {
        role: "assistant",
        parts: [{ type: "text", text: "我查一下" }],
        toolCalls: [{ id: "c1", name: "bash", args: { cmd: "ls" } }],
      },
      { role: "tool", parts: [{ type: "text", text: "a.txt" }], toolCallId: "c1" },
    ];

    const wire = toWireMessages(messages);

    expect(wire[0]).toEqual({ role: "system", content: "SYS" });
    expect(wire[2]).toEqual({
      role: "assistant",
      content: "我查一下",
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
    });
    expect(wire[3]).toEqual({ role: "tool", content: "a.txt", tool_call_id: "c1" });
  });

  test("纯工具调用（无文本）的 assistant content 为 null", () => {
    const wire = toWireMessages([
      { role: "assistant", parts: [], toolCalls: [{ id: "c1", name: "bash", args: {} }] },
    ]);
    expect(wire[0]?.content).toBeNull();
  });

  test("图片被翻译成 image_url data URI", () => {
    const wire = toWireMessages([
      {
        role: "user",
        parts: [
          { type: "text", text: "看图" },
          { type: "image", mime: "image/png", data: "AAAA" },
        ],
      },
    ]);
    expect(wire[0]?.content).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  test("工具 schema 被翻译成 function 格式", () => {
    const tools = toWireTools([
      {
        name: "bash",
        description: "跑命令",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      },
    ]);
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "bash",
        description: "跑命令",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      },
    });
  });

  test("assistant reasoning 按 provider 策略回放", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", parts: [{ type: "text", text: "answer" }], reasoning: "thinking" },
    ];

    expect(toWireMessages(messages, "reasoning")[0]).toMatchObject({
      reasoning: "thinking",
    });
    expect(toWireMessages(messages, "reasoning")[0]?.reasoning_content).toBeUndefined();

    expect(toWireMessages(messages, "reasoning_content")[0]).toMatchObject({
      reasoning_content: "thinking",
    });
    expect(toWireMessages(messages, "both")[0]).toMatchObject({
      reasoning: "thinking",
      reasoning_content: "thinking",
    });
    expect(toWireMessages(messages, "none")[0]?.reasoning).toBeUndefined();
  });
});

describe("P1 · openai-chat 流式映射", () => {
  test("文本增量被映射成 text chunk", () => {
    const { chunks } = mapStreamEvent({ choices: [{ delta: { content: "你" } }] }, new Map());
    expect(chunks).toEqual([{ type: "text", delta: "你" }]);
  });

  test("按 index 分片的 tool_call 能拼出完整 id", () => {
    const ids = new Map<number, string>();

    const first = mapStreamEvent(
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_abc", function: { name: "bash", arguments: '{"cmd"' } }],
            },
          },
        ],
      },
      ids,
    );

    const second = mapStreamEvent(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] } }] },
      ids,
    );

    expect(first.chunks).toEqual([{ type: "tool_call", id: "call_abc", name: "bash", argsDelta: '{"cmd"' }]);
    expect(second.chunks).toEqual([{ type: "tool_call", id: "call_abc", name: "", argsDelta: ':"ls"}' }]);
  });

  test("usage 与 finish_reason 被正确映射", () => {
    const mapped = mapStreamEvent(
      {
        choices: [{ finish_reason: "tool_calls", delta: {} }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } },
      },
      new Map(),
    );

    expect(mapped.finish).toBe("tool_calls");
    expect(mapped.chunks).toEqual<ChatChunk[]>([
      // 命中 80 / 输入 100 → 未命中 20 直接推出来（DeepSeek 会自己回传 miss，
      // 只回传 hit 的 provider 就得靠这一步补齐）
      { type: "usage", usage: { input: 100, output: 20, cached: 80, cacheMiss: 20 } },
    ]);
  });

  test("DeepSeek 风格的缓存字段与 reasoning_tokens 也被认出来", () => {
    const mapped = mapStreamEvent(
      {
        choices: [{ finish_reason: "stop", delta: {} }],
        usage: {
          prompt_tokens: 7000,
          completion_tokens: 900,
          prompt_cache_hit_tokens: 6144,
          prompt_cache_miss_tokens: 856,
          // 同一个量的占位符：取最大值才不会读成 0
          cache_read_input_tokens: 0,
          completion_tokens_details: { reasoning_tokens: 512 },
        },
      },
      new Map(),
    );

    expect(mapped.chunks).toEqual<ChatChunk[]>([
      {
        type: "usage",
        usage: { input: 7000, output: 900, cached: 6144, cacheMiss: 856, reasoning: 512 },
      },
    ]);
  });

  test("length 结束原因被保留", () => {
    const mapped = mapStreamEvent({ choices: [{ finish_reason: "length", delta: {} }] }, new Map());
    expect(mapped.finish).toBe("length");
  });
});
