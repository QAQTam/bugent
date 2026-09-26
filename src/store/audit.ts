/**
 * 审计流水 —— Phase 10 的安全侧。
 *
 * 落盘四类事件：每轮起止、工具调用与结果、权限决策。
 * 目的不是"日志"，而是**可回放**：出事后能回答
 * "这个 agent 到底执行了什么、是谁批准的"。
 */

import type { LoopHooks } from "../core/loop.ts";
import {
  type AuthorizationOutcome,
} from "../permission/authorization.ts";
import type { GateDecision } from "../permission/gate.ts";
import type { AgentIntegrationRecord } from "../agent/integrator.ts";
import type { SessionStore } from "./repository.ts";

export interface AuditOptions {
  store: SessionStore;
  /**
   * 当前会话 id。用函数而不是字符串，是为了支持多会话：
   * 用户 `/new` 换会话后，审计流水要跟着切过去。
   */
  sessionId: () => string;
  /** 当前轮次（用于把事件归到某一轮）。 */
  turn: () => number;
  now?: () => number;
}

export class AuditTrail {
  #store: SessionStore;
  #sessionId: () => string;
  #turn: () => number;
  #now: () => number;

  constructor(options: AuditOptions) {
    this.#store = options.store;
    this.#sessionId = options.sessionId;
    this.#turn = options.turn;
    this.#now = options.now ?? (() => Date.now());
  }

  #record(kind: Parameters<SessionStore["appendEvent"]>[0]["kind"], payload: unknown): void {
    const turn = this.#turn();
    this.#store.appendEvent({
      sessionId: this.#sessionId(),
      at: this.#now(),
      kind,
      payload,
      ...(turn > 0 ? { turn } : {}),
    });
  }

  turnStart(): void {
    this.#record("turn_start", { turn: this.#turn() + 1 });
  }

  turnEnd(payload: { steps: number; reason: string }): void {
    this.#record("turn_end", payload);
  }

  error(message: string): void {
    this.#record("error", { message });
  }

  permission(decision: GateDecision): void {
    this.#record("permission", {
      tool: decision.request.tool,
      resource: decision.request.resource,
      summary: decision.request.summary,
      decision: decision.decision,
      allowed: decision.allowed,
      // 档位与本次获准的越界能力都要进审计 —— 只记"允许/拒绝"无法回答
      // "这次为什么允许"：同样的 tool+resource 在不同档位下结论可能相反。
      mode: decision.mode,
      ...(decision.granted !== undefined ? { granted: decision.granted } : {}),
      reason: decision.reason,
    });
  }

  /**
   * 能力授权（联网 / 写工作区外）的按次审批（BUG-023）。
   *
   * bash 的能力授权走 `onRequestCapability`，绕过 gate.check —— 之前这类
   * 最敏感的批准（带网重跑、越界 bind）在审计流水里完全不可见。
   * escalation.details 含命令全文；工具调用本身已有 tool_call 事件，
   * 这里不重复记录命令，只记能力维度与结论。
   */
  capability(record: {
    capability: { network?: boolean; writeOutside?: boolean };
    reason: string;
    outcome: AuthorizationOutcome;
  }): void {
    this.#record("capability", {
      capability: record.capability,
      reason: record.reason,
      outcome: record.outcome,
    });
  }

  /** Integration outcome; intentionally excludes command stdout/stderr. */
  agentIntegration(record: AgentIntegrationRecord): void {
    this.#record("agent_integration", {
      agentId: record.agentId,
      applied: record.applied,
      rolledBack: record.rolledBack,
      baseRevision: record.baseRevision,
      patchDigest: record.patchDigest,
      changedFiles: record.changedFiles,
      rollbackPatch: record.rollbackPatch,
      verifications: record.verifications.map((verification) => ({
        command: verification.command,
        exitCode: verification.exitCode,
        timedOut: verification.timedOut,
        aborted: verification.aborted,
      })),
      failure: record.failure,
    });
  }

  /** session 级配置变更；payload 绝不能包含 API key 明文。 */
  sessionConfig(payload: {
    action: "provider_model_mode" | "provider_profile_create" | "provider_profile_rename" | "provider_profile_copy" | "provider_profile_delete" | "api_key_set" | "api_key_clear";
    providerId?: string;
    model?: string;
    mode?: string;
    fromProviderId?: string;
    toProviderId?: string;
  }): void {
    this.#record("session_config", payload);
  }

  /** 给 loop 用的 hooks：只关心工具调用，不干扰 UI 渲染。 */
  hooks(): LoopHooks {
    return {
      onToolCall: (call) => {
        this.#record("tool_call", { id: call.id, name: call.name, args: call.args });
      },
      onToolResult: (call, result) => {
        this.#record("tool_result", {
          id: call.id,
          name: call.name,
          ok: result.ok,
          output: result.output,
        });
      },
    };
  }
}
