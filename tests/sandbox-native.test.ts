import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nativeSandboxLibraryPath } from "../src/sandbox/policy.ts";

const repoRoot = resolve(import.meta.dir, "..");
const forkPath = process.env.BUGENT_BUN_BIN ?? resolve(repoRoot, "..", "bun", "build", "release", "bun");
const libraryPath =
  process.env.BUGENT_SANDBOX_LIBRARY ??
  nativeSandboxLibraryPath() ??
  join(repoRoot, "native", "sandbox", "build", "libbugent-sandbox.so");
const canBuild = Bun.which("cc") !== null;
const canRunNative = canBuild && existsSync(forkPath);

beforeAll(() => {
  if (!canRunNative || existsSync(libraryPath)) return;
  const result = Bun.spawnSync(["bun", "run", "build:sandbox"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`build:sandbox failed: ${result.stderr.toString()}`);
  }
});

function runSandboxed(config: Record<string, unknown>, cmd: readonly string[]): {
  exitCode: number | null;
  stdout: string;
  stderr: string;
} {
  const code = `
    const config = JSON.parse(process.env.SANDBOX_CONFIG);
    const cmd = JSON.parse(process.env.SANDBOX_CMD);
    const p = Bun.spawn({
      cmd,
      sandbox: { library: process.env.BUGENT_SANDBOX_LIBRARY, config: JSON.stringify(config) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    process.stdout.write(JSON.stringify({ exitCode, stdout, stderr }));
  `;
  const result = Bun.spawnSync([forkPath, "-e", code], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BUGENT_BUN_BIN: forkPath,
      BUGENT_SANDBOX_LIBRARY: libraryPath,
      SANDBOX_CONFIG: JSON.stringify(config),
      SANDBOX_CMD: JSON.stringify(cmd),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const text = result.stdout.toString().trim();
  if (result.exitCode !== 0 || text.length === 0) {
    throw new Error(
      `sandbox probe failed (exit=${result.exitCode}): ${result.stderr.toString()}\n${text}`,
    );
  }
  return JSON.parse(text) as { exitCode: number | null; stdout: string; stderr: string };
}

describe.skipIf(!canRunNative)("libbugent-sandbox native provider", () => {
  test("allows an explicitly granted file read", () => {
    const dir = mkdtempSync(join(tmpdir(), "bugent-native-"));
    const allowed = join(dir, "allowed.txt");
    writeFileSync(allowed, "allowed-native\n");
    const result = runSandboxed(
      {
        read: [allowed, "/usr"],
        exec: ["/usr"],
        network: "none",
      },
      ["/usr/bin/cat", allowed],
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("allowed-native\n");
  });

  test("denies a path outside the read allowlist", () => {
    const dir = mkdtempSync(join(tmpdir(), "bugent-native-"));
    const allowed = join(dir, "allowed.txt");
    writeFileSync(allowed, "allowed-native\n");
    const result = runSandboxed(
      {
        read: [allowed, "/usr"],
        exec: ["/usr"],
        network: "none",
      },
      ["/usr/bin/cat", "/etc/hostname"],
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/permission denied|Permission denied/i);
  });

  test("network=none blocks socket creation", () => {
    const python = Bun.which("python3");
    if (python === null) return;
    const result = runSandboxed(
      {
        read: ["/usr", "/etc"],
        exec: ["/usr"],
        network: "none",
      },
      [python, "-c", "import socket; socket.socket(); print('NETWORK-OK')"],
    );

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/operation not permitted|EPERM/i);
  });
});
