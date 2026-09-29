import { describe, expect, test } from "bun:test";
import { parseConfigToml } from "../src/config/toml.ts";

function configWithProvider(body: string): string {
  return `
model = "test-model"
provider = "openai"

[[providers]]
id = "openai"
endpoint = "openai-chat"
${body}
`;
}

describe("model / provider 配置", () => {
  test("主键 model + provider", () => {
    const config = parseConfigToml(configWithProvider(""));
    expect(config.model).toBe("test-model");
    expect(config.provider).toBe("openai");
  });

  test("旧键 default_model / default_provider 作为别名", () => {
    const config = parseConfigToml(`
default_model = "test-model"
default_provider = "openai"

[[providers]]
id = "openai"
endpoint = "openai-chat"
`);
    expect(config.model).toBe("test-model");
    expect(config.provider).toBe("openai");
  });

  test("旧 default_model 的 provider/model 前缀写法仍兼容", () => {
    const config = parseConfigToml(`
default_model = "openai/test-model"

[[providers]]
id = "openai"
endpoint = "openai-chat"
`);
    expect(config.model).toBe("test-model");
    expect(config.provider).toBe("openai");
  });

  test("前缀与 provider 冲突时报错", () => {
    expect(() =>
      parseConfigToml(`
model = "openai/test-model"
provider = "anthropic"

[[providers]]
id = "anthropic"
endpoint = "anthropic-messages"
`),
    ).toThrow(/冲突/);
  });

  test("缺 provider 时回落第一个 providers", () => {
    const config = parseConfigToml(`
model = "test-model"

[[providers]]
id = "openai"
endpoint = "openai-chat"
`);
    expect(config.model).toBe("test-model");
    expect(config.provider).toBeUndefined();
  });
});

describe("provider wire 配置", () => {
  function rawProvider(toml: string): string {
    return `
model = "test-model"
provider = "openai"

${toml}
`;
  }

  test("wire 中性简称映射到内部 adapter 标识", () => {
    expect(parseConfigToml(rawProvider(`[[providers]]\nid = "a"\nwire = "chat"`)).providers[0]?.endpoint).toBe("openai-chat");
    expect(parseConfigToml(rawProvider(`[[providers]]\nid = "a"\nwire = "messages"`)).providers[0]?.endpoint).toBe("anthropic-messages");
    expect(parseConfigToml(rawProvider(`[[providers]]\nid = "a"\nwire = "responses"`)).providers[0]?.endpoint).toBe("openai-responses");
    expect(parseConfigToml(rawProvider(`[[providers]]\nid = "a"\nwire = "mock"`)).providers[0]?.endpoint).toBe("mock");
  });

  test("endpoint 旧写法继续可用；缺省仍是 openai-chat", () => {
    expect(parseConfigToml(rawProvider(`[[providers]]\nid = "a"\nendpoint = "openai-chat"`)).providers[0]?.endpoint).toBe("openai-chat");
    expect(parseConfigToml(rawProvider(`[[providers]]\nid = "a"`)).providers[0]?.endpoint).toBe("openai-chat");
  });

  test("wire 与 endpoint 同时出现直接报错", () => {
    expect(() =>
      parseConfigToml(rawProvider(`[[providers]]\nid = "a"\nwire = "chat"\nendpoint = "openai-chat"`)),
    ).toThrow(/二选一/);
  });

  test("非法 wire 值报错并列出合法值", () => {
    expect(() => parseConfigToml(rawProvider(`[[providers]]\nid = "a"\nwire = "grpc"`))).toThrow(
      /chat \/ messages \/ responses \/ mock/,
    );
  });
});

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
review_model = "reviewer"
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
      reviewModel: "reviewer",
    });
    expect(() =>
      parseConfigToml(configWithProvider(`[goals]\nauto_continue = "yes"`)),
    ).toThrow(/auto_continue/);
    expect(() =>
      parseConfigToml(configWithProvider(`[goals]\nreview_policy = "sometimes"`)),
    ).toThrow(/review_policy/);
  });
});
