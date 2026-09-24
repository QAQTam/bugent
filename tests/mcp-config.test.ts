import { describe, expect, test } from "bun:test";
import { parseConfigToml } from "../src/config/toml.ts";

function base(body: string): string {
  return `
default_model = "openai/test"

[[providers]]
id = "openai"
endpoint = "openai-chat"

${body}
`;
}

describe("MCP 配置解析", () => {
  test("解析 stdio server 与 capability grant", () => {
    const config = parseConfigToml(
      base(`
[[mcp.servers]]
id = "filesystem"
cmd = ["node", "server.js"]
cwd = "/workspace"
workspace_read = true
workspace_write = ["/workspace/out"]
network = "none"
read = ["/opt/data"]
write = []
exec = ["/usr"]
env = ["NODE_ENV"]
limits = { cpu_seconds = 30, address_space_bytes = 536870912, open_files = 128 }
`),
    );

    expect(config.mcp?.servers?.[0]).toMatchObject({
      id: "filesystem",
      cmd: ["node", "server.js"],
      cwd: "/workspace",
      workspaceRead: true,
      workspaceWrite: ["/workspace/out"],
      network: "none",
      read: ["/opt/data"],
      write: [],
      exec: ["/usr"],
      env: ["NODE_ENV"],
      limits: {
        cpuSeconds: 30,
        addressSpaceBytes: 536870912,
        openFiles: 128,
      },
    });
  });

  test("workspace_write 可以是布尔值", () => {
    const config = parseConfigToml(
      base(`
[[mcp.servers]]
id = "writer"
cmd = ["node", "server.js"]
workspace_write = true
`),
    );
    expect(config.mcp?.servers?.[0]?.workspaceWrite).toBe(true);
  });

  test("拒绝重复 server id 和非法 network", () => {
    expect(() =>
      parseConfigToml(
        base(`
[[mcp.servers]]
id = "dup"
cmd = ["node", "a.js"]

[[mcp.servers]]
id = "dup"
cmd = ["node", "b.js"]
`),
      ),
    ).toThrow(/重复/);

    expect(() =>
      parseConfigToml(
        base(`
[[mcp.servers]]
id = "bad"
cmd = ["node", "a.js"]
network = "magic"
`),
      ),
    ).toThrow(/network/);
  });

  test("解析 skills roots / disabled / disable_defaults", () => {
    const config = parseConfigToml(
      base(`
[skills]
paths = ["~/.config/bugent-skills", "./skills"]
disable_defaults = true
disabled = ["legacy"]
`),
    );
    expect(config.skills).toEqual({
      paths: ["~/.config/bugent-skills", "./skills"],
      disableDefaults: true,
      disabled: ["legacy"],
    });
  });
});
