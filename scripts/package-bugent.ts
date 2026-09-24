#!/usr/bin/env bun
/**
 * Build the standalone Bugent executable.
 *
 * Linux 上产物内嵌 system prompt 与原生沙箱 provider（运行时释放到
 * `~/.bugent/runtime/<version>/lib`，因为 dlopen 读不了 Bun 的 `/$bunfs` 虚拟文件系统）。
 *
 * Windows/macOS 上原生 provider 不存在，于是整体关掉依赖它的能力（MCP、
 * 内核级沙箱）—— 具体关哪些由 `package-platform.ts` 决定，这里只按计划执行。
 */

import { chmod, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assertBugentBunRuntime } from "../runtime/bun/src/index.ts";
import { packagePlan, SANDBOX_LIBRARY_NAME } from "./package-platform.ts";

const repoRoot = resolve(import.meta.dir, "..");
const packageJson = (await Bun.file(join(repoRoot, "package.json")).json()) as {
  version?: unknown;
};
// 版本只有一个来源（package.json）；写死一个兜底值的话，发版时忘了改就会
// 打包出一个版本号对不上的归档，而且没人会注意到。
if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new Error("package.json 缺少 version，无法确定发布版本号");
}
const version = packageJson.version;
const platform = process.platform;
const arch = process.arch;
const plan = packagePlan(platform);
const artifactName = `bugent-${version}-${platform}-${arch}`;
const outputRoot = resolve(process.env.BUGENT_OUTPUT ?? join(repoRoot, "dist", "bugent"));
const staging = join(outputRoot, `.staging-${process.pid}`);
const packageRoot = join(staging, artifactName);
const releaseRoot = join(outputRoot, artifactName);
const binaryPath = join(packageRoot, plan.binaryName);
const releaseBinaryPath = join(releaseRoot, plan.binaryName);
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
  sandboxLibraryExtracted: boolean;
}> {
  const verifyRoot = join(staging, "verify");
  const verifyHome = join(verifyRoot, "home");
  const workspace = join(verifyRoot, "workspace");
  const configDir = join(verifyHome, ".bugent");
  const fakeServer = join(workspace, "fake-mcp.ts");
  await mkdir(configDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  // MCP 探针只在带原生 provider 的平台上跑：其他平台 MCP 是被门控关闭的，
  // 配了也只会拿到"已关闭 + 原因"，验不出打包有没有问题。
  const mcpSection = plan.verify.mcpSandboxProbe
    ? `
[[mcp.servers]]
id = "package-probe"
cmd = [${JSON.stringify(process.execPath)}, ${JSON.stringify(fakeServer)}]
cwd = ${JSON.stringify(workspace)}
workspace_read = true
workspace_write = false
network = "none"
env = []
`
    : "";
  if (plan.verify.mcpSandboxProbe) await writeFakeMcpServer(fakeServer);
  await writeFile(
    join(configDir, "config.toml"),
    `default_model = "mock/echo"

[[providers]]
id = "mock"
endpoint = "mock"
${mcpSection}`,
    "utf8",
  );

  // HOME 让被测二进制把配置/会话库/运行时缓存都落在临时目录里。
  // Windows 上 os.homedir() 读 USERPROFILE，所以两个都给上。
  const env = { ...process.env, HOME: verifyHome, USERPROFILE: verifyHome };
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
  if (!versionOutput.includes(version)) {
    throw new Error(`--version 输出与版本号不符：${JSON.stringify(versionOutput)}`);
  }
  if (!mockOutput.includes("package probe")) {
    throw new Error(`mock 冒烟输出异常：${JSON.stringify(mockOutput)}`);
  }
  if (!plan.verify.sandboxLibraryExtracted) {
    return { versionOutput, mockOutput, sandboxLibraryExtracted: false };
  }

  const extractedLibrary = join(
    verifyHome,
    ".bugent",
    "runtime",
    version,
    "lib",
    SANDBOX_LIBRARY_NAME,
  );
  if (!existsSync(extractedLibrary)) {
    throw new Error(`standalone runtime 未释放 native provider：${extractedLibrary}`);
  }
  return { versionOutput, mockOutput, sandboxLibraryExtracted: true };
}

// 需要原生 provider 的平台才要求构建宿主是 Bugent Bun fork；其他平台用当前
// Bun 编就行（fork 的唯一增量就是 provider 钩子，见 runtime/bun/README.md）。
if (plan.requiresForkRuntime && !existsSync(join(repoRoot, "runtime", "bun", "bin", "bugent-bun"))) {
  throw new Error("缺少项目 Bun runtime；先运行 `bun run runtime:install`");
}
const buildRuntime = plan.requiresForkRuntime ? assertBugentBunRuntime() : process.execPath;

if (plan.nativeSandbox) {
  run([process.execPath, "run", join(repoRoot, "scripts", "build-sandbox.ts")]);
}

await rm(staging, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });

const assetPaths = plan.assets.map((relative) => join(repoRoot, relative));
for (const asset of assetPaths) {
  if (!existsSync(asset)) throw new Error(`缺少要嵌入的资产：${asset}`);
}

// 交给 Bun 决定要不要补 `.exe`：Windows 上它自己会加，写死 `bugent.exe` 可能
// 变成 `bugent.exe.exe`。编完再按实际落盘的名字归一。
const compileTarget = join(packageRoot, "bugent");
run([
  process.execPath,
  "build",
  join(repoRoot, "src", "index.ts"),
  "--compile",
  `--compile-executable-path=${process.execPath}`,
  "--minify",
  `--outfile=${compileTarget}`,
  ...assetPaths.map((asset) => `--asset=${asset}`),
]);
const produced = existsSync(compileTarget) ? compileTarget : `${compileTarget}.exe`;
if (!existsSync(produced)) throw new Error(`编译产物不存在：${compileTarget}`);
if (produced !== binaryPath) await rename(produced, binaryPath);
// Windows 没有 POSIX 权限位；chmod 在那边只影响只读标记，跳过更省事
if (platform !== "win32") await chmod(binaryPath, 0o755);

const binarySha256 = await sha256(binaryPath);
await writeFile(join(packageRoot, "VERSION"), `${version}\n`, "utf8");
await writeFile(
  join(packageRoot, "README.txt"),
  `bugent ${version}\n\n` +
    `${plan.runtimeNote}\n` +
    `Run: ./${plan.binaryName} --help\n` +
    (plan.disabled.length > 0
      ? `\nDisabled on this platform:\n${plan.disabled.map((item) => `- ${item}`).join("\n")}\n`
      : ""),
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
      executable: plan.binaryName,
      sha256: binarySha256,
      capabilities: {
        nativeSandbox: plan.nativeSandbox,
        mcpSandbox: plan.verify.mcpSandboxProbe,
      },
      disabled: plan.disabled,
      buildRuntime: {
        executable: buildRuntime,
        version: run([buildRuntime, "--version"]).stdout.trim(),
      },
      embedded: {
        systemPrompt: basename(assetPaths[0]!),
        ...(plan.nativeSandbox ? { sandboxLibrary: SANDBOX_LIBRARY_NAME } : {}),
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
