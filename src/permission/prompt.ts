/**
 * 权限确认入口。
 *
 * CLI 用 stdin 问答；TUI 用弹窗（见 src/tui/app.ts 的三个弹窗入口）。
 * 测试用 ScriptedPrompter 或直接给固定答案。
 *
 * 两者都必须套 `withAuthorizationWindow()`：`node:readline` **没有内建超时**，
 * 不套窗口的话无人值守时会一直挂在那里等一个不会来的回车。
 */

import { createInterface, type Interface } from "node:readline/promises";
import type { PermissionPrompter } from "./gate.ts";
import { describeCapability } from "./mode.ts";
import type { PermissionRequest } from "./policy.ts";
import {
  AUTHORIZATION_TIMEOUT_MS,
  isApproved,
  withAuthorizationWindow,
  type AuthorizationOutcome,
} from "./authorization.ts";
import type { AuthorizationAlert } from "./alert.ts";
import type { CapabilityEscalation } from "../tools/types.ts";

function isYes(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

/** 授权窗口的提示尾巴 —— 让用户知道"不回答"等于拒绝。 */
function windowHint(timeoutMs: number): string {
  return `\x1b[2m（${Math.round(timeoutMs / 1000)} 秒内未确认视为拒绝）\x1b[0m `;
}

/** 在 stdin 上问一句 y/N。 */
export interface StdinPrompterOptions {
  timeoutMs?: number;
  /**
   * 有没有可交互的终端。默认看 `process.stdin.isTTY`。
   *
   * 没有终端时**不等待**：没人能回答，等满 60 秒只是白等（`-p` 一次性运行、
   * CI、stdin 被管道接走都属于这种）。直接按拒绝收口，并在 stderr 说明原因。
   */
  interactive?: boolean;
  /**
   * 授权硬件提醒。CLI 路径没有弹窗，用户很可能已经切到别的窗口了，
   * 所以这里尤其需要：出现时响一次，最后 10 秒逐级升级，结论再响一次。
   */
  alert?: AuthorizationAlert;
}

export class StdinPrompter implements PermissionPrompter {
  #rl: Interface | undefined;
  #timeoutMs: number;
  #interactive: boolean;
  #alert: AuthorizationAlert | undefined;
  #warned = false;
  /** 并发询问串行化（BUG-024）：ask/confirmCapability 共用一个 readline。 */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: StdinPrompterOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? AUTHORIZATION_TIMEOUT_MS;
    this.#interactive = options.interactive ?? process.stdin.isTTY === true;
    this.#alert = options.alert;
  }

  /** 串行化：并发弹窗时提问/回答不再交错（前一个完成才开始下一个）。 */
  #runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * 授权窗口 + 硬件提醒的统一外壳。
   *
   * 提醒是 fire-and-forget：它自己失败不会影响这里的问答，
   * 所以不需要 try/catch 把它包起来。
   */
  async #withAlert(
    request: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<AuthorizationOutcome> {
    const alert = this.#alert;
    alert?.begin(this.#timeoutMs);
    const outcome = await withAuthorizationWindow({
      timeoutMs: this.#timeoutMs,
      onTick: (remainingMs) => alert?.tick(remainingMs),
      request,
    });
    alert?.end(outcome);
    return outcome;
  }

  #readline(): Interface {
    this.#rl ??= createInterface({ input: process.stdin, output: process.stdout });
    return this.#rl;
  }

  #closeReadline(): void {
    this.#rl?.close();
    // 必须清掉缓存：close 之后再 question 会抛，留着会让下一次询问直接失败。
    this.#rl = undefined;
  }

  /** 没有终端可问时的一次性说明 —— 否则用户只会看到"被拒绝"却不知为何。 */
  #noteNoTerminal(): void {
    if (this.#warned) return;
    this.#warned = true;
    process.stderr.write(
      `\x1b[33m[权限]\x1b[0m 没有可交互的终端，需要授权的操作一律按拒绝处理（60 秒窗口不适用）\n`,
    );
  }

  async ask(request: PermissionRequest): Promise<AuthorizationOutcome> {
    if (!this.#interactive) {
      this.#noteNoTerminal();
      return "denied";
    }
    return this.#runExclusive(() =>
      this.#withAlert(async (signal) => {
        const rl = this.#readline();
        // 窗口到点时关掉 readline，否则那句提问会一直挂在终端上。
        const onAbort = (): void => this.#closeReadline();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          const answer = await rl.question(
            `\n\x1b[33m[权限请求]\x1b[0m ${request.summary}\n允许执行？[y/N] ${windowHint(this.#timeoutMs)}`,
          );
          return isYes(answer);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      }),
    );
  }

  /**
   * 能力授权询问。
   *
   * 一定把**真实原因与细节**打出来 —— 用户需要看到是哪条命令、
   * 因为什么失败，才能判断要不要批准。
   */
  async confirmCapability(escalation: CapabilityEscalation): Promise<AuthorizationOutcome> {
    if (!this.#interactive) {
      this.#noteNoTerminal();
      return "denied";
    }
    const lines = [
      "",
      `\x1b[33m[需要授权]\x1b[0m ${describeCapability(escalation.capability)}`,
      `  ${escalation.reason}`,
      ...(escalation.details ?? []).map((detail) => `  \x1b[2m${detail}\x1b[0m`),
    ];
    return this.#runExclusive(() =>
      this.#withAlert(async (signal) => {
        const rl = this.#readline();
        const onAbort = (): void => this.#closeReadline();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          const answer = await rl.question(
            `${lines.join("\n")}\n允许这一次？[y/N] ${windowHint(this.#timeoutMs)}`,
          );
          return isYes(answer);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      }),
    );
  }

  close(): void {
    this.#closeReadline();
  }
}

/** 脚本答案允许写 boolean —— 老测试与"人肉替身"读起来更直接。 */
export type ScriptedAnswer = boolean | AuthorizationOutcome;

function normalizeAnswer(value: ScriptedAnswer): AuthorizationOutcome {
  if (value === true) return "approved";
  if (value === false) return "denied";
  return value;
}

/** 按脚本回答，脚本用完用 fallback。 */
export class ScriptedPrompter implements PermissionPrompter {
  #answers: AuthorizationOutcome[];
  #fallback: AuthorizationOutcome;
  readonly seen: PermissionRequest[] = [];

  constructor(answers: readonly ScriptedAnswer[], fallback: ScriptedAnswer = false) {
    this.#answers = answers.map(normalizeAnswer);
    this.#fallback = normalizeAnswer(fallback);
  }

  async ask(request: PermissionRequest): Promise<AuthorizationOutcome> {
    this.seen.push(request);
    return this.#answers.shift() ?? this.#fallback;
  }
}

export const allowAllPrompter: PermissionPrompter = { ask: async () => "approved" };
export const denyAllPrompter: PermissionPrompter = { ask: async () => "denied" };
/** 模拟"用户走开了"：不回答，直接按窗口超时结算。 */
export const timeoutPrompter: PermissionPrompter = { ask: async () => "timeout" };

export { isApproved };
