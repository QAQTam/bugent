import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const packageDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(packageDir, "..", "..");
const version = (await readFile(join(packageDir, "VERSION"), "utf8")).trim();

const forkDir = resolve(process.env.BUGENT_BUN_FORK ?? join(repoRoot, "..", "bun"));
const profile = process.env.BUGENT_BUN_PROFILE ?? "release";
const binaryName = profile === "debug" ? "bun-debug" : "bun";
const binaryPath =
  process.env.BUGENT_BUN_BINARY ?? join(forkDir, "build", profile, binaryName);
const outputRoot = resolve(process.env.BUGENT_BUN_OUTPUT ?? join(repoRoot, "dist", "bun-runtime"));
const staging = join(outputRoot, `.staging-${process.pid}`);
const packageRoot = join(staging, "bugent-bun-runtime");

function run(command: string[]): string {
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
  return result.stdout.toString().trim();
}

await rm(staging, { recursive: true, force: true });
await mkdir(join(packageRoot, "bin"), { recursive: true });
await mkdir(join(packageRoot, "include"), { recursive: true });

await copyFile(binaryPath, join(packageRoot, "bin", "bugent-bun"));
await chmod(join(packageRoot, "bin", "bugent-bun"), 0o755);
await copyFile(
  join(forkDir, "src", "spawn", "sandbox_abi.h"),
  join(packageRoot, "include", "bun_spawn_sandbox.h"),
);
await copyFile(join(packageDir, "package.json"), join(packageRoot, "package.json"));
await copyFile(join(packageDir, "README.md"), join(packageRoot, "README.md"));
await copyFile(join(packageDir, "VERSION"), join(packageRoot, "VERSION"));
await cp(join(packageDir, "src"), join(packageRoot, "src"), { recursive: true });
await cp(join(packageDir, "types"), join(packageRoot, "types"), { recursive: true });

const binaryVersion = run([binaryPath, "--version"]);
const revision = run(["git", "-C", forkDir, "rev-parse", "--short", "HEAD"]);
const binaryBytes = await readFile(binaryPath);
const binarySha256 = new Bun.CryptoHasher("sha256").update(binaryBytes).digest("hex");
const metadata = {
  name: "@bugent/bun-runtime",
  version,
  bunVersion: binaryVersion,
  revision,
  profile,
  platform: process.platform,
  arch: process.arch,
  binary: "bin/bugent-bun",
  sha256: binarySha256,
};
await writeFile(
  join(packageRoot, "runtime.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
);

const archiveName = `bugent-bun-runtime-${version}-${process.platform}-${process.arch}.tar.gz`;
const archivePath = join(outputRoot, archiveName);
await mkdir(outputRoot, { recursive: true });
run(["tar", "-czf", archivePath, "-C", staging, basename(packageRoot)]);
const archiveSha256 = new Bun.CryptoHasher("sha256")
  .update(await readFile(archivePath))
  .digest("hex");
await writeFile(`${archivePath}.sha256`, `${archiveSha256}  ${archiveName}\n`);

console.log(
  JSON.stringify(
    {
      archive: archivePath,
      sha256: archiveSha256,
      unpacked: packageRoot,
      metadata,
    },
    null,
    2,
  ),
);
