import { describe, expect, test } from "bun:test";
import { MemoryCredentialStore } from "../src/store/credentials.ts";

describe("credential store", () => {
  test("memory store 按 session + provider 隔离，并支持删除", async () => {
    const store = new MemoryCredentialStore();
    await store.set("s1", "p1", "key-1");
    await store.set("s1", "p2", "key-2");
    await store.set("s2", "p1", "key-3");

    expect(await store.get("s1", "p1")).toBe("key-1");
    expect(await store.get("s1", "p2")).toBe("key-2");
    expect(await store.get("s2", "p1")).toBe("key-3");

    await store.delete("s1", "p1");
    expect(await store.get("s1", "p1")).toBeUndefined();
    expect(await store.get("s1", "p2")).toBe("key-2");
  });
});
