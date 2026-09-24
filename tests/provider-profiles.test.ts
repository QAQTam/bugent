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
});
