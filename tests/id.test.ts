import { describe, expect, test } from "bun:test";
import { isSessionId, newSessionId } from "../src/util/id.ts";

describe("session id", () => {
  test("新 session 使用标准 UUID", () => {
    const id = newSessionId();
    expect(isSessionId(id)).toBe(true);
    expect(id).toHaveLength(36);
  });

  test("拒绝旧的短 id 作为新格式，但调用方仍可按精确 id 恢复", () => {
    expect(isSessionId("m1x2y3-abc123")).toBe(false);
    expect(isSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });
});
