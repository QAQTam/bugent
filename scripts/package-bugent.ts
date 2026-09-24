#!/usr/bin/env bun
/**
 * Build the standalone Bugent 0.0.0 executable.
 *
 * The output embeds the system prompt and native sandbox provider. At runtime
 * the provider is materialized into ~/.bugent/runtime/<version>/lib because
 * dlopen cannot read Bun's /$bunfs virtual filesystem.
 */

import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assertBugentBunRuntime } from "../runtime/bun/src/index.ts";

const repoRoot = resolve(import.meta.dir, "..");
const packageJson = (await Bun.file(join(repoRoot, "package.json")).json()) as {
  version?: unknown;
};
const version =
  typeof packageJson.version === "string" && packageJson.version.length > 0
    ? packageJson.version
    : "0.0.0";
const platform = process.platform;
const arch = process.arch;
const artifactName = `bugent-${version}-${platform}-${arch}`;
const outputRoot = resolve(process.env.BUGENT_OUTPUT ?? join(repoRoot, "dist", "bugent"));
const staging = join(outputRoot, `.staging-${process.pid}`);
const packageRoot = join(staging, artifactName);
const releaseRoot = join(outputRoot, artifactName);
const binaryPath = join(packageRoot, "bugent");
const releaseBinaryPath = join(releaseRoot, "bugent");
const archivePath = join(outputRoot, `${artifactName}.tar.gz`);

function run(
  command: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): { stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: command,
    cwd: options.cwd ?? repoRoot,
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed (${result.exitCode}):\n` +
        `${result.stderr.toString()}\n${result.stdout.toString()}`,
    );
  }
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function sha256(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function writeFakeMcpServer(path: string): Promise<void> {
  return writeFile(
    path,
    `
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "package-probe", version: "1" },
        },
      });
    } else if (message.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [{
            name: "echo",
            description: "Package verification probe.",
            inputSchema: { type: "object", properties: {} },
          }],
        },
      });
    } else if (message.method === "tools/call") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "probe-ok" }] },
      });
    }
  }
}
`,
    "utf8",
  );
}

async function verifyPackage(): Promise<{
  versionOutput: string;
  mockOutput: string;
  sandboxLibraryExtracted: true;
}> {
  const verifyRoot = join(staging, "verify");
  const verifyHome = join(verifyRoot, "home");
  const workspace = join(verifyRoot, "workspace");
  const configDir = join(verifyHome, ".bugent");
  const fakeServer = join(workspace, "fake-mcp.ts");
  await mkdir(configDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFakeMcpServer(fakeServer);
  await writeFile(
    join(configDir, "config.toml"),
    `default_model = "mock/echo"

[[providers]]
id = "mock"
endpoint = "mock"

[[mcp.servers]]
id = "package-probe"
cmd = [${JSON.stringify(process.execPath)}, ${JSON.stringify(fakeServer)}]
cwd = ${JSON.stringify(workspace)}
workspace_read = true
workspace_write = false
network = "none"
env = []
`,
    "utf8",
  );

  const env = { ...process.env, HOME: verifyHome };
  const versionOutput = run([binaryPath, "--version"], { cwd: workspace, env }).stdout.trim();
  const mockOutput = run(
    [
      binaryPath,
      "--mock",
      "--no-persist",
      "--mode",
      "no-sandbox",
      "-p",
      "package probe",
    ],
    { cwd: workspace, env },
  ).stdout.trim();
  const extractedLibrary = join(
    verifyHome,
    ".bugent",
    "runtime",
    version,
    "lib",
    "libbugent-sandbox.so",
  );
  if (!existsSync(extractedLibrary)) {
    throw new Error(`standalone runtime 未释放 native provider：${extractedLibrary}`);
  }
  return { versionOutput, mockOutput, sandboxLibraryExtracted: true };
}

if (!existsSync(join(repoRoot, "runtime", "bun", "bin", "bugent-bun"))) {
  throw new Error("缺少项目 Bun runtime；先运行 `bun run runtime:install`");
}
const buildRuntime = assertBugentBunRuntime();

run([process.execPath, "run", join(repoRoot, "scripts", "build-sandbox.ts")]);

await rm(staging, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

const promptPath = join(repoRoot, "src", "prompts", "system.md");
const sandboxLibrary = join(
  repoRoot,
  "native",
  "sandbox",
  "build",
  "libbugent-sandbox.so",
);

run([
  process.execPath,
  "build",
  join(repoRoot, "src", "index.ts"),
  "--compile",
  `--compile-executable-path=${process.execPath}`,
  "--minify",
  `--outfile=${binaryPath}`,
  `--asset=${promptPath}`,
  `--asset=${sandboxLibrary}`,
]);
await chmod(binaryPath, 0o755);

const binarySha256 = await sha256(binaryPath);
await writeFile(join(packageRoot, "VERSION"), `${version}\n`, "utf8");
await writeFile(
  join(packageRoot, "README.txt"),
  `bugent ${version}\n\n` +
    "Single-file Bun executable with embedded system prompt and Linux sandbox provider.\n" +
    "Run: ./bugent --help\n",
  "utf8",
);
await writeFile(
  join(packageRoot, "manifest.json"),
  `${JSON.stringify(
    {
      name: "bugent",
      version,
      platform,
      arch,
      executable: "bugent",
      sha256: binarySha256,
      buildRuntime: {
        executable: buildRuntime,
        version: run([buildRuntime, "--version"]).stdout.trim(),
      },
      embedded: {
        systemPrompt: basename(promptPath),
        sandboxLibrary: basename(sandboxLibrary),
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const verification = await verifyPackage();
await mkdir(outputRoot, { recursive: true });
run(["tar", "-czf", archivePath, "-C", staging, artifactName]);
const archiveSha256 = await sha256(archivePath);
await writeFile(`${archivePath}.sha256`, `${archiveSha256}  ${basename(archivePath)}\n`, "utf8");

await rm(releaseRoot, { recursive: true, force: true });
await cp(packageRoot, releaseRoot, { recursive: true });
await rm(staging, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      binary: releaseBinaryPath,
      archive: archivePath,
      sha256: archiveSha256,
      binarySha256,
      verification,
    },
    null,
    2,
  ),
);
