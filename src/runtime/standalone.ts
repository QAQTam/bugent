/**
 * Runtime preparation for Bun standalone executables.
 *
 * Bun embeds `--asset` files in `/$bunfs`; native dlopen cannot consume that
 * virtual filesystem. The sandbox provider is therefore materialized into a
 * per-version cache before MCP starts.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BUGENT_VERSION } from "../version.ts";

export const SANDBOX_LIBRARY_ASSET = "libbugent-sandbox.so";
export const SYSTEM_PROMPT_ASSET = "system.md";

/**
 * 这个平台的原生沙箱 provider 叫什么名字。
 *
 * 只有 Linux 有 provider（fork 的 spawn 钩子是 POSIX/Linux 向的，实现用
 * Landlock + seccomp）。其他平台返回 undefined —— 于是 standalone 启动时
 * 不会去找一个根本不存在的资产、更不会因此抛错。
 */
export function sandboxLibraryAsset(platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === "linux" ? SANDBOX_LIBRARY_ASSET : undefined;
}

type EmbeddedFile = Blob & { name: string };

export function embeddedFiles(): readonly EmbeddedFile[] {
  return (Bun.embeddedFiles ?? []) as readonly EmbeddedFile[];
}

export function embeddedFile(name: string): EmbeddedFile | undefined {
  return embeddedFiles().find((file) => file.name === name);
}

export function isStandaloneBugent(): boolean {
  return import.meta.dir.startsWith("/$bunfs/") || embeddedFiles().length > 0;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export interface StandaloneRuntime {
  sandboxLibrary?: string;
}

/** Extract embedded native assets and expose them through stable env overrides. */
export async function prepareStandaloneRuntime(): Promise<StandaloneRuntime> {
  if (!isStandaloneBugent()) return {};
  // 非 Linux 不嵌 provider：没有可加载的实现，缺它也不该拦住启动
  const assetName = sandboxLibraryAsset();
  if (assetName === undefined) return {};
  const embedded = embeddedFile(assetName);
  if (embedded === undefined) {
    throw new Error(`standalone bugent 缺少嵌入资产 ${assetName}`);
  }

  const bytes = new Uint8Array(await embedded.arrayBuffer());
  const digest = await sha256(bytes);
  const target = join(
    homedir(),
    ".bugent",
    "runtime",
    BUGENT_VERSION,
    "lib",
    assetName,
  );
  let current: string | undefined;
  try {
    current = await sha256(new Uint8Array(await readFile(target)));
  } catch {
    current = undefined;
  }

  if (current !== digest) {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600);
  }

  process.env.BUGENT_SANDBOX_LIBRARY = target;
  return { sandboxLibrary: target };
}
