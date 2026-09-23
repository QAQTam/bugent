/**
 * 权限闸门 —— 所有工具执行的必经之路。
 *
 * 放在 ToolRegistry 里而不是散落在各工具中：只要工具是通过 registry 跑的，
 * 就不可能绕过权限检查。
 */

import {
  PermissionPolicy,
  type PermissionDecision,
  type PermissionRequest,
} from "./policy.ts";

export interface PermissionPrompter {
  /** 返回 true 表示用户同意。 */
  ask(request: PermissionRequest): Promise<boolean>;
  close?(): void;
}

export interface GateVerdict {
  allowed: boolean;
  /** 被拒时回给模型的原因。 */
  reason?: string;
}

/** 一次权限决策的完整记录，用于审计。 */
export interface GateDecision {
  request: PermissionRequest;
  decision: PermissionDecision;
  allowed: boolean;
  reason?: string;
  at: number;
}

export type GateDecisionListener = (record: GateDecision) => void;

export class PermissionGate {
  #policy: PermissionPolicy;
  #prompter: PermissionPrompter | undefined;
  #onDecision: GateDecisionListener | undefined;

  constructor(
    policy: PermissionPolicy,
    prompter?: PermissionPrompter,
    onDecision?: GateDecisionListener,
  ) {
    this.#policy = policy;
    this.#prompter = prompter;
    this.#onDecision = onDecision;
  }

  get policy(): PermissionPolicy {
    return this.#policy;
  }

  decide(request: PermissionRequest): PermissionDecision {
    return this.#policy.evaluate(request);
  }

  async check(request: PermissionRequest): Promise<GateVerdict> {
    const decision = this.#policy.evaluate(request);
    const verdict = await this.#resolve(request, decision);
    this.#onDecision?.({
      request,
      decision,
      allowed: verdict.allowed,
      at: Date.now(),
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    });
    return verdict;
  }

  async #resolve(request: PermissionRequest, decision: PermissionDecision): Promise<GateVerdict> {
    if (decision === "allow") return { allowed: true };
    if (decision === "deny") return { allowed: false, reason: "策略禁止" };

    // ask
    if (this.#prompter === undefined) {
      return { allowed: false, reason: "需要用户确认，但当前没有可交互的确认入口" };
    }

    const approved = await this.#prompter.ask(request);
    return approved ? { allowed: true } : { allowed: false, reason: "用户拒绝执行" };
  }
}
