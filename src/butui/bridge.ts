/**
 * bugent session bootstrap for the experimental buTUI entry.
 *
 * The legacy TUI owns a lot of imperative terminal state. This bridge keeps
 * only the agent-side objects (provider, session, tools, permission gate) so
 * the buTUI view can stay replaceable.
 */

import { loadConfig } from "../config/load.ts";
import { loadSystemPrompt } from "../config/system-prompt.ts";
import { runUserTurn, type LoopHooks, type TurnResult } from "../core/loop.ts";
import { openSession } from "../core/open-session.ts";
import type { AgentSession } from "../core/session.ts";
import { PermissionGate } from "../permission/gate.ts";
import type { SandboxMode } from "../permission/mode.ts";
import { ALLOW_ALL_POLICY, PermissionPolicy, composePolicy } from "../permission/policy.ts";
import type { PermissionRequest } from "../permission/policy.ts";
import { ProviderRegistry, parseModelRef } from "../provider/registry.ts";
import { startConfiguredSkills } from "../skills/runtime.ts";
import { createDefaultTools } from "../tools/builtin.ts";
import type { CapabilityEscalation, ToolRegistry } from "../tools/types.ts";
import { newSessionId } from "../util/id.ts";

export interface BugentButuiInteraction {
  askPermission(request: PermissionRequest): Promise<boolean>;
  confirmModeChange(request: PermissionRequest, needed: SandboxMode): Promise<boolean>;
  requestCapability(escalation: CapabilityEscalation): Promise<boolean>;
}

export interface CreateBugentButuiOptions {
  cwd: string;
  mock?: boolean;
  yes?: boolean;
  interaction: BugentButuiInteraction;
}

export interface BugentButuiRuntime {
  session: AgentSession;
  tools: ToolRegistry;
  mode: SandboxMode;
  providerId: string;
  model: string;
  run(text: string, hooks: LoopHooks, signal: AbortSignal): Promise<TurnResult>;
}

export async function createBugentButuiRuntime(
  options: CreateBugentButuiOptions,
): Promise<BugentButuiRuntime> {
  const loaded = await loadConfig({ cwd: options.cwd });
  const config = loaded.config;
  const registry = new ProviderRegistry();
  for (const provider of config.providers) registry.register(provider);
  if (options.mock) registry.register({ id: "mock", endpoint: "mock" });

  const model = options.mock ? "mock/butui" : config.defaultModel;
  const ref = parseModelRef(model);
  const client = registry.resolve(ref);
  const systemPrompt = await loadSystemPrompt({
    cwd: options.cwd,
    ...(config.agent?.systemPromptFile !== undefined
      ? { file: config.agent.systemPromptFile }
      : {}),
  });
  const skills = await startConfiguredSkills({ config: config.skills, cwd: options.cwd });
  const session = openSession({
    store: undefined,
    sessionId: newSessionId(),
    client,
    model: ref.model,
    providerId: ref.provider,
    systemPrompt: systemPrompt.text,
    skillsManifest: skills.manifest,
    cwd: options.cwd,
  });

  const mode: SandboxMode = config.sandbox?.mode ?? "workspace-write";
  const setup = createDefaultTools({
    mode,
    ...(config.sandbox?.writablePaths !== undefined
      ? { writablePaths: config.sandbox.writablePaths }
      : {}),
    ...(config.sandbox?.passEnv !== undefined ? { passEnv: config.sandbox.passEnv } : {}),
  });
  skills.manager.attach(setup.registry);
  const policy = new PermissionPolicy(
    options.yes
      ? ALLOW_ALL_POLICY
      : composePolicy(config.permissions, setup.defaultPermissionRules),
  );
  const gate = new PermissionGate({
    policy,
    mode: setup.mode,
    prompter: { ask: request => options.interaction.askPermission(request) },
    onEscalate: async (request, needed) =>
      (await options.interaction.confirmModeChange(request, needed)) ? needed : undefined,
  });
  setup.registry.setGate(gate);

  return {
    session,
    tools: setup.registry,
    mode: setup.mode,
    providerId: ref.provider,
    model: ref.model,
    async run(text, hooks, signal) {
      const requestCapability = hooks.onRequestCapability;
      return runUserTurn(session, text, {
        tools: setup.registry,
        cwd: options.cwd,
        signal,
        hooks: {
          ...hooks,
          onRequestCapability: async (call, escalation) =>
            requestCapability !== undefined
              ? requestCapability(call, escalation)
              : options.interaction.requestCapability(escalation),
        },
      });
    },
  };
}
