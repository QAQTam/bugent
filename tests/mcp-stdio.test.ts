/**
 * MCP stdio 传输层回归（BUG-015）。
 *
 * 用注入的 spawn 起真实的假 server 子进程，绕开沙箱 runtime 断言：
 *   - string id 应答必须能匹配（有的 server 回 "1" 而不是 1）；
 *   - 控制面请求超时有界，不应答的 server 不能挂死启动；
 *   - 无换行的垃圾输出触发缓冲上限，杀 server 并放走等待者。
 */

import { describe, expect, test } from "bun:test";
import { McpStdioClient, type McpStdioServerConfig } from "../src/mcp/stdio.ts";

function clientFor(
  serverScript: string,
  options: { controlTimeoutMs?: number; maxLineBufferChars?: number } = {},
): McpStdioClient {
  const config: McpStdioServerConfig = {
    id: "fake",
    cmd: [process.execPath, "-e", serverScript],
  };
  return new McpStdioClient(config, {
    spawn: (opts) =>
      Bun.spawn({
        cmd: [...opts.cmd],
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        env: (opts.env ?? {}) as Record<string, string>,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }),
    ...(options.controlTimeoutMs !== undefined ? { controlTimeoutMs: options.controlTimeoutMs } : {}),
    ...(options.maxLineBufferChars !== undefined
      ? { maxLineBufferChars: options.maxLineBufferChars }
      : {}),
  });
}

/** 应答时把 id 原样回显成字符串 —— 严格但合法的 JSON-RPC server。 */
const STRING_ID_SERVER = `
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const result = message.method === "tools/list"
      ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
      : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: String(message.id), result }) + "\\n");
  }
}
`;

describe("MCP stdio 传输层（BUG-015）", () => {
  test("string id 应答能匹配到等待者", async () => {
    const client = clientFor(STRING_ID_SERVER);
    await client.start();
    try {
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    } finally {
      await client.close();
    }
  });

  test("不应答的 server 会在控制面超时后失败，而不是挂死", async () => {
    const client = clientFor("await Bun.sleep(60_000);", { controlTimeoutMs: 150 });
    await client.start();
    try {
      await expect(client.listTools()).rejects.toThrow(/超时/);
    } finally {
      await client.close();
    }
  });

  test("无换行的超长输出触发缓冲上限并杀掉 server", async () => {
    const client = clientFor(
      `process.stdout.write("x".repeat(64 * 1024)); await Bun.sleep(60_000);`,
      { controlTimeoutMs: 5_000, maxLineBufferChars: 1_024 },
    );
    await client.start();
    try {
      await expect(client.listTools()).rejects.toThrow(/无完整消息/);
    } finally {
      await client.close();
    }
  });

  test("callTool 响应取消信号", async () => {
    const client = clientFor(STRING_ID_SERVER);
    await client.start();
    try {
      const controller = new AbortController();
      const pending = client.callTool("echo", {}, { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow(/已取消/);
    } finally {
      await client.close();
    }
  });
});
