/**
 * 回归校准探针 —— tests/../regression-calibration.md 每行一条。
 *
 * 每条探针对应一轮独立测试（首轮 2026-09-29）发现的 bug 的最小复现断言；
 * 修复合入后它们是最快的冒烟单：探针 FAIL = 同类 bug 复发。
 * 新一轮发现的新问题按「症状 → 最小探针 → 规则」追加，不要改旧行。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ANYWHERE, resolveForWrite, resolveReadable } from "../src/tools/paths.ts";
import { planWriteApproval, scanCommand } from "../src/sandbox/command-scan.ts";
import {
  PermissionPolicy,
  globToRegExp,
  type PermissionRequest,
} from "../src/permission/policy.ts";
import { PermissionGate } from "../src/permission/gate.ts";
import { SessionStore } from "../src/store/repository.ts";
import { KeychainCredentialStore } from "../src/store/credentials.ts";
import { bashResourceClaims, createBashTool } from "../src/tools/bash.ts";
import type { CapabilityEscalation, Tool, ToolCtx } from "../src/tools/types.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import {
  APPLY_SUBAGENT_PATCH_TOOL_NAME,
  SPAWN_SUBAGENT_TOOL_NAME,
  WAIT_SUBAGENT_TOOL_NAME,
  createAgentTools,
  type AgentToolsParent,
} from "../src/tools/agent.ts";
import { createInProcessTransport } from "../src/agent/transport.ts";
import type { AgentExecutor } from "../src/agent/supervisor.ts";
import { probeGit, runGit } from "../src/agent/git.ts";
import { Bridge, type ManagedSession, type SessionFactoryOptions } from "../src/runtime/bridge.ts";
import { AgentSession } from "../src/core/session.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import { UI_PROTOCOL_VERSION, type UiEnvelope } from "../src/protocol/types.ts";

const IS_WIN = process.platform === "win32";
const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/* ------------------------------------------------------------------ */
/* 1 · P1-1 跨盘读 / 批准后的跨盘写 / 小写盘符                           */
/* ------------------------------------------------------------------ */

describe("校准 1（P1-1）跨盘路径与大小写", () => {
  test.skipIf(!IS_WIN)("ANYWHERE 哨兵平台无关：跨盘读成功", () => {
    // 曾经：ANYWHERE = sep 在 win32 被 resolve 成当前盘根，"任意读"退化为"本盘读"
    expect(resolveReadable("D:\\bugent", "C:\\Windows\\win.ini", [ANYWHERE])).toBe(
      "C:\\Windows\\win.ini",
    );
  });

  test.skipIf(!IS_WIN)("批准 writeOutside 后跨盘写解析成功", () => {
    // 只解析不落盘；曾经这里抛 PathEscapeError —— 用户批准了仍失败
    expect(resolveForWrite("D:\\bugent", "C:\\bugent-calibration-probe\\f.txt", true)).toBe(
      "C:\\bugent-calibration-probe\\f.txt",
    );
  });

  test.skipIf(!IS_WIN)("小写盘符同目录可读", () => {
    expect(resolveReadable("D:\\bugent", "d:\\bugent\\package.json")).toBe(
      "d:\\bugent\\package.json",
    );
  });
});

/* ------------------------------------------------------------------ */
/* 2 · P1-2 工作区内写被误判为越界                                       */
/* ------------------------------------------------------------------ */

