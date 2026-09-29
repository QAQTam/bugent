import { afterEach, describe, expect, test } from "bun:test";
import {
  exportProviderProfiles,
  importProviderProfiles,
  parseProviderProfiles,
  PROVIDER_PROFILE_SCHEMA,
  serializeProviderProfiles,
  type ProviderProfileDocumentV1,
} from "../src/core/provider-profiles.ts";
import { SessionStore } from "../src/store/repository.ts";

const stores: SessionStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});

function makeStore(): SessionStore {
  const store = new SessionStore({ path: ":memory:" });
  stores.push(store);
  store.createSession({
    id: "s1",
    createdAt: 1,
    updatedAt: 1,
    model: "m",
    providerId: "local",
    systemPrompt: "SYS",
    cwd: "/tmp",
  });
  return store;
}

function document(providers: ProviderProfileDocumentV1["providers"]): ProviderProfileDocumentV1 {
  return {
    schema: PROVIDER_PROFILE_SCHEMA,
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    providers,
  };
}

describe("provider profile export/import", () => {
  test("导出不包含 apiKey 和内联 TLS 私钥材料", () => {
    const store = makeStore();
    store.setProviderConfig("s1", {
      id: "local",
      endpoint: "openai-chat",
      baseUrl: "http://127.0.0.1:8787/v1",
      headers: { "x-test": "1" },
      extraBody: { reasoning_effort: "high" },
      reasoningReplay: "both",
      proxy: false,
      tls: {
        rejectUnauthorized: false,
        serverName: "example.test",
        caFile: "/tmp/ca.pem",
        certFile: "/tmp/cert.pem",
        keyFile: "/tmp/key.pem",
        ca: "INLINE-CA-SECRET",
        cert: "INLINE-CERT-SECRET",
        key: "INLINE-KEY-SECRET",
        passphrase: "INLINE-PASSPHRASE",
      },
      apiKey: "INLINE-API-KEY",
    } as never);

    const exported = exportProviderProfiles(store, "s1", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const text = serializeProviderProfiles(exported);

    expect(text).not.toContain("INLINE-API-KEY");
    expect(text).not.toContain("INLINE-CA-SECRET");
    expect(text).not.toContain("INLINE-KEY-SECRET");
    expect(text).not.toContain("INLINE-PASSPHRASE");
    expect(exported.providers[0]?.tls).toEqual({
      rejectUnauthorized: false,
      serverName: "example.test",
      caFile: "/tmp/ca.pem",
      certFile: "/tmp/cert.pem",
      keyFile: "/tmp/key.pem",
    });
  });

  test("BUG-013: headers / proxy userinfo / extraBody 里的密钥在导出时脱敏", () => {
    const store = makeStore();
    store.setProviderConfig("s1", {
      id: "gw",
      endpoint: "openai-chat",
      baseUrl: "https://gw.example/v1",
      headers: {
        Authorization: "Bearer sk-gateway-secret-123",
        "X-Custom-Trace": "trace-42",
        Cookie: "session=abc",
      },
      extraBody: {
        api_key: "sk-inline-extra-body-key",
        note: "just a normal note",
        nested: { token: "eyJhbGciOiJIUzI1NiJ9.e30.abc" },
      },
      proxy: "http://user:hunter2@proxy.example:3128",
    } as never);

    const exported = exportProviderProfiles(store, "s1");
    const provider = exported.providers[0]!;

    expect(provider.headers?.Authorization).toBe("__REDACTED__");
    expect(provider.headers?.Cookie).toBe("__REDACTED__");
    // 非敏感 header 原样保留
    expect(provider.headers?.["X-Custom-Trace"]).toBe("trace-42");
    expect(provider.extraBody?.api_key).toBe("__REDACTED__");
    expect(provider.extraBody?.note).toBe("just a normal note");
    expect((provider.extraBody?.nested as Record<string, unknown>).token).toBe("__REDACTED__");
    expect(provider.proxy).toBe("http://proxy.example:3128");

    const text = serializeProviderProfiles(exported);
    expect(text).not.toContain("sk-gateway-secret-123");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("sk-inline-extra-body-key");
  });

  test("序列化后可以解析回版本化文档", () => {
    const store = makeStore();
    store.setProviderConfig("s1", {
      id: "local",
      endpoint: "mock",
    });

    const parsed = parseProviderProfiles(serializeProviderProfiles(exportProviderProfiles(store, "s1")));
    expect(parsed.schema).toBe(PROVIDER_PROFILE_SCHEMA);
    expect(parsed.version).toBe(1);
    expect(parsed.providers).toEqual([{ id: "local", endpoint: "mock" }]);
  });

  test("冲突策略支持 skip / overwrite / rename", () => {
    const store = makeStore();
    store.setProviderConfig("s1", { id: "local", endpoint: "mock" });

    const incoming = document([
      { id: "local", endpoint: "openai-chat", baseUrl: "http://new" },
      { id: "other", endpoint: "mock" },
    ]);

    const skipped = importProviderProfiles(store, "s1", incoming, { conflict: "skip" });
    expect(skipped.skipped).toEqual(["local"]);
    expect(skipped.imported).toEqual(["other"]);
    expect(store.getProviderConfig("s1", "local")?.endpoint).toBe("mock");

    const overwritten = importProviderProfiles(store, "s1", incoming, { conflict: "overwrite" });
    expect(overwritten.imported).toEqual(["local", "other"]);
    expect(store.getProviderConfig("s1", "local")?.baseUrl).toBe("http://new");

    const renamed = importProviderProfiles(store, "s1", incoming, { conflict: "rename" });
    expect(renamed.renamed).toEqual({ local: "local-imported", other: "other-imported" });
    expect(store.getProviderConfig("s1", "local-imported")?.baseUrl).toBe("http://new");
    expect(store.getProviderConfig("s1", "other-imported")?.endpoint).toBe("mock");
  });

  test("dryRun 只报告结果，不写入 store", () => {
    const store = makeStore();
    const result = importProviderProfiles(
      store,
      "s1",
      document([{ id: "dry", endpoint: "mock" }]),
      { dryRun: true },
    );

    expect(result.imported).toEqual(["dry"]);
    expect(store.getProviderConfig("s1", "dry")).toBeUndefined();
  });

  test("拒绝 apiKey、内联 TLS 私钥和未知版本", () => {
    expect(() =>
      parseProviderProfiles(
        JSON.stringify({
          schema: PROVIDER_PROFILE_SCHEMA,
          version: 1,
          exportedAt: "x",
          providers: [{ id: "x", endpoint: "mock", apiKey: "secret" }],
        }),
      ),
    ).toThrow("apiKey 不允许导入");

    expect(() =>
      parseProviderProfiles(
        JSON.stringify({
          schema: PROVIDER_PROFILE_SCHEMA,
          version: 1,
          exportedAt: "x",
          providers: [{ id: "x", endpoint: "mock", tls: { key: "secret" } }],
        }),
      ),
    ).toThrow("tls.key 不允许导入");

    expect(() =>
      parseProviderProfiles(
        JSON.stringify({
          schema: PROVIDER_PROFILE_SCHEMA,
          version: 99,
          exportedAt: "x",
          providers: [],
        }),
      ),
    ).toThrow("不支持的 provider profile version");
  });

  test("导入接受 wire 简称；与 endpoint 互斥；非法值报错", () => {
    const store = makeStore();
    importProviderProfiles(
      store,
      "s1",
      document([{ id: "local", endpoint: "mock" }]),
      { conflict: "overwrite" },
    );

    // wire 简称导入后落库为内部全名
    importProviderProfiles(
      store,
      "s1",
      parseProviderProfiles(
        JSON.stringify({
          schema: PROVIDER_PROFILE_SCHEMA,
          version: 1,
          exportedAt: "x",
          providers: [{ id: "p1", wire: "messages" }, { id: "p2", wire: "chat" }],
        }),
      ),
      { conflict: "overwrite" },
    );
    expect(store.getProviderConfig("s1", "p1")?.endpoint).toBe("anthropic-messages");
    expect(store.getProviderConfig("s1", "p2")?.endpoint).toBe("openai-chat");

    expect(() =>
      parseProviderProfiles(
        JSON.stringify({
          schema: PROVIDER_PROFILE_SCHEMA,
          version: 1,
          exportedAt: "x",
          providers: [{ id: "x", wire: "chat", endpoint: "openai-chat" }],
        }),
      ),
    ).toThrow("二选一");

    expect(() =>
      parseProviderProfiles(
        JSON.stringify({
          schema: PROVIDER_PROFILE_SCHEMA,
          version: 1,
          exportedAt: "x",
          providers: [{ id: "x", wire: "grpc" }],
        }),
      ),
    ).toThrow("不合法");
  });
});
