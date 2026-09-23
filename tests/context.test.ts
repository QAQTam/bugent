import { describe, expect, test } from "bun:test";
import { AgentSession } from "../src/core/session.ts";
import { buildContext, canonicalize, prefixHash, sortForContext } from "../src/core/context.ts";
import { makeMessage, SYSTEM_MSGID, textPart, type StoredMessage } from "../src/core/message.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import type { Role } from "../src/provider/types.ts";

function make(msgid: number, role: Role, text: string): StoredMessage {
  return makeMessage({
    msgid,
    role,
    origin: role === "system" ? "system" : role,
    parts: [textPart(text)],
    createdAt: 0,
  });
}

function newSession(system = "SYS"): AgentSession {
  return new AgentSession({
    id: "test",
    system,
    client: createMockClient({ script: [] }),
    model: "test-model",
    now: () => 0,
  });
}

describe("P2 · msgid 与上下文顺序", () => {
  test("msgid 0 必须是 system", () => {
    expect(() => sortForContext([make(0, "user", "nope")])).toThrow(/必须是 system/);
  });

  test("缺少 msgid 0 直接报错", () => {
    expect(() => sortForContext([make(1, "user", "hi")])).toThrow(/缺少 msgid 0/);
  });

  test("重复 msgid 直接报错", () => {
    expect(() => sortForContext([make(SYSTEM_MSGID, "system", "s"), make(1, "user", "a"), make(1, "user", "b")])).toThrow(
      /重复/,
    );
  });

  test("msgid 0 永远排最前，其余按 msgid 升序", () => {
    const ordered = sortForContext([
      make(3, "user", "third"),
      make(SYSTEM_MSGID, "system", "sys"),
      make(1, "user", "first"),
      make(2, "assistant", "second"),
    ]);
    expect(ordered.map((m) => m.msgid)).toEqual([0, 1, 2, 3]);
  });

  test("注入走新 msgid，不插队", () => {
    const session = newSession();
    session.appendUser("一");
    session.appendInjection("注入");
    session.appendUser("二");
    expect(session.messages.map((m) => m.msgid)).toEqual([0, 1, 2, 3]);
    expect(session.messages[2]?.origin).toBe("inject");
  });
});

describe("P2 · 缓存前缀稳定性", () => {
  test("canonicalize 与对象键序无关", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  test("只追加时，已冻结前缀逐字节不变", () => {
    const session = newSession();
    session.appendUser("第一句");
    session.appendAssistant("第一次回复");

    const frozenUpTo = session.lastMsgId;
    const prefixBytes = canonicalize(buildContext(session.messages.filter((m) => m.msgid <= frozenUpTo)));
    const prefixFingerprint = session.prefixHash(frozenUpTo);
    const perMessageBytes = session.messages.map(canonicalize);

    // 后续追加：用户消息、工具结果、注入、助手回复
    session.appendUser("第二句");
    session.appendAssistant("", [{ id: "c1", name: "echo", args: { text: "x" } }]);
    session.appendToolResult("c1", "echo:x");
    session.appendInjection("文件快照变了");
    session.appendAssistant("第二次回复");

    const prefixAfter = canonicalize(buildContext(session.messages.filter((m) => m.msgid <= frozenUpTo)));

    expect(prefixAfter).toBe(prefixBytes);
    expect(session.prefixHash(frozenUpTo)).toBe(prefixFingerprint);
    expect(session.messages.slice(0, perMessageBytes.length).map(canonicalize)).toEqual(perMessageBytes);
  });

  test("前缀指纹对内容敏感", () => {
    const a = [make(SYSTEM_MSGID, "system", "SYS"), make(1, "user", "hello")];
    const b = [make(SYSTEM_MSGID, "system", "SYS"), make(1, "user", "hello!")];
    expect(prefixHash(a)).not.toBe(prefixHash(b));
  });

  test("session.noteContextSent 记录的前缀在只追加后仍匹配", () => {
    const session = newSession();
    session.appendUser("hi");
    session.noteContextSent();
    const before = session.lastSentPrefixHash;
    expect(before).toBeDefined();

    session.appendAssistant("hello");
    // 前缀变了（因为又追加了消息），所以不该匹配
    expect(session.prefixStillMatches()).toBe(false);

    // 重新记录后应匹配
    session.noteContextSent();
    expect(session.prefixStillMatches()).toBe(true);
  });
});

describe("P2 · 消息不可变", () => {
  test("消息及其嵌套结构被冻结", () => {
    const session = newSession();
    const msg = session.appendUser("hello");
    expect(Object.isFrozen(msg)).toBe(true);
    expect(Object.isFrozen(msg.parts)).toBe(true);
    expect(Object.isFrozen(msg.parts[0])).toBe(true);
    expect(() => {
      (msg as { msgid: number }).msgid = 99;
    }).toThrow();
  });
});
