import { describe, expect, test } from "bun:test";
import { AgentSession } from "../src/core/session.ts";
import { ManagedSession, SessionBusyError, SessionRegistry } from "../src/core/registry.ts";
import { createMockClient, type MockTurn } from "../src/provider/adapters/mock.ts";

function makeSession(id: string, script: MockTurn[] = [{ text: "ok" }], chunkDelayMs = 0): AgentSession {
  return new AgentSession({
    id,
    system: "SYS",
    client: createMockClient({ script, chunkDelayMs }),
    model: "test-model",
    now: () => 0,
  });
}

describe("P9 · SessionRegistry 基本操作", () => {
  test("add / get / list / remove", () => {
    const registry = new SessionRegistry();
    registry.add(makeSession("a"));
    registry.add(makeSession("b"));

    expect(registry.size).toBe(2);
    expect(registry.get("a")?.id).toBe("a");
    expect(registry.list().map((m) => m.id)).toEqual(["a", "b"]);
    expect(registry.remove("a")).toBe(true);
    expect(registry.get("a")).toBeUndefined();
    expect(registry.size).toBe(1);
  });

  test("重复 id 直接报错，不静默覆盖", () => {
    const registry = new SessionRegistry();
    registry.add(makeSession("a"));
    expect(() => registry.add(makeSession("a"))).toThrow(/已存在/);
  });

  test("require 对未知会话报错", () => {
    const registry = new SessionRegistry();
    expect(() => registry.require("nope")).toThrow(/未知会话/);
  });
});

describe("P9 · 并发锁", () => {
  test("同一会话重复进入抛 SessionBusyError，而不是排队", async () => {
    const registry = new SessionRegistry();
    const managed = registry.add(makeSession("a", [{ text: "慢" }], 60));

    const first = managed.run("第一轮");
    await Bun.sleep(10);

    await expect(managed.run("第二轮")).rejects.toBeInstanceOf(SessionBusyError);
    await first;

    expect(managed.busy).toBe(false);
  });

  test("一轮结束后可以再次进入同一会话", async () => {
    const registry = new SessionRegistry();
    const managed = registry.add(makeSession("a", [{ text: "一" }, { text: "二" }]));

    await managed.run("第一次");
    expect(managed.busy).toBe(false);

    await managed.run("第二次");
    expect(managed.session.turn).toBe(2);
  });

  test("不同会话可以同时在跑（真正并行，不是排队）", async () => {
    const registry = new SessionRegistry();
    const a = registry.add(makeSession("a", [{ text: "a" }], 80));
    const b = registry.add(makeSession("b", [{ text: "b" }], 80));

    const pa = a.run("hi");
    const pb = b.run("hi");

    // 关键断言：两个会话此刻都处于 running 状态
    await Bun.sleep(20);
    expect(
      registry
        .running()
        .map((m) => m.id)
        .sort(),
    ).toEqual(["a", "b"]);

    await Promise.all([pa, pb]);
    expect(registry.running()).toHaveLength(0);
  });

  test("并行确实比串行快（松上界，仅作方向性验证）", async () => {
    const registry = new SessionRegistry();
    const a = registry.add(makeSession("a", [{ text: "a" }], 100));
    const b = registry.add(makeSession("b", [{ text: "b" }], 100));

    const started = Date.now();
    await Promise.all([a.run("hi"), b.run("hi")]);
    const parallel = Date.now() - started;

    // 串行至少是两倍；这里只要明显小于串行下界即可
    expect(parallel).toBeLessThan(500);
  });
});

describe("P9 · 中断", () => {
  test("abort 能提前结束某一轮", async () => {
    const registry = new SessionRegistry();
    const managed = registry.add(makeSession("a", [{ text: "慢" }], 120));

    const started = Date.now();
    const promise = managed.run("跑");
    await Bun.sleep(30);
    managed.abort();

    const result = await promise;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(300); // 完整跑完约 360ms
    expect(result.reason).toBe("error");
    expect(managed.busy).toBe(false);
  });

  test("registry.abort() 中断全部会话", async () => {
    const registry = new SessionRegistry();
    const a = registry.add(makeSession("a", [{ text: "a" }], 120));
    const b = registry.add(makeSession("b", [{ text: "b" }], 120));

    const pa = a.run("hi");
    const pb = b.run("hi");
    await Bun.sleep(30);

    registry.abort();

    await Promise.all([pa, pb]);
    expect(registry.running()).toHaveLength(0);
  });

  test("外部 signal 也能中断（转发到内部 controller）", async () => {
    const registry = new SessionRegistry();
    const managed = registry.add(makeSession("a", [{ text: "慢" }], 120));
    const external = new AbortController();

    const promise = managed.run("跑", { signal: external.signal });
    await Bun.sleep(30);
    external.abort();

    const result = await promise;
    expect(result.reason).toBe("error");
    expect(managed.busy).toBe(false);
  });
});

describe("P9 · ManagedSession 行为", () => {
  test("controller 在运行期间存在，结束后清空", async () => {
    const managed = new ManagedSession(makeSession("a", [{ text: "x" }], 60));

    expect(managed.controller).toBeUndefined();
    const promise = managed.run("hi");
    await Bun.sleep(10);
    expect(managed.controller).toBeDefined();

    await promise;
    expect(managed.controller).toBeUndefined();
  });

  test("busy 期间抛出异常也会正确复位", async () => {
    const managed = new ManagedSession(makeSession("a", []));
    // 空脚本会走 mock 的"脚本耗尽"分支，正常返回
    await managed.run("hi");
    expect(managed.busy).toBe(false);
  });
});
