/**
 * 审计流水 —— Phase 10 的安全侧。
 *
 * 落盘四类事件：每轮起止、工具调用与结果、权限决策。
 * 目的不是"日志"，而是**可回放**：出事后能回答
 * "这个 agent 到底执行了什么、是谁批准的"。
 */

import type { LoopHooks } from "../core/loop.ts";
import type { GateDecision } from "../permission/gate.ts";
import type { SessionStore } from "./repository.ts";

export interface AuditOptions {
  store: SessionStore;
  sessionId: string;
  /** 当前轮次（用于把事件归到某一轮）。 */
  turn: () => number;
  now?: () => number;
}

export class AuditTrail {
  #store: SessionStore;
  #sessionId: string;
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
      sessionId: this.#sessionId,
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
