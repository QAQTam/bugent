import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeSandboxLibraryPath } from "../src/sandbox/policy.ts";

const repoRoot = resolve(import.meta.dir, "..");
const forkPath = process.env.BUGENT_BUN_BIN ?? resolve(repoRoot, "..", "bun", "build", "release", "bun");
const libraryPath =
  process.env.BUGENT_SANDBOX_LIBRARY ??
  nativeSandboxLibraryPath() ??
  join(repoRoot, "native", "sandbox", "build", "libbugent-sandbox.so");
const available = existsSync(forkPath) && existsSync(libraryPath);

describe.skipIf(!available)("MCP stdio sandbox integration", () => {
  test("initializes, lists, and calls a tool through the sandboxed transport", () => {
    const dir = mkdtempSync(join(tmpdir(), "bugent-mcp-"));
    const server = join(dir, "fake-server.ts");
    const state = join(dir, "state");
    writeFileSync(
      server,
      `
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  for (;;) {
    const i = buffer.indexOf("\\n");
    if (i < 0) break;
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
    } else if (message.method === "tools/call") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(message.params?.arguments?.text ?? "") }] } });
    }
  }
}
`,
    );

    const code = `
      import { McpStdioClient } from ${JSON.stringify(resolve(repoRoot, "src/mcp/stdio.ts"))};
      const client = new McpStdioClient({
        id: "fake",
        cmd: [process.execPath, process.env.FAKE_SERVER],
        cwd: process.env.MCP_CWD,
        stateDir: process.env.MCP_STATE,
        env: [],
      });
      await client.start();
      const tools = await client.listTools();
      const result = await client.callTool("echo", { text: "hello" });
      await client.close();
      process.stdout.write(JSON.stringify({ tools, result }));
    `;

    try {
      const result = Bun.spawnSync([forkPath, "-e", code], {
        cwd: repoRoot,
        env: {
          ...process.env,
          BUGENT_BUN_BIN: forkPath,
          BUGENT_SANDBOX_LIBRARY: libraryPath,
          FAKE_SERVER: server,
          MCP_CWD: dir,
          MCP_STATE: state,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      });
      const stdout = result.stdout.toString().trim();
      if (result.exitCode !== 0) {
        throw new Error(`MCP probe failed: ${result.stderr.toString()}\n${stdout}`);
      }
      const parsed = JSON.parse(stdout) as {
        tools: Array<{ name: string }>;
        result: { content: Array<{ text: string }> };
      };
      expect(parsed.tools.map((tool) => tool.name)).toEqual(["echo"]);
      expect(parsed.result.content[0]?.text).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
