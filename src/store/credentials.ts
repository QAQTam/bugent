/**
 * API key 凭据存储。
 *
 * 优先使用系统 keychain：
 *   - Linux: secret-tool (libsecret)
 *   - macOS: security
 *
 * 命令不可用或调用失败时降级到进程内 memory store；绝不把 API key
 * 写进 SQLite 或项目文件。
 */

export type CredentialStoreKind = "keychain" | "memory";

export interface CredentialStore {
  readonly kind: CredentialStoreKind;
  get(sessionId: string, providerId: string): Promise<string | undefined>;
  set(sessionId: string, providerId: string, secret: string): Promise<void>;
  delete(sessionId: string, providerId: string): Promise<void>;
}

const SERVICE = "bugent";

function account(sessionId: string, providerId: string): string {
  return `${sessionId}:${providerId}`;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCommand(
  argv: string[],
  stdin?: string,
): Promise<CommandResult> {
  const proc = Bun.spawn(argv, {
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && proc.stdin !== undefined) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export class MemoryCredentialStore implements CredentialStore {
  readonly kind = "memory" as const;
  #values = new Map<string, string>();

  async get(sessionId: string, providerId: string): Promise<string | undefined> {
    return this.#values.get(account(sessionId, providerId));
  }

  async set(sessionId: string, providerId: string, secret: string): Promise<void> {
    this.#values.set(account(sessionId, providerId), secret);
  }

  async delete(sessionId: string, providerId: string): Promise<void> {
    this.#values.delete(account(sessionId, providerId));
  }
}

class KeychainCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;
  #fallback = new MemoryCredentialStore();
  #platform: "linux" | "darwin";

  constructor(platform: "linux" | "darwin") {
    this.#platform = platform;
  }

  async get(sessionId: string, providerId: string): Promise<string | undefined> {
    try {
      const key = account(sessionId, providerId);
      const result =
        this.#platform === "linux"
          ? await runCommand(["secret-tool", "lookup", "service", SERVICE, "account", key])
          : await runCommand(["security", "find-generic-password", "-s", SERVICE, "-a", key, "-w"]);
      if (result.exitCode === 0 && result.stdout.trim().length > 0) {
        return result.stdout.replace(/\r?\n$/, "");
      }
    } catch {
      // fall through to memory
    }
    return this.#fallback.get(sessionId, providerId);
  }

  async set(sessionId: string, providerId: string, secret: string): Promise<void> {
    try {
      const key = account(sessionId, providerId);
      const result =
        this.#platform === "linux"
          ? await runCommand(
              ["secret-tool", "store", "--label", SERVICE, "service", SERVICE, "account", key],
              secret,
            )
          : await runCommand([
              "security",
              "add-generic-password",
              "-U",
              "-s",
              SERVICE,
              "-a",
              key,
              "-w",
              secret,
            ]);
      if (result.exitCode === 0) return;
    } catch {
      // fall through to memory
    }
    await this.#fallback.set(sessionId, providerId, secret);
  }

  async delete(sessionId: string, providerId: string): Promise<void> {
    try {
      const key = account(sessionId, providerId);
      await (this.#platform === "linux"
        ? runCommand(["secret-tool", "clear", "service", SERVICE, "account", key])
        : runCommand(["security", "delete-generic-password", "-s", SERVICE, "-a", key]));
    } catch {
      // ignore: delete is best-effort
    }
    await this.#fallback.delete(sessionId, providerId);
  }
}

export function createCredentialStore(): CredentialStore {
  if (process.platform === "linux" && Bun.which("secret-tool") !== null) {
    return new KeychainCredentialStore("linux");
  }
  if (process.platform === "darwin" && Bun.which("security") !== null) {
    return new KeychainCredentialStore("darwin");
  }
  return new MemoryCredentialStore();
}
