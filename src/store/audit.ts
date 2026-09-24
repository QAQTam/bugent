/**
 * 审计流水 —— Phase 10 的安全侧。
 *
 * 落盘四类事件：每轮起止、工具调用与结果、权限决策。
 * 目的不是"日志"，而是**可回放**：出事后能回答
 * "这个 agent 到底执行了什么、是谁批准的"。
 */

import type { LoopHooks } from "../core/loop.ts";
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
      reason: decision.reason,
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
