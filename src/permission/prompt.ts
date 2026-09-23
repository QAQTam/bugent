/**
 * 权限确认入口。
 *
 * CLI 用 stdin 问答；TUI 用弹窗（见 src/tui/app.ts 的 TuiPrompter）。
 * 测试用 ScriptedPrompter 或直接给固定答案。
 */

import { createInterface, type Interface } from "node:readline/promises";
import type { PermissionPrompter } from "./gate.ts";
import type { PermissionRequest } from "./policy.ts";

/** 在 stdin 上问一句 y/N。 */
export class StdinPrompter implements PermissionPrompter {
  #rl: Interface | undefined;

  #readline(): Interface {
    this.#rl ??= createInterface({ input: process.stdin, output: process.stdout });
    return this.#rl;
  }

  async ask(request: PermissionRequest): Promise<boolean> {
    const answer = await this.#readline().question(
      `\n\x1b[33m[权限请求]\x1b[0m ${request.summary}\n允许执行？[y/N] `,
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  }

  close(): void {
    this.#rl?.close();
    this.#rl = undefined;
  }
}

/** 永远同意 / 永远拒绝，以及给固定脚本。 */
export class ScriptedPrompter implements PermissionPrompter {
  #answers: boolean[];
  #fallback: boolean;
  readonly seen: PermissionRequest[] = [];

  constructor(answers: readonly boolean[], fallback = false) {
    this.#answers = [...answers];
    this.#fallback = fallback;
  }

  async ask(request: PermissionRequest): Promise<boolean> {
    this.seen.push(request);
    return this.#answers.shift() ?? this.#fallback;
  }
}

export const allowAllPrompter: PermissionPrompter = { ask: async () => true };
export const denyAllPrompter: PermissionPrompter = { ask: async () => false };
