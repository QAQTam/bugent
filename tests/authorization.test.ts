import { describe, expect, test } from "bun:test";
import { StdinPrompter } from "../src/permission/prompt.ts";
import {
  AUTHORIZATION_DENIED,
  AUTHORIZATION_TIMED_OUT,
  AUTHORIZATION_TIMEOUT_MS,
  describeOutcome,
  formatCountdown,
  isApproved,
  withAuthorizationWindow,
} from "../src/permission/authorization.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("授权窗口 · 三态", () => {
  test("用户批准 -> approved", async () => {
    const outcome = await withAuthorizationWindow({
      timeoutMs: 1000,
      request: async () => true,
    });
    expect(outcome).toBe("approved");
    expect(isApproved(outcome)).toBe(true);
  });

  test("用户拒绝 -> denied", async () => {
    const outcome = await withAuthorizationWindow({
      timeoutMs: 1000,
      request: async () => false,
    });
    expect(outcome).toBe("denied");
    expect(isApproved(outcome)).toBe(false);
  });

  test("窗口到点 -> timeout，并且 abort 掉输入通道", async () => {
    let aborted = false;
    const outcome = await withAuthorizationWindow({
      timeoutMs: 30,
      request: (signal) =>
        new Promise<boolean>((resolve) => {
          // 模拟"用户走开了"：永远不回答，只观察 signal。
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(false);
          });
        }),
    });
    expect(outcome).toBe("timeout");
    expect(aborted).toBe(true);
  });

  test("超时后用户才点批准 —— 仍然算超时（先到先得）", async () => {
    let release!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const window = withAuthorizationWindow({ timeoutMs: 20, request: () => pending });
    await sleep(40);
    release(true);
    expect(await window).toBe("timeout");
  });

  test("超时前用户先批准 —— 批准生效，计时器不覆盖它", async () => {
    const outcome = await withAuthorizationWindow({ timeoutMs: 5000, request: async () => true });
    expect(outcome).toBe("approved");
  });

  test("超时不等于批准：默认方向永远是拒绝", async () => {
    const outcome = await withAuthorizationWindow({
      timeoutMs: 20,
      request: () => new Promise<boolean>(() => {}),
    });
    expect(outcome).not.toBe("approved");
  });
});

describe("授权窗口 · 倒计时", () => {
  test("立即回调一次满额，之后每秒回调", async () => {
    const seen: number[] = [];
    const outcome = await withAuthorizationWindow({
      timeoutMs: 2100,
      onTick: (remaining) => seen.push(remaining),
      request: () => new Promise<boolean>(() => {}),
    });
    expect(outcome).toBe("timeout");
    expect(seen[0]).toBe(2100);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    // 剩余时间是递减的，不会出现回弹
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!).toBeLessThanOrEqual(seen[i - 1]!);
    }
  });

  test("批准之后不再回调 —— 计时器随窗口一起收掉", async () => {
    const seen: number[] = [];
    await withAuthorizationWindow({
      timeoutMs: 120,
      onTick: (remaining) => seen.push(remaining),
      request: async () => true,
    });
    const afterApprove = seen.length;
    await sleep(80);
    expect(seen.length).toBe(afterApprove);
  });
});

describe("授权窗口 · 异常不被吞掉", () => {
  test("request 抛错时窗口 reject，而不是悄悄转成 denied", async () => {
    const window = withAuthorizationWindow({
      timeoutMs: 5000,
      request: async () => {
        throw new Error("输入通道坏了");
      },
    });
    await expect(window).rejects.toThrow("输入通道坏了");
  });
});

describe("回传文案", () => {
  test("拒绝与超时是可区分的两种结论", () => {
    expect(describeOutcome("denied")).toBe(AUTHORIZATION_DENIED);
    expect(describeOutcome("timeout")).toContain(AUTHORIZATION_TIMED_OUT);
    expect(describeOutcome("timeout")).toContain("授权窗口内未收到确认");
    expect(describeOutcome("approved")).toBeUndefined();
  });

  test("倒计时文案向上取整，不显示 0s 之后还挂着", () => {
    expect(formatCountdown(60_000)).toBe("还剩 60s");
    expect(formatCountdown(46_400)).toBe("还剩 47s");
    expect(formatCountdown(1)).toBe("还剩 1s");
    expect(formatCountdown(0)).toBe("还剩 0s");
    expect(formatCountdown(-5)).toBe("还剩 0s");
  });

  test("窗口长度是 60 秒", () => {
    expect(AUTHORIZATION_TIMEOUT_MS).toBe(60_000);
  });
});

describe("CLI 没有终端时不干等", () => {
  const request = { tool: "bash", resource: "x", summary: "执行命令：x" };

  test("stdin 不是 TTY -> 立即拒绝，不走 60 秒窗口", async () => {
    const prompter = new StdinPrompter({ interactive: false, timeoutMs: 60_000 });
    const started = Date.now();
    expect(await prompter.ask(request)).toBe("denied");
    // 关键：不能等满窗口。无人应答时等待只是纯延迟。
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("能力授权同理", async () => {
    const prompter = new StdinPrompter({ interactive: false });
    const started = Date.now();
    const outcome = await prompter.confirmCapability({ capability: { network: true }, reason: "要联网" });
    expect(outcome).toBe("denied");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
