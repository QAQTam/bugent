/**
 * Agent supervisor and control plane — P7-B.
 *
 * This is deliberately an in-memory control plane. Transport execution is
 * injected through `AgentExecutor`; P7-C will provide the first in-process
 * implementation. The supervisor owns identity validation, lifecycle
 * transitions, cancellation, event sequencing, and parent/child attenuation.
 */

import { randomUUID } from "node:crypto";
import {
  assertAuthorityAttenuation,
  assertCapabilityAttenuation,
  type AgentEventId,
  type AgentId,
  type AgentIdentity,
  type AgentMessageId,
  type AgentResult,
  type AgentStatus,
  type AgentTaskId,
  type AgentBudget,
  type AgentAuthority,
  type AgentCapability,
} from "./model.ts";
import type { AgentSandboxSpec } from "./sandbox.ts";

export type AgentEventType =
  | "agent.started"
  | "agent.state_changed"
  | "agent.message"
  | "agent.tool_call"
  | "agent.tool_result"
  | "agent.waiting_input"
  | "agent.completed"
  | "agent.blocked"
  | "agent.error"
  | "agent.aborted";

export interface AgentEvent {
  readonly id: AgentEventId;
  readonly seq: number;
  readonly agentId: AgentId;
  readonly parentId?: AgentId;
  readonly taskId?: AgentTaskId;
  readonly type: AgentEventType;
  readonly payload: unknown;
  readonly createdAt: number;
}

export type AgentMessageType =
  | "task.assigned"
  | "task.progress"
  | "task.question"
  | "task.answer"
  | "task.artifact"
  | "task.result"
  | "task.cancel"
  | "task.error";

export interface AgentMessage {
  readonly id: AgentMessageId;
  readonly seq: number;
  readonly from: AgentId;
  readonly to: AgentId;
  readonly taskId?: AgentTaskId;
  readonly replyTo?: AgentMessageId;
  readonly type: AgentMessageType;
  readonly payload: unknown;
  readonly createdAt: number;
}

export interface AgentMessageDraft {
  readonly type: AgentMessageType;
  readonly payload: unknown;
  readonly taskId?: AgentTaskId;
  readonly replyTo?: AgentMessageId;
}

export interface AgentTask {
  readonly id: AgentTaskId;
  readonly title: string;
  readonly instructions: string;
}

export interface AgentSpec {
  readonly identity: AgentIdentity;
  readonly task: AgentTask;
  readonly budget: AgentBudget;
  readonly sandbox: AgentSandboxSpec;
  /**
   * Explicit policy for a parent that lives outside this supervisor (for
   * example the interactive main agent). Without this, a missing parent is an
   * error; the supervisor never trusts a child spec to authorize itself.
   */
  readonly externalParent?: ExternalAgentParent;
}

export interface ExternalAgentParent {
  readonly agentId: AgentId;
  readonly rootId: AgentId;
  readonly authority: AgentAuthority;
  readonly capabilities: readonly AgentCapability[];
  readonly depth: number;
  readonly maxDepth: number;
}

export interface AgentExecutionContext {
  readonly spec: AgentSpec;
  readonly signal: AbortSignal;
  /** Emit a low-frequency progress notification into the event plane. */
  report(summary: string, data?: unknown): void;
  /** Wait for the next control/data message addressed to this agent. */
  receive(): Promise<AgentMessage | undefined>;
  /** Send an untrusted data message to the parent; never a control command. */
  sendToParent(message: AgentMessageDraft): Promise<void>;
}

export interface AgentExecutor {
  run(context: AgentExecutionContext): Promise<AgentResult>;
  /** Optional out-of-process notification hook. In-process executors use receive(). */
  send?(agentId: AgentId, message: AgentMessage, signal: AbortSignal): Promise<void>;
  cancel?(agentId: AgentId, reason: string | undefined, signal: AbortSignal): Promise<void>;
  dispose?(): Promise<void>;
}

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AgentHandle {
  readonly id: AgentId;
  readonly parentId: AgentId | undefined;
  readonly kind: AgentIdentity["kind"];
  readonly status: AgentStatus;
  readonly result: AgentResult | undefined;

  send(message: AgentMessageDraft): Promise<void>;
  followup(task: string): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  cancel(): Promise<void>;
}

