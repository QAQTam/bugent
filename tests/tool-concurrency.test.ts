import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTurn } from "../src/core/loop.ts";
import { storedText } from "../src/core/message.ts";
import { AgentSession } from "../src/core/session.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";
import { bashResourceClaims, createBashTool, createShellRunner } from "../src/tools/bash.ts";
import { createEditFileTool } from "../src/tools/files.ts";
import { ResourceLockManager } from "../src/tools/locks.ts";
import { ToolRegistry, type Tool } from "../src/tools/types.ts";

function makeSession(script: Parameters<typeof createMockClient>[0]["script"]) {
  return new AgentSession({
    id: "tool-concurrency",
    system: "SYS",
    client: createMockClient({ script }),
    model: "test-model",
    now: () => 1,
  });
}

function slowTool(
  name: string,
  delayMs: number,
  log: string[],
  active: { current: number; max: number },
  resources?: Tool<{ value: string }, string>["resources"],
): Tool<{ value: string }, string> {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: { value: { type: "string" } } },
    ...(resources !== undefined ? { resources } : {}),
    describe: () => ({ resource: name, summary: name }),
    async run(input) {
      log.push(`${name}:start:${input.value}`);
      active.current += 1;
      active.max = Math.max(active.max, active.current);
      await Bun.sleep(delayMs);
      active.current -= 1;
      log.push(`${name}:end:${input.value}`);
      return `${name}:${input.value}`;
    },
  };
}

function fileResources(path: string) {
  return () => [{ key: `workspace/${path}`, access: "write" as const }];
}

