/**
 * 权限闸门 —— 所有工具执行的必经之路。
 *
 * 判定顺序（重要）：
 *   1. 显式 `deny` 规则        —— 硬性禁令，永远优先
 *   2. 档位能力检查            —— 不够就尝试**升档**（弹窗），否则拒绝
 *   3. 显式 `ask` 规则         —— 用户要求对特定操作确认
 *   4. 放行                    —— 档位已经声明了边界，不必再问
 *
 * 核心思想：**档位即授权**。用户启动时选的那一档，就是对那一档范围内
 * 所有操作的预先授权。弹窗只在"想干超出档位的事"时出现，
 * 而不是每次执行工具都打断一次。
 */

import {
  describeRequirement,
  minimumModeFor,
  modeSatisfies,
  type SandboxMode,
} from "./mode.ts";
import { PermissionPolicy, type PermissionDecision, type PermissionRequest } from "./policy.ts";

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
  /** 决策时的档位。 */
  mode: SandboxMode;
  /** 这次决策是否触发了升档。 */
  escalatedTo?: SandboxMode;
  reason?: string;
  at: number;
}

export type GateDecisionListener = (record: GateDecision) => void;

/**
 * 请求临时升档。返回批准后的档位；返回 undefined 表示拒绝。
 * TUI 用弹窗实现，CLI 用 stdin 问答实现。
 */
export type EscalationHandler = (
  request: PermissionRequest,
  needed: SandboxMode,
) => Promise<SandboxMode | undefined>;

export interface GateOptions {
  policy: PermissionPolicy;
  mode: SandboxMode;
  prompter?: PermissionPrompter;
  onDecision?: GateDecisionListener;
  onEscalate?: EscalationHandler;
}

export class PermissionGate {
  #policy: PermissionPolicy;
  #mode: SandboxMode;
  #prompter: PermissionPrompter | undefined;
  #onDecision: GateDecisionListener | undefined;
  #onEscalate: EscalationHandler | undefined;

  constructor(options: GateOptions) {
    this.#policy = options.policy;
    this.#mode = options.mode;
    this.#prompter = options.prompter;
    this.#onDecision = options.onDecision;
    this.#onEscalate = options.onEscalate;
  }

  get policy(): PermissionPolicy {
    return this.#policy;
  }

  get mode(): SandboxMode {
    return this.#mode;
  }

  /** 直接改档位（用户主动切换，或升档后由内部调用）。 */
  setMode(mode: SandboxMode): void {
    this.#mode = mode;
  }

  decide(request: PermissionRequest): PermissionDecision {
    return this.#policy.evaluate(request).decision;
  }

  async check(request: PermissionRequest): Promise<GateVerdict> {
    const evaluated = this.#policy.evaluate(request);

    // 1) 硬性禁令
    if (evaluated.decision === "deny") {
      return this.#finish(request, evaluated.decision, { allowed: false, reason: "策略禁止" });
    }

    // 2) 档位能力：不满足就尝试升档
    let escalatedTo: SandboxMode | undefined;
    if (request.requires !== undefined && !modeSatisfies(this.#mode, request.requires)) {
      const needed = minimumModeFor(request.requires);
      const approved = await this.#onEscalate?.(request, needed);

      if (approved === undefined) {
        return this.#finish(request, evaluated.decision, {
          allowed: false,
          reason:
            `当前档位（${this.#mode}）不支持${describeRequirement(request.requires)}。` +
            `需要升到 ${needed} —— 用 --mode ${needed} 重启，或在弹窗里批准临时升档`,
        });
      }

      escalatedTo = approved;
      this.#mode = approved;
    }

    // 3) 显式询问
    if (evaluated.decision === "ask") {
      if (this.#prompter === undefined) {
        return this.#finish(request, evaluated.decision, {
          allowed: false,
          reason: "需要用户确认，但当前没有可交互的确认入口",
        });
      }
      const approved = await this.#prompter.ask(request);
      return this.#finish(
        request,
        evaluated.decision,
        approved ? { allowed: true } : { allowed: false, reason: "用户拒绝执行" },
      );
    }

    // 4) 放行：档位已经保证了边界
    return this.#finish(request, evaluated.decision, { allowed: true }, escalatedTo);
  }

  #finish(
    request: PermissionRequest,
    decision: PermissionDecision,
    verdict: GateVerdict,
    escalatedTo?: SandboxMode,
  ): GateVerdict {
    this.#onDecision?.({
      request,
      decision,
      allowed: verdict.allowed,
      mode: this.#mode,
      at: Date.now(),
      ...(escalatedTo !== undefined ? { escalatedTo } : {}),
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    });
    return verdict;
  }
}
