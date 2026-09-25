/**
 * 工具资源锁 —— 并发执行时的正确性边界。
 *
 * 锁键是分层的：
 *   workspace                 整个工作区
 *   workspace/<relative path> 单个文件
 *
 * 两个键相等，或一个键是另一个键的目录前缀时视为重叠。
 * 只要任一侧是 write，重叠请求就必须串行。
 */

export type ResourceAccess = "read" | "write";

export interface ResourceClaim {
  key: string;
  access: ResourceAccess;
}

export type ReleaseResourceLocks = () => void;

interface Waiter {
  readonly claims: readonly ResourceClaim[];
  readonly signal: AbortSignal | undefined;
  readonly resolve: (release: ReleaseResourceLocks) => void;
  readonly reject: (error: Error) => void;
  onAbort: (() => void) | undefined;
  settled: boolean;
}

export class ResourceLockAbortError extends Error {
  constructor() {
    super("cancelled while waiting for a tool resource lock");
    this.name = "ResourceLockAbortError";
  }
}

function keyOverlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const aPrefix = a.endsWith("/") ? a : `${a}/`;
  const bPrefix = b.endsWith("/") ? b : `${b}/`;
  return a.startsWith(bPrefix) || b.startsWith(aPrefix);
}

function claimsConflict(a: ResourceClaim, b: ResourceClaim): boolean {
  if (!keyOverlaps(a.key, b.key)) return false;
  return a.access === "write" || b.access === "write";
}

function normalizeClaims(claims: readonly ResourceClaim[]): ResourceClaim[] {
  const byKey = new Map<string, ResourceAccess>();
  for (const claim of claims) {
    const current = byKey.get(claim.key);
    if (current === undefined || claim.access === "write") byKey.set(claim.key, claim.access);
  }
  return [...byKey.entries()]
    .map(([key, access]): ResourceClaim => ({ key, access }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export class ResourceLockManager {
  #active: Waiter[] = [];
  #queue: Waiter[] = [];

  acquire(
    claims: readonly ResourceClaim[],
    signal?: AbortSignal,
  ): Promise<ReleaseResourceLocks> {
    const normalized = normalizeClaims(claims);
    if (normalized.length === 0) return Promise.resolve(() => {});
    if (signal?.aborted === true) return Promise.reject(new ResourceLockAbortError());

    return new Promise<ReleaseResourceLocks>((resolve, reject) => {
      const waiter: Waiter = {
        claims: normalized,
        signal,
        resolve,
        reject,
        onAbort: undefined,
        settled: false,
      };

      const abort = (): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(new ResourceLockAbortError());
        this.#pump();
      };

      waiter.onAbort = abort;
      signal?.addEventListener("abort", abort, { once: true });
      this.#queue.push(waiter);
      this.#pump();
    });
  }

  #canGrant(claims: readonly ResourceClaim[]): boolean {
    for (const active of this.#active) {
      for (const requested of claims) {
        for (const held of active.claims) {
          if (claimsConflict(requested, held)) return false;
        }
      }
    }
    return true;
  }

  #pump(): void {
    while (this.#queue.length > 0) {
      const waiter = this.#queue[0]!;
      if (!this.#canGrant(waiter.claims)) return;
      this.#queue.shift();

      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.#active.push(waiter);
      waiter.resolve(() => this.#release(waiter));
    }
  }

  #release(waiter: Waiter): void {
    const index = this.#active.indexOf(waiter);
    if (index >= 0) this.#active.splice(index, 1);
    this.#pump();
  }
}