describe("校准 2（P1-2）工作区判定归一化", () => {
  test.skipIf(!IS_WIN)("echo hi > build.log 不判越界、不弹授权", () => {
    const scan = scanCommand("echo hi > build.log", { cwd: "D:\\bugent" });
    expect(scan.outsidePaths).toEqual([]);
    const plan = planWriteApproval(scan, {
      cwd: "D:\\bugent",
      home: "C:\\Users\\probe",
      workspaceWritable: true,
      command: "echo hi > build.log",
    });
    expect(plan).toBeUndefined();
  });

  test.skipIf(!IS_WIN)("小写盘符 cwd 同样判内", () => {
    const scan = scanCommand("echo hi > build.log", { cwd: "d:\\bugent" });
    expect(scan.outsidePaths).toEqual([]);
  });

  test("POSIX 形态语义不回退：越界仍要判出、工作区内仍免问", () => {
    // 这组在任何平台都必须成立 —— 守护词法解析器本身
    const scan = scanCommand("echo hi > /etc/hosts", { cwd: "/work/repo", home: "/home/me" });
    expect(scan.outsidePaths).toEqual(["/etc/hosts"]);
    const inside = scanCommand("echo hi > src/a.ts", { cwd: "/work/repo", home: "/home/me" });
    expect(inside.outsidePaths).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 3 · P2-1 显式 deny 优先级 + "总是允许"字面量                          */
/* ------------------------------------------------------------------ */

function requestOf(tool: string, resource: string): PermissionRequest {
  return { tool, resource, summary: resource };
}

describe("校准 3（P2-1）deny 优先级与规则放大", () => {
  test("运行时'总是允许'压不过构造期 deny", () => {
    const policy = new PermissionPolicy({
      default: "ask",
      rules: [{ tool: "exec", resource: "git push --force*", decision: "deny" }],
    });
    policy.addRule({ tool: "exec", resource: "git push*", decision: "allow" });
    expect(policy.evaluate(requestOf("exec", "git push --force origin main"))).toEqual({
      decision: "deny",
      matched: true,
    });
  });

  test("运行时 allow 仍能压过构造期 ask（'总是允许'的本意）", () => {
    const policy = new PermissionPolicy({
      default: "ask",
      rules: [{ tool: "exec", decision: "ask" }],
    });
    policy.addRule({ tool: "exec", resource: "git status", decision: "allow" });
    expect(policy.evaluate(requestOf("exec", "git status")).decision).toBe("allow");
  });

  test("addRule 按字面量匹配：命令文本里的 * 不放大授权范围", () => {
    const policy = new PermissionPolicy({ default: "ask" });
    policy.addRule({ tool: "exec", resource: "chmod 644 *.log", decision: "allow" });
    // 字面量 `*.log` 不再是通配符 —— 用户只批准了眼前那条命令
    expect(policy.evaluate(requestOf("exec", "chmod 644 debug.log")).decision).toBe("ask");
    expect(policy.evaluate(requestOf("exec", "chmod 644 *.log")).decision).toBe("allow");
  });
});

/* ------------------------------------------------------------------ */
/* 4 · P2-2 verify_commands 过 exec 同一条权限链                          */
/* ------------------------------------------------------------------ */

async function initRepo(): Promise<string> {
  const dir = await tempDir("bugent-calibration-repo-");
  const git = Bun.which("git");
  if (git === null) throw new Error("git unavailable");
  const run = async (args: string[]): Promise<void> => {
    const result = await runGit(args, dir, { binary: git });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  };
  await run(["init"]);
  await run(["config", "user.email", "bugent@example.invalid"]);
  await run(["config", "user.name", "bugent test"]);
  await writeFile(join(dir, "tracked.txt"), "base\n", "utf8");
  await run(["add", "tracked.txt"]);
  await run(["commit", "-m", "initial"]);
  return dir;
}

function parentOf(repo: string): AgentToolsParent {
  return {
    agentId: "main-1",
    rootId: "main-1",
    sessionId: "session-main-1",
    authority: "full",
    capabilities: ["fs.read", "fs.write", "process.exec", "agent.spawn"],
  };
}

describe("校准 4（P2-2）apply_subagent_patch 验证命令受 exec 规则约束", () => {
  test.skipIf(Bun.which("git") === null)("deny 规则 {tool:exec,resource:curl*} 能拦截 verify_commands", async () => {
    const repo = await initRepo();
    const capability = await probeGit(repo);
    const patch = [
      "diff --git a/tracked.txt b/tracked.txt",
      "--- a/tracked.txt",
      "+++ b/tracked.txt",
      "@@ -1 +1 @@",
      "-base",
      "+integrated",
      "",
    ].join("\n");
    const patchDir = await tempDir("bugent-calibration-patch-");
    const patchPath = join(patchDir, "diff.patch");
    await writeFile(patchPath, patch, "utf8");
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(patch);
    const digest = `sha256:${hasher.digest("hex")}`;

    const executor: AgentExecutor = {
      async run(context) {
        return {
          agentId: context.spec.identity.agentId,
          status: "completed",
          summary: "worker complete",
          artifacts: [
            { artifactId: "patch-1", kind: "patch", path: patchPath, digest, mediaType: "text/x-diff" },
          ],
          data: {
            text: "done",
            steps: 1,
            finishReason: "stop",
            baseRevision: capability.head,
            diffHash: digest,
            changedFiles: ["tracked.txt"],
            patchArtifact: patchPath,
            worktreePath: patchDir,
          },
        };
      },
    };
    const transport = createInProcessTransport({ executor });

    // 用户显式禁令：exec 语义的 curl 一律拒绝
    const policy = new PermissionPolicy({
      default: "allow",
      rules: [{ tool: "exec", resource: "curl*", decision: "deny" }],
    });
    const gate = new PermissionGate({ policy, mode: "workspace-write" });
    const registry: ToolRegistry = new (await import("../src/tools/types.ts")).ToolRegistry();
    registry.setGate(gate);

    const tools = new Map(
      createAgentTools({
        transport,
        parent: parentOf(repo),
        cwd: repo,
        verificationRunner: {
          async run() {
            throw new Error("验证命令根本不该被允许执行");
          },
        },
      }).map((tool) => [tool.name, tool] as const),
    );

    const ctx: ToolCtx = {
      cwd: repo,
      signal: new AbortController().signal,
      callId: "call-1",
      sessionId: "session-main-1",
      // loop 注入的同款接线：工具内部嵌入动作走当前闸门
      authorizeAs: (request) => registry.check(request),
    };
    const spawned = (await tools.get(SPAWN_SUBAGENT_TOOL_NAME)!.run(
      { kind: "worker", task: "change" },
      ctx,
    )) as { agent_id: string };
    await tools.get(WAIT_SUBAGENT_TOOL_NAME)!.run({ agent_id: spawned.agent_id }, ctx);

    const apply = tools.get(APPLY_SUBAGENT_PATCH_TOOL_NAME)!;
    await expect(
      apply.run({ agent_id: spawned.agent_id, verify_commands: ["curl --version"] }, ctx),
    ).rejects.toThrow(/验证命令被拒绝/);
    // patch 未应用 —— 拒绝发生在 apply 之前
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("base\n");
    await transport.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* 5 · P3-1 多行命令不绕过 glob 规则                                     */
/* ------------------------------------------------------------------ */

describe("校准 5（P3-1）glob 匹配换行", () => {
  test("git push* 命中换行书写的同一条命令", () => {
    expect(globToRegExp("git push*").test("git push\n--force origin main")).toBe(true);
    expect(globToRegExp("git push*").test("git push --force origin main")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 6-9 · bridge 的四条协议层探针                                          */
/* ------------------------------------------------------------------ */

class WsProbe {
  frames: UiEnvelope[] = [];
  #waiters: { match: (e: UiEnvelope) => boolean; resolve: (e: UiEnvelope) => void }[] = [];
  #ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (ev) => {
      const env = JSON.parse(String(ev.data)) as UiEnvelope;
      this.frames.push(env);
      const idx = this.#waiters.findIndex((w) => w.match(env));
      if (idx !== -1) this.#waiters.splice(idx, 1)[0]!.resolve(env);
    };
  }

  static async connect(url: string): Promise<WsProbe> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("connect failed"));
    });
    return new WsProbe(ws);
  }

  send(type: string, payload: Record<string, unknown> = {}, sessionId?: string): string {
    const id = `m-${Math.random().toString(36).slice(2, 10)}`;
    this.#ws.send(
      JSON.stringify({
        v: UI_PROTOCOL_VERSION,
        id,
        kind: "cmd",
        type,
        ...(sessionId ? { sessionId } : {}),
        payload,
        ts: Date.now(),
      }),
    );
    return id;
  }

  async cmd(type: string, payload: Record<string, unknown> = {}, sessionId?: string): Promise<UiEnvelope> {
    const id = this.send(type, payload, sessionId);
    return this.waitFor((e) => e.kind === "reply" && e.id === id);
  }

  waitFor(match: (e: UiEnvelope) => boolean, timeoutMs = 5000): Promise<UiEnvelope> {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitFor 超时")), timeoutMs);
      this.#waiters.push({
        match,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  }

  close(): void {
    this.#ws.close();
  }
}

const HELLO = { token: "", client: "webui" as const, protocolVersions: [1] };

async function startBridge(
  tool: Tool,
  policyRules?: { tool: string; decision: "ask" | "deny" | "allow" }[],
): Promise<{ bridge: Bridge; url: string; token: string }> {
  const bridge = new Bridge({
    createSession: ({ sessionId }: SessionFactoryOptions): ManagedSession => {
      const registry = new ToolRegistry();
      registry.register(tool);
      return {
        session: new AgentSession({
          id: sessionId,
          system: "SYS",
          client: createMockClient({ script: [{ text: "调用", toolCalls: [{ id: "c1", name: tool.name, args: {} }] }, { text: "完" }] }),
          model: "test-model",
          now: () => 0,
        }),
        registry,
        policy: new PermissionPolicy({ default: "allow", ...(policyRules ? { rules: policyRules } : {}) }),
        model: "test-model",
      };
    },
  });
  const info = await bridge.start();
  return { bridge, url: info.url, token: info.token };
}

/** run 时向用户申请一次能力授权的工具。 */
function capabilityAwaitTool(): Tool {
  return {
    name: "calibration_cap_tool",
    description: "trigger capability round-trip",
    parameters: { type: "object", properties: {} },
    describe: () => ({ resource: "cap", summary: "cap" }),
    async run(_input, ctx) {
      const outcome = await ctx.onRequestCapability?.({
        capability: { network: true },
        reason: "校准探针：申请联网",
      });
      return `cap:${outcome ?? "none"}`;
    },
  };
}

describe("校准 6（P3-2）capability 往返与 permission 分离", () => {
  test("permission.always 用在 capability 上不产生死规则", async () => {
    const { bridge, url, token } = await startBridge(capabilityAwaitTool());
    const client = await WsProbe.connect(url);
    await client.cmd("hello", { ...HELLO, token });
    const created = await client.cmd("session.new", {});
    const sessionId = String(created.payload.sessionId);
    await client.cmd("session.attach", { sessionId }, sessionId);

    await client.cmd("turn.send", { text: "go" }, sessionId);
    const req = await client.waitFor((e) => e.kind === "evt" && e.type === "capability.request");
    const requestId = String((req.payload as { requestId: string }).requestId);

    const bs = bridge.getSession(sessionId)!;
    const before = bs.policy.ruleCount;
    const always = await client.cmd("permission.always", { requestId }, sessionId);
    expect(always.payload.ok).toBe(false);
    expect(always.payload.code).toBe("always_not_supported");
    expect(bs.policy.ruleCount).toBe(before); // 没有存出 resource:"" 的死规则

    // 正常裁决通道仍然可用
    const resolved = await client.cmd("permission.resolve", { requestId, outcome: "approved" }, sessionId);
    expect(resolved.payload.ok).toBe(true);
    const done = await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done");
    expect(done.payload.turnId).toBeString();
    client.close();
    bridge.stop();
  });
});

describe("校准 7（P2-3）会话命令校验 attach 归属", () => {
  test("未 attach 的连接不能驱动别人的会话", async () => {
    const { bridge, url, token } = await startBridge(capabilityAwaitTool());
    const owner = await WsProbe.connect(url);
    await owner.cmd("hello", { ...HELLO, token });
    const created = await owner.cmd("session.new", {});
    const sessionId = String(created.payload.sessionId);
    await owner.cmd("session.attach", { sessionId }, sessionId);

    const stranger = await WsProbe.connect(url);
    await stranger.cmd("hello", { ...HELLO, token });

    // turn.send / turn.cancel / session.close 都要 not_attached
    const send = await stranger.cmd("turn.send", { text: "hi" }, sessionId);
    expect(send.payload.ok).toBe(false);
    expect(send.payload.code).toBe("not_attached");
    const cancel = await stranger.cmd("turn.cancel", {}, sessionId);
    expect(cancel.payload.ok).toBe(false);
    expect(cancel.payload.code).toBe("not_attached");
    const close = await stranger.cmd("session.close", { sessionId }, sessionId);
    expect(close.payload.ok).toBe(false);
    expect(close.payload.code).toBe("not_attached");
    expect(bridge.getSession(sessionId)).toBeDefined(); // 会话还活着

    // 跨连接裁决挂起弹窗必须被拒：owner 的会话里有一个真实挂起的 capability
    await owner.cmd("turn.send", { text: "go" }, sessionId);
    const req = await owner.waitFor((e) => e.kind === "evt" && e.type === "capability.request");
    const requestId = String((req.payload as { requestId: string }).requestId);
    const hijack = await stranger.cmd("permission.resolve", { requestId, outcome: "approved" }, sessionId);
    expect(hijack.payload.ok).toBe(false);
    expect(hijack.payload.code).toBe("no_request");
    // 挂起仍未被裁决 —— owner 自己才答得了
    const resolved = await owner.cmd("permission.resolve", { requestId, outcome: "approved" }, sessionId);
    expect(resolved.payload.ok).toBe(true);
    stranger.close();
    owner.close();
    bridge.stop();
  });
});

describe("校准 8（P3-3）静态伺服的前缀兄弟目录", () => {
  test("dist-backup 不可经 ../ 前缀命中", async () => {
    // root 与兄弟目录必须同父：root=<base>/dist，兄弟=<base>/dist-backup
    const base = await tempDir("bugent-calibration-static-");
    const root = join(base, "dist");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "app.js"), "console.log('app')");
    await writeFile(join(root, "index.html"), "<html>index</html>");
    const sibling = join(base, "dist-backup");
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "secret.txt"), "TOP-SECRET");

    const bridge = new Bridge({ staticDir: root });
    const info = await bridge.start();

    const ok = await fetch(`http://127.0.0.1:${info.port}/app.js`);
    expect(await ok.text()).toBe("console.log('app')");

    // ../dist-backup/secret.txt 解析出兄弟目录路径 —— 曾经裸 startsWith(root) 放行
    const escaped = await fetch(`http://127.0.0.1:${info.port}/%2e%2e/dist-backup/secret.txt`);
    const body = await escaped.text();
    expect(body).not.toContain("TOP-SECRET");
    bridge.stop();
  });
});

describe("校准 9（P3-4）权限往返超时收口", () => {
  test("UI 不应答时按授权窗口 timeout，turn 收尾", async () => {
    process.env.BUGENT_AUTHORIZATION_TIMEOUT_MS = "400";
    try {
      const { bridge, url, token } = await startBridge(capabilityAwaitTool());
      const client = await WsProbe.connect(url);
      await client.cmd("hello", { ...HELLO, token });
      const created = await client.cmd("session.new", {});
      const sessionId = String(created.payload.sessionId);
      await client.cmd("session.attach", { sessionId }, sessionId);

      await client.cmd("turn.send", { text: "go" }, sessionId);
      await client.waitFor((e) => e.kind === "evt" && e.type === "capability.request");
      // 刻意不应答 —— 修复前 turn 永久挂起
      const done = await client.waitFor((e) => e.kind === "evt" && e.type === "turn.done", 3000);
      expect(done.payload.turnId).toBeString();
      client.close();
      bridge.stop();
    } finally {
      process.env.BUGENT_AUTHORIZATION_TIMEOUT_MS = "";
    }
  });
});

/* ------------------------------------------------------------------ */
/* 10 · P3-5 macOS keychain delete 带 account 维度                       */
/* ------------------------------------------------------------------ */

describe("校准 10（P3-5）keychain delete 按 (sessionId, providerId) 删", () => {
  test("darwin delete 的 argv 必须带 -a account", async () => {
    const calls: string[][] = [];
    const store = new KeychainCredentialStore("darwin", async (argv) => {
      calls.push([...argv]);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await store.delete("s1", "openai");
    const deleteArgv = calls[0]!;
    expect(deleteArgv.slice(0, 3)).toEqual(["security", "delete-generic-password", "-s"]);
    const accountFlag = deleteArgv.indexOf("-a");
    expect(accountFlag).toBeGreaterThan(-1);
    // 按 (sessionId, providerId) 二元组全维度匹配 —— 漏掉 -a 会误删同 service 的其它条目
    expect(deleteArgv[accountFlag + 1]).toBe("s1:openai");

    await store.get("s2", "openai");
    expect(calls[1]!.join(" ")).toContain("-a s2:openai");
  });
});

/* ------------------------------------------------------------------ */
/* 11 · P3-6 provider 配置持久化的凭据卫生                                */
/* ------------------------------------------------------------------ */

describe("校准 11（P3-6）session_providers 不落凭据", () => {
  test("headers / tls.key / tls.passphrase / apiKey 都不进 SQLite", () => {
    const store = new SessionStore({ path: ":memory:" });
    store.createSession({
      id: "s1",
      createdAt: 0,
      updatedAt: 0,
      model: "m",
      systemPrompt: "SYS",
    });
    store.setProviderConfig("s1", {
      id: "gw",
      endpoint: "openai-chat",
      headers: { Authorization: "Bearer sk-secret" },
      tls: { rejectUnauthorized: true, key: "PRIVATE", passphrase: "secret" },
    } as never);

    const row = store.db
      .query("SELECT config FROM session_providers WHERE session_id = 's1'")
      .get() as { config: string };
    expect(row.config).not.toContain("sk-secret");
    expect(row.config).not.toContain("PRIVATE");
    expect(row.config).not.toContain("secret");
    expect(row.config).not.toContain("Authorization");
    const parsed = JSON.parse(row.config) as { headers?: unknown; tls?: { key?: string; passphrase?: string } };
    expect(parsed.headers).toBeUndefined();
    expect(parsed.tls?.key).toBeUndefined();
    expect(parsed.tls?.passphrase).toBeUndefined();
    store.close();
  });
});

/* ------------------------------------------------------------------ */
/* 12 · P3-7 sed 脚本体内的写原语持写锁                                   */
/* ------------------------------------------------------------------ */

describe("校准 12（P3-7）sed w 命令持写锁", () => {
  test("sed 's/a/b/w out' input 拿 workspace 写锁", () => {
    const claims = bashResourceClaims("sed 's/a/b/w out.txt' input.txt");
    expect(claims[0]?.access).toBe("write");
  });

  test("普通只读 sed 不受影响", () => {
    expect(bashResourceClaims("sed s/a/b/ input.txt")[0]?.access).toBe("read");
    expect(bashResourceClaims("sed -n 1p input.txt")[0]?.access).toBe("read");
  });
});

/* ------------------------------------------------------------------ */
/* 13 · P3-8 联网批准的幂等                                              */
/* ------------------------------------------------------------------ */

function failingRunner(): {
  runner: { run(): Promise<Record<string, unknown>> };
  runs: () => number;
} {
  let count = 0;
  return {
    runner: {
      async run() {
        count += 1;
        return {
          stdout: "",
          stderr: "curl: (6) Could not resolve host: example.invalid",
          exitCode: 6,
          timedOut: false,
          aborted: false,
          truncated: false,
          durationMs: 1,
        };
      },
    },
    runs: () => count,
  };
}

describe("校准 13（P3-8）网络授权幂等", () => {
  test("静态识别出联网并获批后，重跑失败不再弹第二次", async () => {
    const { runner, runs } = failingRunner();
    const tool = createBashTool(runner as unknown as Parameters<typeof createBashTool>[0], {
      networkBlocked: true,
    });
    const asks: CapabilityEscalation[] = [];
    const ctx: ToolCtx = {
      cwd: ".",
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "s",
      onRequestCapability: async (escalation) => {
        asks.push(escalation);
        return "approved";
      },
    };
    await tool.run({ command: "curl https://example.invalid" }, ctx);
    expect(runs()).toBe(1); // 不重跑同一条注定失败的命令
    expect(asks).toHaveLength(1); // 只有静态识别的那一次授权
  });

  test("兜底路径批准带网重跑后仍失败，也不再问第二次", async () => {
    // 命令本身不触发联网扫描（node 不是 NETWORK_COMMANDS），跑挂后走兜底
    const { runner, runs } = failingRunner();
    const tool = createBashTool(runner as unknown as Parameters<typeof createBashTool>[0], {
      networkBlocked: true,
    });
    const asks: CapabilityEscalation[] = [];
    const ctx: ToolCtx = {
      cwd: ".",
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "s",
      onRequestCapability: async (escalation) => {
        asks.push(escalation);
        return "approved";
      },
    };
    await tool.run({ command: "node -e \"fetch('http://example.invalid')\"" }, ctx);
    expect(runs()).toBe(2); // 批准后确实带网重跑了一次
    expect(asks).toHaveLength(1); // 重跑仍失败 → 如实回传，不再打扰
  });
});
