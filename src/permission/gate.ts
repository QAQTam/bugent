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

export class PermissionGate {
  #policy: PermissionPolicy;
  #prompter: PermissionPrompter | undefined;

  constructor(policy: PermissionPolicy, prompter?: PermissionPrompter) {
    this.#policy = policy;
    this.#prompter = prompter;
  }

  get policy(): PermissionPolicy {
    return this.#policy;
  }

  decide(request: PermissionRequest): PermissionDecision {
    return this.#policy.evaluate(request);
  }

  async check(request: PermissionRequest): Promise<GateVerdict> {
    const decision = this.#policy.evaluate(request);

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