describe("P4 · 并发工具与资源锁", () => {
  test("不同资源的工具真正并行执行", async () => {
    const log: string[] = [];
    const active = { current: 0, max: 0 };
    const session = makeSession([
      {
        toolCalls: [
          { id: "c1", name: "a", args: { value: "one" } },
          { id: "c2", name: "b", args: { value: "two" } },
        ],
      },
      { text: "done" },
    ]);
    session.appendUser("run");

    const registry = new ToolRegistry()
      .register(slowTool("a", 60, log, active, fileResources("a.txt")))
      .register(slowTool("b", 60, log, active, fileResources("b.txt")));

    await runTurn(session, { tools: registry, cwd: "/tmp" });

    expect(active.max).toBe(2);
    expect(log.slice(0, 2).sort()).toEqual(["a:start:one", "b:start:two"]);
    const tools = session.messages.filter((message) => message.role === "tool");
    expect(tools.map((message) => message.toolCallId)).toEqual(["c1", "c2"]);
    expect(tools.map(storedText)).toEqual(["a:one", "b:two"]);
  });

  test("同一文件写锁让 edit 类工具串行", async () => {
    const log: string[] = [];
    const active = { current: 0, max: 0 };
    const session = makeSession([
      {
        toolCalls: [
          { id: "c1", name: "edit_a", args: { value: "one" } },
          { id: "c2", name: "edit_b", args: { value: "two" } },
        ],
      },
      { text: "done" },
    ]);
    session.appendUser("run");

    const registry = new ToolRegistry()
      .register(slowTool("edit_a", 30, log, active, fileResources("same.txt")))
      .register(slowTool("edit_b", 5, log, active, fileResources("same.txt")));

    await runTurn(session, { tools: registry, cwd: "/tmp" });

    expect(active.max).toBe(1);
    expect(log).toEqual([
      "edit_a:start:one",
      "edit_a:end:one",
      "edit_b:start:two",
      "edit_b:end:two",
    ]);
  });

  test("workspace 写锁与具体文件写锁重叠：edit_file 与 python 类命令串行", async () => {
    const log: string[] = [];
    const active = { current: 0, max: 0 };
    const session = makeSession([
      {
        toolCalls: [
          { id: "c1", name: "edit_file", args: { value: "edit" } },
          { id: "c2", name: "python", args: { value: "python" } },
        ],
      },
      { text: "done" },
    ]);
    session.appendUser("run");

    const registry = new ToolRegistry()
      .register(slowTool("edit_file", 30, log, active, fileResources("same.txt")))
      .register(
        slowTool("python", 5, log, active, () => [{ key: "workspace", access: "write" as const }]),
      );

    await runTurn(session, { tools: registry, cwd: "/tmp" });

    expect(active.max).toBe(1);
    expect(log).toEqual([
      "edit_file:start:edit",
      "edit_file:end:edit",
      "python:start:python",
      "python:end:python",
    ]);
  });

  test("edit_file 与 python 修改同一文件时通过 workspace 写锁串行", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bugent-concurrency-"));
    try {
      await writeFile(join(cwd, "same.txt"), "hello\n", "utf8");
      const session = makeSession([
        {
          toolCalls: [
            {
              id: "c1",
              name: "edit_file",
              args: { path: "same.txt", old_string: "hello", new_string: "from-edit" },
            },
            {
              id: "c2",
              name: "bash",
              args: {
                command:
                  "python3 -c \"from pathlib import Path; p=Path('same.txt'); p.write_text(p.read_text() + 'from-python\\\\n')\"",
              },
            },
          ],
        },
        { text: "done" },
      ]);
      session.appendUser("run");

      const registry = new ToolRegistry()
        .register(createEditFileTool())
        .register(createBashTool(createShellRunner()));

      await runTurn(session, { tools: registry, cwd });

      expect(await readFile(join(cwd, "same.txt"), "utf8")).toBe("from-edit\nfrom-python\n");
      expect(
        session.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId),
      ).toEqual(["c1", "c2"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("结果乱序完成时仍按 tool_calls 顺序落库", async () => {
    const log: string[] = [];
    const active = { current: 0, max: 0 };
    const session = makeSession([
      {
        toolCalls: [
          { id: "c1", name: "slow", args: { value: "one" } },
          { id: "c2", name: "fast", args: { value: "two" } },
        ],
      },
      { text: "done" },
    ]);
    session.appendUser("run");

    const registry = new ToolRegistry()
      .register(slowTool("slow", 60, log, active, fileResources("a.txt")))
      .register(slowTool("fast", 5, log, active, fileResources("b.txt")));

    await runTurn(session, { tools: registry, cwd: "/tmp" });

    expect(log).toEqual(["slow:start:one", "fast:start:two", "fast:end:two", "slow:end:one"]);
    const tools = session.messages.filter((message) => message.role === "tool");
    expect(tools.map((message) => message.toolCallId)).toEqual(["c1", "c2"]);
    expect(tools.map((message) => message.msgid)).toEqual([5, 6]);
  });
});

describe("P4 · bash 资源分类", () => {
  test("只读命令拿 workspace 读锁，不拿写锁", () => {
    expect(bashResourceClaims("ls -la")).toEqual([{ key: "workspace", access: "read" }]);
    expect(bashResourceClaims("cat a.ts | rg foo")).toEqual([{ key: "workspace", access: "read" }]);
    expect(bashResourceClaims("git status --short")).toEqual([{ key: "workspace", access: "read" }]);
    expect(bashResourceClaims("git diff --stat")).toEqual([{ key: "workspace", access: "read" }]);
  });

  test("python / sed -i / 重定向 / 会写 git 命令拿 workspace 写锁", () => {
    expect(bashResourceClaims("python -c \"open('a','w').write('x')\"")).toEqual([
      { key: "workspace", access: "write" },
    ]);
    expect(bashResourceClaims("sed -i 's/a/b/' a.ts")).toEqual([
      { key: "workspace", access: "write" },
    ]);
    expect(bashResourceClaims("sed -i.bak 's/a/b/' a.ts")).toEqual([
      { key: "workspace", access: "write" },
    ]);
    expect(bashResourceClaims("sed -ni 's/a/b/p' a.ts")).toEqual([
      { key: "workspace", access: "write" },
    ]);
    expect(bashResourceClaims("echo hi > a.txt")).toEqual([
      { key: "workspace", access: "write" },
    ]);
    expect(bashResourceClaims("git apply patch.diff")).toEqual([
      { key: "workspace", access: "write" },
    ]);
  });
});

describe("P4 · ResourceLockManager", () => {
  test("同文件写锁互斥，不同文件写锁可同时持有", async () => {
    const locks = new ResourceLockManager();
    const releaseA = await locks.acquire([{ key: "workspace/a.txt", access: "write" }]);
    const releaseB = await locks.acquire([{ key: "workspace/b.txt", access: "write" }]);

    let sameFileGranted = false;
    const sameFile = locks.acquire([{ key: "workspace/a.txt", access: "write" }]).then((release) => {
      sameFileGranted = true;
      release();
    });

    await Bun.sleep(10);
    expect(sameFileGranted).toBe(false);

    releaseA();
    await sameFile;
    expect(sameFileGranted).toBe(true);
    releaseB();
  });

  test("workspace 写锁与任意文件写锁冲突", async () => {
    const locks = new ResourceLockManager();
    const releaseWorkspace = await locks.acquire([{ key: "workspace", access: "write" }]);

    let fileGranted = false;
    const fileLock = locks.acquire([{ key: "workspace/a.txt", access: "write" }]).then((release) => {
      fileGranted = true;
      release();
    });

    await Bun.sleep(10);
    expect(fileGranted).toBe(false);

    releaseWorkspace();
    await fileLock;
    expect(fileGranted).toBe(true);
  });

  test("等待锁时 abort 会取消排队请求", async () => {
    const locks = new ResourceLockManager();
    const release = await locks.acquire([{ key: "workspace/a.txt", access: "write" }]);
    const controller = new AbortController();
    const waiting = locks.acquire([{ key: "workspace/a.txt", access: "write" }], controller.signal);

    controller.abort();
    await expect(waiting).rejects.toThrow("等待工具资源锁时被取消");
    release();
  });
});
