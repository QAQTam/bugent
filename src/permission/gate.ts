/**
 * 权限闸门 —— 所有工具执行的必经之路。
 *
 * 判定顺序（重要）：
 *   1. 显式 `deny` 规则        —— 硬性禁令，永远优先
 *   2. 越出默认批准范围        —— **按次**授权（弹窗），批准只生效这一次
 *   3. 显式 `ask` 规则         —— 用户要求对特定操作确认
 *   4. 放行                    —— 档位已经声明了默认批准范围，不必再问
 *
 * 核心思想：**档位即预先授权范围**。用户启动时选的那一档，就是对那一档
 * 范围内所有操作的预先授权。弹窗只在"想干超出档位的事"时出现，
 * 而不是每次执行工具都打断一次。
 *
 * 两条不可动摇的边界：
 *
 *   1. **批准一次只生效一次。** 这里**不会**修改 `#mode` —— 改档位只能由
 *      用户主动切换（`setMode`）。把"批准这次写盘"实现成"永久升到
 *      workspace-write"，会让 read-only 的语义从"每次写入都要审批"
 *      退化成"审批一次之后随便写"。
 *
 *   2. **沙箱与档位无关。** 档位只决定"要不要问"，隔离层恒定存在
 *      （见 src/tools/builtin.ts）。
 */

import {
  describeRequirement,
  minimumModeFor,
  defaultApproves,
  type CapabilityGrant,
  type ModeRequirement,
  type SandboxMode,
} from "./mode.ts";
import {
  AUTHORIZATION_DENIED,
  describeOutcome,
  type AuthorizationOutcome,
  type AuthorizationRefusal,
} from "./authorization.ts";
import { PermissionPolicy, type PermissionDecision, type PermissionRequest } from "./policy.ts";

export interface PermissionPrompter {
  /**
   * 问一次用户。
   *
   * 返回**三态**而不是 boolean：`timeout`（没人应答）和 `denied`（用户点了拒绝）
   * 必须能区分开 —— 否则模型分不清该"换个做法"还是该"停下来问人"。
   * 60 秒窗口由实现方（TUI 弹窗 / CLI readline）用 `withAuthorizationWindow()` 保证。
   */
  ask(request: PermissionRequest): Promise<AuthorizationOutcome>;
  close?(): void;
}

export interface GateVerdict {
  allowed: boolean;
  /** 被拒时回给模型的原因。 */
  reason?: string;
  /**
   * 本次调用获准的越界能力；由 registry 注入到 `ToolCtx.grant`。
   *
   * 只在"越出默认批准范围且用户批准了这一次"时出现。
   */
  grant?: CapabilityGrant;
  /**
   * 未获批准的原因。**批准时不出现** —— 调用方不该为"通过"准备分支。
   */
  refusal?: AuthorizationRefusal;
}

/** 一次权限决策的完整记录，用于审计。 */
export interface GateDecision {
  request: PermissionRequest;
  decision: PermissionDecision;
  allowed: boolean;
  /** 决策时的档位。 */
  mode: SandboxMode;
  /** 本次调用获准的越界能力。 */
  granted?: CapabilityGrant;
  /** 未获批准的原因（`denied` / `timeout`）。批准时不出现。 */
  refusal?: AuthorizationRefusal;
  reason?: string;
  at: number;
}

export type GateDecisionListener = (record: GateDecision) => void;

/**
 * 请求**按次**授权一次越界操作。返回 true 表示用户批准这一次。
 *
 * 注意是"这一次" —— 实现方**不得**顺手改档位。TUI 用弹窗实现，
 * CLI 用 stdin 问答实现。
 */
export type EscalationHandler = (
  request: PermissionRequest,
  needed: SandboxMode,
) => Promise<AuthorizationOutcome>;

/**
 * 本次调用需要下发给工具哪些越界授权。
 *
 * 目前只有 `writeOutside` 一个维度 —— 联网走的是另一条按次路径
 * （bash 失败后由 `onRequestCapability` 申请，见 src/tools/bash.ts）。
 */
