/**
 * 端到端集成测试：真的起一个 HTTP server 吐 SSE，
 * 验证 openai-chat adapter 的流式解析 + P4 loop 串起来能跑通。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createOpenAIChatClient } from "../src/provider/adapters/openai-chat.ts";
import { AgentSession } from "../src/core/session.ts";
import { runTurn, runUserTurn } from "../src/core/loop.ts";
import { storedText } from "../src/core/message.ts";
import { ToolRegistry, type Tool } from "../src/tools/types.ts";
import { createDefaultTools } from "../src/tools/builtin.ts";
import type { ChatChunk } from "../src/provider/types.ts";

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function event(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

describe("P1+P4 · 端到端（HTTP + SSE）", () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterAll(() => {
    for (const server of servers) server.stop(true);
  });

  function serve(handler: (req: Request) => Response | Promise<Response>): number {
    const server = Bun.serve({ port: 0, fetch: handler });
    servers.push(server);
    if (server.port === undefined) throw new Error("测试服务器未监听 TCP 端口");
    return server.port;
  }

  test("文本流被正确归一化，并以 done 收尾", async () => {
    let sawAuth = "";
    const port = serve((req) => {
      sawAuth = req.headers.get("authorization") ?? "";
      return sseResponse([
        event({ choices: [{ delta: { content: "你" } }] }),
        event({ choices: [{ delta: { content: "好" } }] }),
        event({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]",
      ]);
    });

    const client = createOpenAIChatClient("test-model", {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "secret",
    });

    const chunks: ChatChunk[] = [];
    for await (const chunk of client.chat({
      model: "test-model",
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual<ChatChunk[]>([
      { type: "text", delta: "你" },
      { type: "text", delta: "好" },
      { type: "done", reason: "stop" },
    ]);
    expect(sawAuth).toBe("Bearer secret");
  });

  test("分片的 tool_call 跨 SSE 事件也能拼出完整参数", async () => {
    const port = serve(() =>
      sseResponse([
        event({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"cmd"' } }],
              },
            },
          ],
        }),
        event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls -la"}' } }] } }] }),
        event({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        "data: [DONE]",
      ]),
    );

    const client = createOpenAIChatClient("test-model", { baseUrl: `http://127.0.0.1:${port}/v1` });
    const chunks: ChatChunk[] = [];
    for await (const chunk of client.chat({
      model: "test-model",
      messages: [{ role: "user", parts: [{ type: "text", text: "列目录" }] }],
    })) {
      chunks.push(chunk);
    }

    const args = chunks
      .filter((c): c is Extract<ChatChunk, { type: "tool_call" }> => c.type === "tool_call")
      .map((c) => c.argsDelta)
      .join("");

    expect(args).toBe('{"cmd":"ls -la"}');
    expect(chunks.at(-1)).toEqual({ type: "done", reason: "tool_calls" });
  });

  test("HTTP 错误被转成可读异常", async () => {
    const port = serve(() => new Response("bad key", { status: 401, statusText: "Unauthorized" }));
    const client = createOpenAIChatClient("test-model", { baseUrl: `http://127.0.0.1:${port}/v1` });

    const iterate = async (): Promise<void> => {
      for await (const _chunk of client.chat({
        model: "test-model",
        messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      })) {
        // 不该走到这里
      }
    };

    await expect(iterate()).rejects.toThrow(/401/);
  });

  test("完整一轮：模型要工具 -> 真执行 -> 模型收尾", async () => {
    let call = 0;
    const port = serve(() => {
      call += 1;
      if (call === 1) {
        return sseResponse([
          event({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "read_note", arguments: '{"key":"' } },
                  ],
                },
              },
            ],
          }),
          event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'todo"}' } }] } }] }),
          event({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          "data: [DONE]",
        ]);
      }
      return sseResponse([
        event({ choices: [{ delta: { content: "笔记是：买牛奶" } }] }),
        event({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 42, completion_tokens: 7 },
        }),
        "data: [DONE]",
      ]);
    });

    const notes: Record<string, string> = { todo: "买牛奶" };
    const readNote: Tool<{ key: string }> = {
      name: "read_note",
      description: "读一条笔记",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
      async run(input) {
        return notes[input.key] ?? "not found";
      },
    };

    const client = createOpenAIChatClient("test-model", { baseUrl: `http://127.0.0.1:${port}/v1` });
    const session = new AgentSession({ id: "e2e", system: "SYS", client, model: "test-model" });
    session.appendUser("我的 todo 是什么？");

    const result = await runTurn(session, {
      tools: new ToolRegistry().register(readNote),
      cwd: process.cwd(),
    });

    expect(result.text).toBe("笔记是：买牛奶");
    expect(result.steps).toBe(2);
    expect(result.usage).toEqual({ input: 42, output: 7 });
    expect(session.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  test("完整一轮：模型调用 bash 工具 -> 真执行 -> 输出回流给模型", async () => {
    let call = 0;
    const port = serve(() => {
      call += 1;
      if (call === 1) {
        return sseResponse([
          event({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_bash",
                      function: { name: "bash", arguments: '{"command":"echo from-bash-tool"}' },
                    },
                  ],
                },
              },
            ],
          }),
          event({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
          "data: [DONE]",
        ]);
      }
      return sseResponse([
        event({ choices: [{ delta: { content: "命令跑完了" } }] }),
        event({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]",
      ]);
    });

    const client = createOpenAIChatClient("test-model", { baseUrl: `http://127.0.0.1:${port}/v1` });
    const session = new AgentSession({ id: "bash-e2e", system: "SYS", client, model: "test-model" });

    const result = await runUserTurn(session, "跑个命令", {
      tools: createDefaultTools(),
      cwd: process.cwd(),
    });

    expect(result.text).toBe("命令跑完了");
    expect(result.steps).toBe(2);

    const toolMessage = session.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(storedText(toolMessage!)).toContain("from-bash-tool");
    expect(storedText(toolMessage!)).toContain("[exit code: 0]");
  });
});
