import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { McpManager } from "../src/mcp/manager.ts";
import { McpStdioClient, type McpToolInfo } from "../src/mcp/stdio.ts";
import { mcpToolName } from "../src/mcp/tools.ts";
import { ToolRegistry } from "../src/tools/types.ts";

const restores: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore.mockRestore();
});

function mockClient(tools: McpToolInfo[] | (() => McpToolInfo[])): void {
  restores.push(spyOn(McpStdioClient.prototype, "start").mockResolvedValue());
  restores.push(spyOn(McpStdioClient.prototype, "close").mockResolvedValue());
  restores.push(
    spyOn(McpStdioClient.prototype, "listTools").mockImplementation(async () =>
      typeof tools === "function" ? tools() : tools,
    ),
  );
  restores.push(
    spyOn(McpStdioClient.prototype, "callTool").mockResolvedValue({
      content: [{ type: "text", text: "echo-ok" }],
    }),
  );
}

const echo: McpToolInfo = {
  name: "echo",
  description: "Echo text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

describe("MCP manager", () => {
  test("attach/detach 与 manifest 使用稳定命名", async () => {
    mockClient([echo]);
    const manager = new McpManager();
    await manager.start({ id: "my server", cmd: ["fake"] });
    const registry = new ToolRegistry();
    const names = manager.attach(registry);

    expect(names).toEqual([mcpToolName("my server", "echo")]);
    expect(registry.get(names[0]!)).toBeDefined();
    expect(manager.manifest()).toContain(`\`${names[0]}\`: Echo text.`);
    expect(manager.status().servers).toEqual([
      { id: "my server", tools: names },
    ]);

    const result = await registry.execute(
      { id: "c1", name: names[0]!, args: { text: "hi" } },
      { cwd: "/tmp", signal: new AbortController().signal, callId: "c1", sessionId: "s1" },
    );
    expect(result).toMatchObject({ ok: true, output: "echo-ok" });

    manager.detach(registry);
    expect(registry.get(names[0]!)).toBeUndefined();
    await manager.close();
  });

  test("reload 替换快照、更新 registry 并通知目录变化", async () => {
    let listCalls = 0;
    const changes: string[][] = [];
    mockClient(() => {
      listCalls += 1;
      return listCalls === 1
        ? [echo]
        : [{ name: "write", description: "Write text.", inputSchema: { type: "object" } }];
    });
    const manager = new McpManager({
      onToolsChanged: (change) => changes.push([...change.added, ...change.removed]),
    });
    await manager.start({ id: "fake", cmd: ["fake"] });
    const registry = new ToolRegistry();
    manager.attach(registry);

    const change = await manager.reload("fake");

    expect(change.added).toEqual([mcpToolName("fake", "write")]);
    expect(change.removed).toEqual([mcpToolName("fake", "echo")]);
    expect(registry.get(mcpToolName("fake", "echo"))).toBeUndefined();
    expect(registry.get(mcpToolName("fake", "write"))).toBeDefined();
    expect(changes).toContainEqual([
      mcpToolName("fake", "write"),
      mcpToolName("fake", "echo"),
    ]);
    await manager.close();
  });

  test("session allowlist 只注册选中的 server", async () => {
    mockClient([echo]);
    const manager = new McpManager();
    await manager.start({ id: "one", cmd: ["fake"] });
    await manager.start({ id: "two", cmd: ["fake"] });
    const registry = new ToolRegistry();
    const names = manager.attach(registry, ["two"]);

    expect(names).toEqual([mcpToolName("two", "echo")]);
    expect(registry.get(mcpToolName("one", "echo"))).toBeUndefined();
    expect(registry.get(mcpToolName("two", "echo"))).toBeDefined();
    await manager.close();
  });
});