function grantFor(requires: ModeRequirement | undefined): CapabilityGrant | undefined {
  if (requires?.writeOutside !== true) return undefined;
  return { writeOutside: true };
}

/**
 * 越界被拒时回给模型的理由。
 *
 * 三种"没批准"必须说清是哪一种，否则模型只会反复重试同一条命令：
 *   - `timeout`    没人应答（用户走开 / 无人值守）
 *   - `denied`     用户明确拒绝
 *   - 没有 handler 压根没有可问的入口（CLI 无 TTY、daemon 无 UI）
 */
function escalationReason(
  refusal: AuthorizationRefusal,
  requirement: ModeRequirement,
  needed: SandboxMode,
  hasHandler: boolean,
): string {
  const head = hasHandler ? (describeOutcome(refusal) ?? AUTHORIZATION_DENIED) : "没有可交互的确认入口";
  return (
    `${head}：${describeRequirement(requirement)}需要逐次批准。` +
    `想免去逐次询问就用 --mode ${needed} 启动`
  );
}

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

  /**
   * 直接改档位。给"持有闸门的那一方"用 —— 用户主动切换时调它。
   *
   * 注意 TUI 走的是另一条路（`#reconfigureRuntime` 重建整个 runtime），
   * 所以这里目前只有测试在用。**工具调用永远不会调它**：越界一律按次授权，
   * 见 `check()` 的说明。
   */
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

    // 2) 越出默认批准范围 —— 按次授权。批准只影响这一次调用，不改档位。
    if (request.requires !== undefined && !defaultApproves(this.#mode, request.requires)) {
      const needed = minimumModeFor(request.requires);
      const outcome: AuthorizationOutcome =
        this.#onEscalate === undefined ? "denied" : await this.#onEscalate(request, needed);

      if (outcome !== "approved") {
        return this.#finish(request, evaluated.decision, {
          allowed: false,
          refusal: outcome,
          reason: escalationReason(
            outcome,
            request.requires,
            needed,
            this.#onEscalate !== undefined,
          ),
        });
      }

      return this.#finish(request, evaluated.decision, {
        allowed: true,
        grant: grantFor(request.requires) ?? {},
      });
    }

    // 3) 显式询问
    if (evaluated.decision === "ask") {
      if (this.#prompter === undefined) {
        return this.#finish(request, evaluated.decision, {
          allowed: false,
          reason: "需要用户确认，但当前没有可交互的确认入口",
        });
      }
      const outcome = await this.#prompter.ask(request);
      if (outcome === "approved") {
        return this.#finish(request, evaluated.decision, { allowed: true });
      }
      return this.#finish(request, evaluated.decision, {
        allowed: false,
        refusal: outcome,
        reason: describeOutcome(outcome) ?? AUTHORIZATION_DENIED,
      });
    }

    // 4) 放行：档位已经保证了边界。
    //
    // 这里仍要下发 grant —— 默认批准"一切"的档位（no-sandbox）下，
    // 写工作区外不需要问，但工具仍要知道本次获准越界，否则它自己会把
    // 路径锁回工作区，表现为"闸门放行了、工具还是写不动"。
    const grant = grantFor(request.requires);
    return this.#finish(request, evaluated.decision, {
      allowed: true,
      ...(grant !== undefined ? { grant } : {}),
    });
  }

  #finish(
    request: PermissionRequest,
    decision: PermissionDecision,
    verdict: GateVerdict,
  ): GateVerdict {
    this.#onDecision?.({
      request,
      decision,
      allowed: verdict.allowed,
      mode: this.#mode,
      at: Date.now(),
      ...(verdict.grant !== undefined ? { granted: verdict.grant } : {}),
      ...(verdict.refusal !== undefined ? { refusal: verdict.refusal } : {}),
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    });
    return verdict;
  }
}
