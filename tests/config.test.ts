import { describe, expect, test } from "bun:test";
import { parseConfigToml } from "../src/config/toml.ts";

function configWithProvider(body: string): string {
  return `
default_model = "openai/test-model"

[[providers]]
id = "openai"
endpoint = "openai-chat"
${body}
`;
}

describe("provider 网络配置", () => {
  test("解析 proxy=false 与 TLS 字段", () => {
    const config = parseConfigToml(
      configWithProvider(`
proxy = false

[providers.tls]
reject_unauthorized = false
ca = "CA-PEM"
server_name = "api.internal"
`),
    );

    expect(config.providers[0]).toMatchObject({
      proxy: false,
      tls: {
        rejectUnauthorized: false,
        ca: "CA-PEM",
        serverName: "api.internal",
      },
    });
  });

  test("解析显式代理 URL", () => {
    const config = parseConfigToml(configWithProvider(`proxy = "http://127.0.0.1:7890"`));
    expect(config.providers[0]?.proxy).toBe("http://127.0.0.1:7890");
  });

  test("非法 proxy 类型被拒绝", () => {
    expect(() => parseConfigToml(configWithProvider("proxy = 123"))).toThrow(/proxy/);
  });
});
