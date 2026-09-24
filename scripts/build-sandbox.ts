#!/usr/bin/env bun

import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const source = resolve(repoRoot, "native", "sandbox", "provider.c");
const outputDir = resolve(
  process.env.BUGENT_SANDBOX_OUTPUT ?? resolve(repoRoot, "native", "sandbox", "build"),
);
const output = resolve(outputDir, "libbugent-sandbox.so");

await mkdir(outputDir, { recursive: true });

const cc = process.env.CC ?? "cc";
const result = Bun.spawnSync({
  cmd: [
    cc,
    "-shared",
    "-fPIC",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wl,-z,relro,-z,now",
    "-o",
    output,
    source,
  ],
  cwd: repoRoot,
  stdout: "pipe",
  stderr: "pipe",
});

if (result.exitCode !== 0) {
  throw new Error(
    `${cc} failed (${result.exitCode}):\n${result.stderr.toString()}\n${result.stdout.toString()}`,
  );
}

const info = await stat(output);
console.log(
  JSON.stringify(
    {
      output,
      bytes: info.size,
      source,
    },
    null,
    2,
  ),
);
