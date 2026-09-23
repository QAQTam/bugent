/**
 * 会话注册表与并发锁 —— Phase 9。
 *
 * 并发模型（重要）：
 *   - **不同会话之间完全并行**：各自持有独立的 msgid 序列、独立的 AbortController。
 *     共享的只有 provider client（无状态）和 SQLite 连接。
 *   - **同一会话同时只允许一轮**：再进来直接抛 SessionBusyError，而不是排队。
 *     排队会让用户以为"卡住了"，快速失败更诚实。
 *   - SQLite 侧靠 WAL + busy_timeout 扛并发写；bun:sqlite 是同步 API，
 *     单进程内不会出现真正的并行写，跨进程则由 busy_timeout 兜底。
 */

import type { AgentSession } from "./session.ts";
import { runUserTurn, type RunTurnOptions, type TurnResult } from "./loop.ts";

export class SessionBusyError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`会话 ${sessionId} 正在运行中，请等这一轮结束或先中断`);
    this.name = "SessionBusyError";
    this.sessionId = sessionId;
  }
}

export class ManagedSession {
  readonly id: string;
  readonly session: AgentSession;

  #busy = false;
  #controller: AbortController | undefined;

  constructor(session: AgentSession) {
    this.id = session.id;
    this.session = session;
  }

  get busy(): boolean {
    return this.#busy;
  }

  get controller(): AbortController | undefined {
    return this.#controller;
  }

  /**
   * 推进一轮。同一会话重复进入会抛 SessionBusyError。
   * `options.signal` 与内部的 controller 是"或"的关系：任一 abort 都会中断。
   */
  async run(
    text: string,
    options: Omit<RunTurnOptions, "signal"> & { signal?: AbortSignal } = {},
  ): Promise<TurnResult> {
    if (this.#busy) throw new SessionBusyError(this.id);

    this.#busy = true;
    const controller = new AbortController();
    this.#controller = controller;

    const external = options.signal;
    const forwardAbort = (): void => controller.abort();
    external?.addEventListener("abort", forwardAbort, { once: true });

    try {
      const { signal: _ignored, ...rest } = options;
      return await runUserTurn(this.session, text, { ...rest, signal: controller.signal });
    } finally {
      external?.removeEventListener("abort", forwardAbort);
      this.#busy = false;
      this.#controller = undefined;
    }
  }

  abort(): void {
    this.#controller?.abort();
  }
}

export class SessionRegistry {
  #sessions = new Map<string, ManagedSession>();

  get size(): number {
    return this.#sessions.size;
  }

  add(session: AgentSession): ManagedSession {
    if (this.#sessions.has(session.id)) {
      throw new Error(`会话已存在：${session.id}`);
    }
    const managed = new ManagedSession(session);
    this.#sessions.set(session.id, managed);
    return managed;
  }

  get(id: string): ManagedSession | undefined {
    return this.#sessions.get(id);
  }

  require(id: string): ManagedSession {
    const managed = this.#sessions.get(id);
    if (managed === undefined) throw new Error(`未知会话：${id}`);
    return managed;
  }

  list(): ManagedSession[] {
    return [...this.#sessions.values()];
  }

  /** 当前正在跑的会话。 */
  running(): ManagedSession[] {
    return this.list().filter((managed) => managed.busy);
  }

  remove(id: string): boolean {
    return this.#sessions.delete(id);
  }

  /** 中断某个会话（或全部）。 */
  abort(id?: string): void {
    if (id !== undefined) {
      this.get(id)?.abort();
      return;
    }
    for (const managed of this.list()) managed.abort();
  }
}
