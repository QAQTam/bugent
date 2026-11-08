/**
 * TUI 能力授权的审计接线（BUG-023 收尾）。
 *
 * bash 的能力授权（联网 / 写工作区外）绕过 gate.check，CLI/headless 路径在
 * index.ts 组合层补记 capability 事件，但 TUI 这条链路此前全程不落审计 ——
 * 全树 `.capability(` 只有 index.ts 一处调用。这条用例用真实 TuiApp +
 * 真实 AuditTrail 钉住接线：授权窗口到点（timeout）也必须留下审计记录。
 *
 * 不走真实弹窗按键：把授权窗口压到 30ms，让 withAuthorizationWindow 以
 * "timeout" 收尾 —— 这本身就是三态里最容易被漏记的一态。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../src/tools/types.ts";
import { TuiApp } from "../src/tui/app.ts";
import { AgentSession } from "../src/core/session.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import { AuditTrail } from "../src/store/audit.ts";
import { SessionStore } from "../src/store/repository.ts";

const dirs: string[] = [];
const stores: SessionStore[] = [];

afterAll(async () => {
  for (const store of stores) store.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function makeStore(): Promise<SessionStore> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-tui-audit-"));
  dirs.push(dir);
  const store = new SessionStore({ path: join(dir, "bugent.db") });
  stores.push(store);
  return store;
}

describe("TUI 能力授权审计接线", () => {
  test("requestCapability 超时收尾后审计流水里有 capability 事件", async () => {
    const store = await makeStore();
    const session = new AgentSession({
      id: "s-cap-audit",
      system: "SYS",
      client: createMockClient({ script: [] }),
      model: "test-model",
    });
    store.createSession({
      id: session.id,
      createdAt: 1000,
      updatedAt: 1000,
      model: "test-model",
      providerId: "mock",
      systemPrompt: "SYS",
      cwd: "/tmp",
    });
    const audit = new AuditTrail({
      store,
      sessionId: () => session.id,
      turn: () => session.turn,
    });
    const app = new TuiApp({
      session,
      tools: new ToolRegistry(),
      cwd: "/tmp",
      audit,
      authorizationTimeoutMs: 30,
    });

    const outcome = await app.requestCapability({
      capability: { network: true },
      reason: "测试：沙箱断网下请求联网",
    });

    expect(outcome).toBe("timeout");
    const events = store.listEvents(session.id).filter((e) => e.kind === "capability");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      capability: { network: true },
      reason: "测试：沙箱断网下请求联网",
      outcome: "timeout",
    });
  });
});
