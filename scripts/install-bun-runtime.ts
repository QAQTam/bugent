#!/usr/bin/env bun
/**
 * Install the Bugent Bun fork for this checkout.
 *
 * Default: copy the binary/native provider into runtime/bun/.
 * --global: additionally back up the current ~/.bun/bin/bun and replace it.
 */

import { chmod, copyFile, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface Options {
  global: boolean;
  forkDir: string;
  profile: "release" | "debug";
  binary?: string;
}

function parseArgs(argv: string[]): Options {
  const repoRoot = resolve(import.meta.dir, "..");
  let global = false;
  let profile: Options["profile"] = "release";
  let forkDir = resolve(process.env.BUGENT_BUN_FORK ?? join(repoRoot, "..", "bun"));
  let binary: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--global") {
      global = true;
    } else if (arg === "--debug") {
      profile = "debug";
    } else if (arg === "--release") {
      profile = "release";
    } else if (arg.startsWith("--fork=")) {
      forkDir = resolve(arg.slice("--fork=".length));
    } else if (arg.startsWith("--binary=")) {
      binary = resolve(arg.slice("--binary=".length));
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { global, forkDir, profile, ...(binary !== undefined ? { binary } : {}) };
}

function run(command: readonly string[]): { stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: command,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

async function sha256(path: string): Promise<string> {
  const bytes = await readFile(path);
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function copyExecutable(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  await copyFile(source, temporary);
  await chmod(temporary, 0o755);
  await rename(temporary, destination);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(import.meta.dir, "..");
  const binaryName = options.profile === "debug" ? "bun-debug" : "bun";
  const sourceBinary =
    options.binary ?? resolve(options.forkDir, "build", options.profile, binaryName);
  if (!existsSync(sourceBinary)) {
    throw new Error(`找不到 Bun fork 二进制：${sourceBinary}`);
  }
  const sourceInfo = await stat(sourceBinary);
  if (!sourceInfo.isFile()) throw new Error(`Bun fork 路径不是文件：${sourceBinary}`);

  const version = run([sourceBinary, "--version"]).stdout;
  const revision = run(["git", "-C", options.forkDir, "rev-parse", "HEAD"]).stdout;

  const sandboxBuild = Bun.spawnSync({
    cmd: [process.execPath, "run", resolve(repoRoot, "scripts", "build-sandbox.ts")],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (sandboxBuild.exitCode !== 0) {
    throw new Error(
      `native sandbox build failed (${sandboxBuild.exitCode}):\n${sandboxBuild.stderr.toString()}`,
    );
  }

  const runtimeRoot = resolve(repoRoot, "runtime", "bun");
  const installedBinary = join(runtimeRoot, "bin", "bugent-bun");
  const installedLibrary = join(runtimeRoot, "lib", "libbugent-sandbox.so");
  const builtLibrary = resolve(repoRoot, "native", "sandbox", "build", "libbugent-sandbox.so");
  const sourceHeader = resolve(options.forkDir, "src", "spawn", "sandbox_abi.h");
  const installedHeader = join(runtimeRoot, "include", "bun_spawn_sandbox.h");

  await copyExecutable(sourceBinary, installedBinary);
  await mkdir(dirname(installedLibrary), { recursive: true });
  await copyFile(builtLibrary, installedLibrary);
  await mkdir(dirname(installedHeader), { recursive: true });
  await copyFile(sourceHeader, installedHeader);

  const metadata = {
    version,
    revision,
    profile: options.profile,
    platform: process.platform,
    arch: process.arch,
    binary: "bin/bugent-bun",
    binarySha256: await sha256(installedBinary),
    sandboxLibrary: "lib/libbugent-sandbox.so",
    sandboxSha256: await sha256(installedLibrary),
    installedAt: new Date().toISOString(),
  };  await writeFile(
    join(runtimeRoot, "runtime.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );

  let globalBinary: string | undefined;
  let backupBinary: string | undefined;
  if (options.global) {
    const which = Bun.which("bun");
    const binDir = which === null ? join(process.env.HOME ?? "", ".bun", "bin") : dirname(which);
    await mkdir(binDir, { recursive: true });
    globalBinary = join(binDir, "bun");
    if (existsSync(globalBinary)) {
      const currentHash = await sha256(globalBinary);
      if (currentHash !== metadata.binarySha256) {
        const currentVersion = run([globalBinary, "--version"]).stdout;
        backupBinary = join(binDir, `bun-upstream-${currentVersion}`);
        if (!existsSync(backupBinary)) await copyFile(globalBinary, backupBinary);
        await chmod(backupBinary, 0o755);
      }
    }
    await copyExecutable(installedBinary, globalBinary);

    const alias = join(binDir, "bugent-bun");
    try {
      await unlink(alias);
    } catch {
      // Alias did not exist.
    }
    try {
      await symlink(basename(globalBinary), alias);
    } catch (error) {
      throw new Error(`无法创建 bugent-bun alias ${alias}: ${String(error)}`);
    }
  }

  console.log(
    JSON.stringify(
      {
        installed: installedBinary,
        sandboxLibrary: installedLibrary,
        version,
        revision,
        global: globalBinary,
        backup: backupBinary,
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
