import { describe, expect, test } from "bun:test";
import { startConfiguredMcp } from "../src/mcp/runtime.ts";
import { assertMcpSandboxSupported, isMcpSandboxSupported } from "../src/mcp/stdio.ts";

describe("MCP 平台门控", () => {
  test("只有 Linux 支持原生 MCP sandbox", () => {
    expect(isMcpSandboxSupported("linux")).toBe(true);
    expect(isMcpSandboxSupported("win32")).toBe(false);
    expect(isMcpSandboxSupported("darwin")).toBe(false);
  });

  test("非 Linux 直接报错，不允许无沙箱降级", () => {
    expect(() => assertMcpSandboxSupported("win32")).toThrow(/已禁用/);
  });

  test("非 Linux 配置 MCP 时返回明确关闭原因", async () => {
    const started = await startConfiguredMcp({
      platform: "win32",
      cwd: process.cwd(),
      config: {
        servers: [{ id: "filesystem", cmd: ["node", "server.js"] }],
      },
    });
    expect(started.manager).toBeUndefined();
    expect(started.disabledReason).toContain("MCP 已关闭");
  });

  test("没有配置 MCP 时不创建 manager", async () => {
    const started = await startConfiguredMcp({ cwd: process.cwd(), config: undefined });
    expect(started.manager).toBeUndefined();
    expect(started.disabledReason).toBeUndefined();
  });
});