export interface AgentSupervisor {
  spawn(spec: AgentSpec): Promise<AgentHandle>;
  get(agentId: string): AgentHandle | undefined;
  list(parentId?: string): AgentHandle[];
  wait(agentId: string, options?: WaitOptions): Promise<AgentResult>;
  cancel(agentId: string, reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentSupervisorOptions {
  readonly executor?: AgentExecutor;
  readonly now?: () => number;
}

interface InternalAgent {
  readonly spec: AgentSpec;
  readonly depth: number;
  status: AgentStatus;
  result: AgentResult | undefined;
  readonly controller: AbortController;
  readonly waiters: Set<(result: AgentResult) => void>;
  readonly messageQueue: AgentMessage[];
  readonly receiveWaiters: Set<(message: AgentMessage | undefined) => void>;
  readonly handle: AgentHandleImpl;
}

interface InternalEventInput {
  readonly agentId: AgentId;
  readonly parentId?: AgentId;
  readonly taskId?: AgentTaskId;
  readonly type: AgentEventType;
  readonly payload: unknown;
}

const TRANSITIONS: Readonly<Record<AgentStatus, readonly AgentStatus[]>> = {
  starting: ["running", "error", "aborted"],
  running: ["waiting_input", "idle", "completed", "blocked", "error", "aborted"],
  waiting_input: ["running", "completed", "blocked", "error", "aborted"],
  idle: ["running", "completed", "blocked", "error", "aborted"],
  blocked: ["running", "completed", "error", "aborted"],
  completed: [],
  error: ["running", "aborted"],
  aborted: [],
};

export function canTransitionAgentStatus(from: AgentStatus, to: AgentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`agent supervisor: ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function validateBudget(budget: AgentBudget): void {
  for (const [key, value] of Object.entries(budget) as [
    keyof AgentBudget,
    number,
  ][]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`agent supervisor: budget.${key} 必须是正的安全整数`);
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class AgentEventBus {
  readonly #events: AgentEvent[] = [];
  readonly #sequences = new Map<AgentId, number>();
  readonly #listeners = new Set<{
    readonly listener: (event: AgentEvent) => void;
    readonly agentId?: AgentId;
  }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  append(input: InternalEventInput): AgentEvent {
    const seq = (this.#sequences.get(input.agentId) ?? 0) + 1;
    this.#sequences.set(input.agentId, seq);
    const event: AgentEvent = Object.freeze({
      id: `evt_${randomUUID()}`,
      seq,
      agentId: input.agentId,
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      type: input.type,
      payload: input.payload,
      createdAt: this.#now(),
    });
    this.#events.push(event);
    for (const subscription of this.#listeners) {
      if (subscription.agentId !== undefined && subscription.agentId !== event.agentId) {
        continue;
      }
      try {
        subscription.listener(event);
      } catch {
        // UI listeners cannot break the control plane.
      }
    }
    return event;
  }

  subscribe(listener: (event: AgentEvent) => void, agentId?: AgentId): () => void {
    const subscription = {
      listener,
      ...(agentId !== undefined ? { agentId } : {}),
    };
    this.#listeners.add(subscription);
    return () => {
      this.#listeners.delete(subscription);
    };
  }

  list(agentId?: AgentId): AgentEvent[] {
    return agentId === undefined
      ? [...this.#events]
      : this.#events.filter((event) => event.agentId === agentId);
  }
}

class AgentHandleImpl implements AgentHandle {
  readonly id: AgentId;
  readonly parentId: AgentId | undefined;
  readonly kind: AgentIdentity["kind"];
  readonly #supervisor: AgentSupervisorImpl;

  constructor(
    supervisor: AgentSupervisorImpl,
    id: AgentId,
    parentId: AgentId | undefined,
    kind: AgentIdentity["kind"],
  ) {
    this.#supervisor = supervisor;
    this.id = id;
    this.parentId = parentId;
    this.kind = kind;
  }

  get status(): AgentStatus {
    return this.#supervisor.requireInternal(this.id).status;
  }

  get result(): AgentResult | undefined {
    return this.#supervisor.requireInternal(this.id).result;
  }

  send(message: AgentMessageDraft): Promise<void> {
    return this.#supervisor.send(this.id, message);
  }

  followup(task: string): Promise<void> {
    return this.#supervisor.followup(this.id, task);
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    return this.#supervisor.subscribe(listener, this.id);
  }

  cancel(): Promise<void> {
    return this.#supervisor.cancel(this.id);
  }
}

export class AgentSupervisorImpl implements AgentSupervisor {
  readonly #agents = new Map<AgentId, InternalAgent>();
  readonly #events: AgentEventBus;
  readonly #messages: AgentMessage[] = [];
  readonly #messageSequences = new Map<AgentId, number>();
  readonly #executor: AgentExecutor | undefined;

  constructor(options: AgentSupervisorOptions = {}) {
    this.#events = new AgentEventBus(options.now ?? Date.now);
    this.#executor = options.executor;
  }

  get events(): AgentEventBus {
    return this.#events;
  }

  async spawn(spec: AgentSpec): Promise<AgentHandle> {
    this.#validateSpec(spec);
    const identity = spec.identity;
    if (this.#agents.has(identity.agentId)) {
      throw new Error(`agent supervisor: agent 已存在：${identity.agentId}`);
    }

    let depth = 0;
    if (identity.parentId !== undefined) {
      const parent = this.#agents.get(identity.parentId);
      if (parent !== undefined) {
        if (identity.rootId !== parent.spec.identity.rootId) {
          throw new Error("agent supervisor: 子 agent rootId 必须与父 agent 一致");
        }
        if (identity.sessionId === parent.spec.identity.sessionId) {
          throw new Error("agent supervisor: 子 agent 不能复用父 session");
        }
        assertAuthorityAttenuation(spec.sandbox.authority, parent.spec.sandbox.authority);
        assertCapabilityAttenuation(spec.sandbox.capabilities, parent.spec.sandbox.capabilities);
        depth = parent.depth + 1;
        if (depth > parent.spec.sandbox.maxDepth) {
          throw new Error(`agent supervisor: 超过父 agent maxDepth=${parent.spec.sandbox.maxDepth}`);
        }
      } else {
        const external = spec.externalParent;
        if (external === undefined || external.agentId !== identity.parentId) {
          throw new Error(`agent supervisor: 父 agent 不存在：${identity.parentId}`);
        }
        if (identity.rootId !== external.rootId) {
          throw new Error("agent supervisor: 子 agent rootId 必须与外部父 agent 一致");
        }
        assertAuthorityAttenuation(spec.sandbox.authority, external.authority);
        assertCapabilityAttenuation(spec.sandbox.capabilities, external.capabilities);
        depth = external.depth + 1;
        if (depth > external.maxDepth) {
          throw new Error(`agent supervisor: 超过外部父 agent maxDepth=${external.maxDepth}`);
        }
      }
    } else if (identity.rootId !== identity.agentId) {
      throw new Error("agent supervisor: 根 agent 的 rootId 必须等于 agentId");
    }

    for (const existing of this.#agents.values()) {
      if (existing.spec.identity.sessionId === identity.sessionId) {
        throw new Error(`agent supervisor: session 已被 agent 使用：${identity.sessionId}`);
      }
    }

    const controller = new AbortController();
    const internal = {} as InternalAgent;
    const handle = new AgentHandleImpl(this, identity.agentId, identity.parentId, identity.kind);
    Object.assign(internal, {
      spec,
      depth,
      status: "starting" as AgentStatus,
      result: undefined,
      controller,
      waiters: new Set(),
      messageQueue: [],
      receiveWaiters: new Set(),
      handle,
    });
    this.#agents.set(identity.agentId, internal);

    this.#events.append({
      agentId: identity.agentId,
      ...(identity.parentId !== undefined ? { parentId: identity.parentId } : {}),
      ...(identity.taskId !== undefined ? { taskId: identity.taskId } : {}),
      type: "agent.started",
      payload: { kind: identity.kind },
    });
    this.#transition(internal, "running");

    if (this.#executor !== undefined) {
      void this.#executor
        .run(this.#executionContext(internal))
        .then((result) => this.#finish(internal, result))
        .catch((error: unknown) => {
          this.#finish(internal, {
            agentId: identity.agentId,
            ...(identity.taskId !== undefined ? { taskId: identity.taskId } : {}),
            status: controller.signal.aborted ? "aborted" : "error",
            summary: errorMessage(error),
            artifacts: [],
          });
        });
    }

    return handle;
  }

  get(agentId: string): AgentHandle | undefined {
    return this.#agents.get(agentId)?.handle;
  }

  list(parentId?: string): AgentHandle[] {
    return [...this.#agents.values()]
      .filter((agent) => parentId === undefined || agent.spec.identity.parentId === parentId)
      .map((agent) => agent.handle);
  }

  wait(agentId: string, options: WaitOptions = {}): Promise<AgentResult> {
    const internal = this.requireInternal(agentId);
    if (internal.result !== undefined) return Promise.resolve(internal.result);

    return new Promise<AgentResult>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        internal.waiters.delete(onResult);
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onResult = (result: AgentResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("agent supervisor: wait 已取消"));
      };
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(new Error(`agent supervisor: wait 超时（${options.timeoutMs}ms）`));
            }, options.timeoutMs);

      internal.waiters.add(onResult);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) onAbort();
    });
  }

  async send(agentId: string, draft: AgentMessageDraft): Promise<void> {
    const internal = this.requireInternal(agentId);
    if (internal.status === "completed" || internal.status === "aborted") {
      throw new Error(`agent supervisor: agent ${agentId} 已结束，不能接收消息`);
    }
    const from = internal.spec.identity.parentId ?? "supervisor";
    await this.#post(from, internal, draft);
  }

  async followup(agentId: string, task: string): Promise<void> {
    const internal = this.requireInternal(agentId);
    if (internal.status === "completed" || internal.status === "aborted") {
      throw new Error(`agent supervisor: agent ${agentId} 已结束，不能 followup`);
    }
    if (
      internal.status === "idle" ||
      internal.status === "blocked" ||
      internal.status === "error" ||
      internal.status === "waiting_input"
    ) {
      internal.result = undefined;
      this.#transition(internal, "running");
    }
    await this.#post(internal.spec.identity.parentId ?? "supervisor", internal, {
      type: "task.assigned",
      payload: { task },
      taskId: internal.spec.task.id,
    });
  }

  subscribe(listener: (event: AgentEvent) => void, agentId?: AgentId): () => void {
    return this.#events.subscribe(listener, agentId);
  }

  async cancel(agentId: string, reason?: string): Promise<void> {
    const internal = this.requireInternal(agentId);
    if (internal.status === "completed" || internal.status === "aborted") return;

    try {
      await this.#executor?.cancel?.(agentId, reason, internal.controller.signal);
    } finally {
      internal.controller.abort();
      this.#resolveReceiveWaiters(internal, undefined);
      this.#finish(internal, {
        agentId,
        ...(internal.spec.identity.taskId !== undefined
          ? { taskId: internal.spec.identity.taskId }
          : {}),
        status: "aborted",
        summary: reason ?? "agent cancelled",
        artifacts: [],
      });
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(
      this.list()
        .filter((handle) => handle.status !== "completed" && handle.status !== "aborted")
        .map((handle) => this.cancel(handle.id, "supervisor disposed")),
    );
    await this.#executor?.dispose?.();
    this.#agents.clear();
  }

  messages(agentId?: AgentId): AgentMessage[] {
    return agentId === undefined
      ? [...this.#messages]
      : this.#messages.filter((message) => message.to === agentId || message.from === agentId);
  }

  requireInternal(agentId: string): InternalAgent {
    const internal = this.#agents.get(agentId);
    if (internal === undefined) throw new Error(`agent supervisor: 未知 agent：${agentId}`);
    return internal;
  }

  #executionContext(internal: InternalAgent): AgentExecutionContext {
    return Object.freeze({
      spec: internal.spec,
      signal: internal.controller.signal,
      report: (summary: string, data?: unknown): void => {
        this.#events.append({
          agentId: internal.spec.identity.agentId,
          ...(internal.spec.identity.parentId !== undefined
            ? { parentId: internal.spec.identity.parentId }
            : {}),
          ...(internal.spec.identity.taskId !== undefined
            ? { taskId: internal.spec.identity.taskId }
            : {}),
          type: "agent.message",
          payload: { summary, ...(data !== undefined ? { data } : {}) },
        });
      },
      receive: (): Promise<AgentMessage | undefined> => this.#receive(internal),
      sendToParent: (draft: AgentMessageDraft): Promise<void> =>
        this.#post(internal.spec.identity.agentId, internal, draft, true),
    });
  }

  #receive(internal: InternalAgent): Promise<AgentMessage | undefined> {
    const queued = internal.messageQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (internal.controller.signal.aborted) return Promise.resolve(undefined);
    if (internal.status === "running") this.#transition(internal, "waiting_input");
    return new Promise<AgentMessage | undefined>((resolve) => {
      internal.receiveWaiters.add(resolve);
    });
  }

  async #post(
    from: AgentId,
    target: InternalAgent,
    draft: AgentMessageDraft,
    outbound = false,
  ): Promise<void> {
    const to = outbound
      ? target.spec.identity.parentId ?? "supervisor"
      : target.spec.identity.agentId;
    const seq = (this.#messageSequences.get(to) ?? 0) + 1;
    this.#messageSequences.set(to, seq);
    const message: AgentMessage = Object.freeze({
      id: `msg_${randomUUID()}`,
      seq,
      from,
      to,
      ...(draft.taskId !== undefined ? { taskId: draft.taskId } : {}),
      ...(draft.replyTo !== undefined ? { replyTo: draft.replyTo } : {}),
      type: draft.type,
      payload: draft.payload,
      createdAt: Date.now(),
    });
    this.#messages.push(message);
    this.#events.append({
      agentId: target.spec.identity.agentId,
      ...(target.spec.identity.parentId !== undefined
        ? { parentId: target.spec.identity.parentId }
        : {}),
      ...(target.spec.identity.taskId !== undefined
        ? { taskId: target.spec.identity.taskId }
        : {}),
      type: "agent.message",
      payload: message,
    });

    if (outbound) {
      const parentId = target.spec.identity.parentId;
      const parent = parentId === undefined ? undefined : this.#agents.get(parentId);
      if (parent !== undefined) await this.#deliver(parent, message);
      return;
    }

    await this.#deliver(target, message);
  }

  async #deliver(target: InternalAgent, message: AgentMessage): Promise<void> {
    if (
      (message.type === "task.assigned" || message.type === "task.answer") &&
      (target.status === "waiting_input" ||
        target.status === "idle" ||
        target.status === "blocked" ||
        target.status === "error")
    ) {
      target.result = undefined;
      this.#transition(target, "running");
    }

    const waiter = target.receiveWaiters.values().next().value as
      | ((message: AgentMessage | undefined) => void)
      | undefined;
    if (waiter !== undefined) {
      target.receiveWaiters.delete(waiter);
      waiter(message);
    } else {
      target.messageQueue.push(message);
    }

    await this.#executor?.send?.(
      target.spec.identity.agentId,
      message,
      target.controller.signal,
    );
  }

  #resolveReceiveWaiters(
    internal: InternalAgent,
    message: AgentMessage | undefined,
  ): void {
    for (const waiter of internal.receiveWaiters) waiter(message);
    internal.receiveWaiters.clear();
  }

  #finish(internal: InternalAgent, result: AgentResult): void {
    if (internal.status === "completed" || internal.status === "aborted") return;
    const normalized: AgentResult = Object.freeze({
      ...result,
      agentId: internal.spec.identity.agentId,
      ...(internal.spec.identity.taskId !== undefined
        ? { taskId: internal.spec.identity.taskId }
        : {}),
      summary: result.summary,
      artifacts: Object.freeze([...(result.artifacts ?? [])]),
    });
    const next = normalized.status;
    this.#transition(internal, next);
    internal.result = normalized;
    this.#resolveReceiveWaiters(internal, undefined);

    const eventType: AgentEventType =
      next === "completed"
        ? "agent.completed"
        : next === "blocked"
          ? "agent.blocked"
          : next === "aborted"
            ? "agent.aborted"
            : "agent.error";
    this.#events.append({
      agentId: internal.spec.identity.agentId,
      ...(internal.spec.identity.parentId !== undefined
        ? { parentId: internal.spec.identity.parentId }
        : {}),
      ...(internal.spec.identity.taskId !== undefined
        ? { taskId: internal.spec.identity.taskId }
        : {}),
      type: eventType,
      payload: normalized,
    });

    for (const waiter of internal.waiters) waiter(normalized);
    internal.waiters.clear();
  }

  #transition(internal: InternalAgent, next: AgentStatus): void {
    const previous = internal.status;
    if (previous === next) return;
    if (!canTransitionAgentStatus(previous, next)) {
      throw new Error(`agent supervisor: 非法状态迁移 ${previous} -> ${next}`);
    }
    internal.status = next;
    this.#events.append({
      agentId: internal.spec.identity.agentId,
      ...(internal.spec.identity.parentId !== undefined
        ? { parentId: internal.spec.identity.parentId }
        : {}),
      ...(internal.spec.identity.taskId !== undefined
        ? { taskId: internal.spec.identity.taskId }
        : {}),
      type: "agent.state_changed",
      payload: { from: previous, to: next },
    });
  }

  #validateSpec(spec: AgentSpec): void {
    const identity = spec.identity;
    requireNonEmpty(identity.agentId, "identity.agentId");
    requireNonEmpty(identity.rootId, "identity.rootId");
    requireNonEmpty(identity.sessionId, "identity.sessionId");
    requireNonEmpty(spec.task.id, "task.id");
    requireNonEmpty(spec.task.title, "task.title");
    requireNonEmpty(spec.task.instructions, "task.instructions");
    validateBudget(spec.budget);

    if (spec.sandbox.agentId !== identity.agentId) {
      throw new Error("agent supervisor: sandbox.agentId 必须与 identity.agentId 一致");
    }
    if (spec.sandbox.kind !== identity.kind) {
      throw new Error("agent supervisor: sandbox.kind 必须与 identity.kind 一致");
    }
    if (identity.taskId !== undefined && identity.taskId !== spec.task.id) {
      throw new Error("agent supervisor: identity.taskId 必须与 task.id 一致");
    }
    if (spec.externalParent !== undefined) {
      if (identity.parentId === undefined) {
        throw new Error("agent supervisor: externalParent 只能用于有 parentId 的 agent");
      }
      if (spec.externalParent.agentId !== identity.parentId) {
        throw new Error("agent supervisor: externalParent.agentId 必须等于 identity.parentId");
      }
      requireNonEmpty(spec.externalParent.rootId, "externalParent.rootId");
      if (
        !Number.isSafeInteger(spec.externalParent.depth) ||
        spec.externalParent.depth < 0 ||
        !Number.isSafeInteger(spec.externalParent.maxDepth) ||
        spec.externalParent.maxDepth < 0
      ) {
        throw new Error("agent supervisor: externalParent depth/maxDepth 必须是非负安全整数");
      }
    }
  }
}

export function createAgentSupervisor(options: AgentSupervisorOptions = {}): AgentSupervisorImpl {
  return new AgentSupervisorImpl(options);
}
