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

  test("解析 reasoning_replay 并拒绝非法值", () => {
    expect(
      parseConfigToml(configWithProvider(`reasoning_replay = "both"`)).providers[0]?.reasoningReplay,
    ).toBe("both");
    expect(() =>
      parseConfigToml(configWithProvider(`reasoning_replay = "invalid"`)),
    ).toThrow(/reasoning_replay/);
  });

  test("解析 Goal Mode 配置并拒绝非法值", () => {
    const config = parseConfigToml(
      configWithProvider(`
[goals]
enabled = false
auto_continue = true
max_consecutive_turns = 12
max_goal_token_budget = 50000
context_refresh = "manual"
handoff_inline_bytes = 16384
review_policy = "high"
review_model = "openai/reviewer"
`),
    );
    expect(config.goals).toEqual({
      enabled: false,
      autoContinue: true,
      maxConsecutiveTurns: 12,
      maxGoalTokenBudget: 50000,
      contextRefresh: "manual",
      handoffInlineBytes: 16384,
      reviewPolicy: "high",
      reviewModel: "openai/reviewer",
    });
    expect(() =>
      parseConfigToml(configWithProvider(`[goals]\nauto_continue = "yes"`)),
    ).toThrow(/auto_continue/);
    expect(() =>
      parseConfigToml(configWithProvider(`[goals]\nreview_policy = "sometimes"`)),
    ).toThrow(/review_policy/);
  });
});
