import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileMcpSandbox,
  compileSandboxPolicy,
  defaultMcpStateDir,
} from "../src/sandbox/policy.ts";

const dirs: string[] = [];

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bugent-policy-"));
  dirs.push(dir);
  return dir;
}

describe("sandbox policy compiler", () => {
  test("normalizes, deduplicates, and canonicalizes explicit grants", async () => {
    const cwd = await tempDir();
    const file = join(cwd, "read.txt");
    await writeFile(file, "hello");
    const config = compileSandboxPolicy({
      kind: "bash",
      cwd,
      read: [file, file, "read.txt"],
      write: [cwd],
      exec: [process.execPath],
      network: "none",
    });

    expect(config.read.filter((path) => path === file)).toHaveLength(1);
    expect(config.write).toContain(cwd);
    expect(config.exec).toContain(process.execPath);
    expect(config.network).toBe("none");
  });

  test("MCP defaults to workspace read, private state write, and no network", async () => {
    const cwd = await tempDir();
    const stateDir = join(cwd, "state");
    const compiled = compileMcpSandbox({
      server: "filesystem",
      cmd: [process.execPath],
      cwd,
      stateDir,
    });

    expect(compiled.config.read).toContain(cwd);
    expect(compiled.config.write).toContain(stateDir);
    expect(compiled.config.write).not.toContain(cwd);
    expect(compiled.config.network).toBe("none");
    expect(compiled.env.HOME).toBe(stateDir);
    expect(compiled.env.TMPDIR).toBe(join(stateDir, "tmp"));
  });

  test("workspace write is opt-in and can be path-scoped", async () => {
    const cwd = await tempDir();
    const allowed = join(cwd, "allowed");
    await writeFile(allowed, "x");
    const compiled = compileMcpSandbox({
      server: "writer",
      cmd: [process.execPath],
      cwd,
      stateDir: join(cwd, "state"),
      workspaceWrite: [allowed],
    });

    expect(compiled.config.write).toContain(allowed);
    expect(compiled.config.write).not.toContain(cwd);
  });

  test("network allowlist fails closed until a proxy/network namespace exists", () => {
    expect(() =>
      compileSandboxPolicy({
        kind: "mcp",
        cwd: process.cwd(),
        network: "allowlist",
      }),
    ).toThrow(/allowlist/);
  });

  test("default state path is server-scoped and sanitized", () => {
    const path = defaultMcpStateDir("server/with spaces");
    expect(path).toContain("server_with_spaces");
    expect(path.endsWith("state")).toBe(true);
  });
});
