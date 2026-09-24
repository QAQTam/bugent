/**
 * Agent transport — P7-C.
 *
 * A transport is the execution boundary seen by callers. It must not own
 * permission semantics: AgentKind, Authority, capability attenuation and
 * lifecycle remain in the supervisor. InProcessTransport is a thin adapter so
 * a future ACP/socket transport can implement the same surface.
 */

import type { AgentId, AgentResult } from "./model.ts";
import {
  AgentSupervisorImpl,
  createAgentSupervisor,
  type AgentEvent,
  type AgentHandle,
  type AgentMessageDraft,
  type AgentSpec,
  type AgentSupervisorOptions,
  type WaitOptions,
} from "./supervisor.ts";

export type AgentTransportTarget = AgentHandle | AgentId;

export interface AgentTransport {
  readonly kind: string;

  start(spec: AgentSpec): Promise<AgentHandle>;
  get(agentId: AgentId): AgentHandle | undefined;
  list(parentId?: AgentId): AgentHandle[];
  wait(target: AgentTransportTarget, options?: WaitOptions): Promise<AgentResult>;
  send(target: AgentTransportTarget, message: AgentMessageDraft): Promise<void>;
  subscribe(target: AgentTransportTarget, listener: (event: AgentEvent) => void): () => void;
  cancel(target: AgentTransportTarget, reason?: string): Promise<void>;
  close(target: AgentTransportTarget, reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

function targetId(target: AgentTransportTarget): AgentId {
  return typeof target === "string" ? target : target.id;
}

export class InProcessTransport implements AgentTransport {
  readonly kind = "in-process";
  readonly #supervisor: AgentSupervisorImpl;

  constructor(options: AgentSupervisorOptions = {}) {
    this.#supervisor = createAgentSupervisor(options);
  }

  get supervisor(): AgentSupervisorImpl {
    return this.#supervisor;
  }

  start(spec: AgentSpec): Promise<AgentHandle> {
    return this.#supervisor.spawn(spec);
  }

  get(agentId: AgentId): AgentHandle | undefined {
    return this.#supervisor.get(agentId);
  }

  list(parentId?: AgentId): AgentHandle[] {
    return this.#supervisor.list(parentId);
  }

  wait(target: AgentTransportTarget, options: WaitOptions = {}): Promise<AgentResult> {
    return this.#supervisor.wait(targetId(target), options);
  }

  send(target: AgentTransportTarget, message: AgentMessageDraft): Promise<void> {
    return this.#supervisor.send(targetId(target), message);
  }

  subscribe(
    target: AgentTransportTarget,
    listener: (event: AgentEvent) => void,
  ): () => void {
    return this.#supervisor.subscribe(listener, targetId(target));
  }

  cancel(target: AgentTransportTarget, reason?: string): Promise<void> {
    return this.#supervisor.cancel(targetId(target), reason);
  }

  close(target: AgentTransportTarget, reason?: string): Promise<void> {
    return this.cancel(target, reason);
  }

  dispose(): Promise<void> {
    return this.#supervisor.dispose();
  }
}

export function createInProcessTransport(
  options: AgentSupervisorOptions = {},
): InProcessTransport {
  return new InProcessTransport(options);
}
