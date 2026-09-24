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
  const embedded = embeddedFile(SANDBOX_LIBRARY_ASSET);
  if (embedded === undefined) {
    throw new Error(`standalone bugent 缺少嵌入资产 ${SANDBOX_LIBRARY_ASSET}`);
  }

  const bytes = new Uint8Array(await embedded.arrayBuffer());
  const digest = await sha256(bytes);
  const target = join(
    homedir(),
    ".bugent",
    "runtime",
    BUGENT_VERSION,
    "lib",
    SANDBOX_LIBRARY_ASSET,
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
