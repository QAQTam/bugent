/**
 * Agent Loop —— Phase 4。整个 agent 的"大脑"，也是唯一推进对话的地方。
 *
 * 它是一个纯推进器：读 session 上下文 -> 调 ModelClient -> 落消息 -> 执行工具 -> 再来一轮。
 * 它**不认识**任何 provider、任何 endpoint、任何具体工具。
 */

import type {
  ChatRequest,
  FinishReason,
  ToolCall,
  Usage,
} from "../provider/types.ts";
import type { AgentSession } from "./session.ts";
import type { StoredMessage } from "./message.ts";
import type { CapabilityEscalation, ToolExecution, ToolRegistry } from "../tools/types.ts";
import type { AskUserAnswer, AskUserQuestion } from "../tui/ask-user.ts";

export interface LoopHooks {
  /** 用户消息落库后触发；TUI 用它拿到可点击的 msgid。 */
  onUser?(message: StoredMessage): void;
  onText?(delta: string): void;
  /**
   * 思考链路增量。
   *
   * 注意：**不落库、不回传、不进上下文** —— 只在回调里转瞬即逝。
   * 这是有意的：思考内容动辄上万字，留着只会撑爆上下文、拖慢渲染。
   */
  onReasoning?(delta: string): void;
  onAssistant?(message: StoredMessage): void;
  onToolCall?(call: ToolCall): void;
  /** 工具运行中的流式输出（仅用于 UI 展示，不影响回传给模型的结果）。 */
  onToolProgress?(call: ToolCall, chunk: string, stream: "stdout" | "stderr"): void;
  onToolResult?(call: ToolCall, result: ToolExecution, message?: StoredMessage): void;
  /**
   * 工具请求一次性能力授权（目前是联网）。
   *
   * 调用时机是**工具已经真跑过并失败了** —— 所以 escalation 里带着真实命令
   * 与报错，用户知道自己在批准什么。返回 true 表示批准。
   */
  onRequestCapability?(call: ToolCall, escalation: CapabilityEscalation): Promise<boolean>;
  /** 向用户提问。返回 undefined 表示用户中止。 */
  onAskUser?(
    call: ToolCall,
    questions: readonly AskUserQuestion[],
  ): Promise<AskUserAnswer[] | undefined>;
  onUsage?(usage: Usage): void;
}

export interface RunTurnOptions {
  tools?: ToolRegistry;
  hooks?: LoopHooks;
  cwd?: string;
  signal?: AbortSignal;
  /** 单轮内最多几次"模型->工具->模型"往返，防死循环。 */
  maxSteps?: number;
}

export interface TurnResult {
  /** 最后一次 assistant 输出（即给用户看的最终答复）。 */
  text: string;
  /** 最后一次模型要求的工具调用。 */
  toolCalls: ToolCall[];
  steps: number;
  reason: FinishReason;
  usage: Usage;
}

const EMPTY_USAGE: Usage = { input: 0, output: 0 };

function addUsage(total: Usage, delta: Usage): Usage {
  const merged: Usage = { input: total.input + delta.input, output: total.output + delta.output };
  const cached = (total.cached ?? 0) + (delta.cached ?? 0);
  if (cached > 0) merged.cached = cached;
  return merged;
}

/** 流式拼起来的 tool args 是字符串，这里尽力解析。 */
function parseArgs(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { _raw: raw, _parseError: true };
  }
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

/** 把多组 hooks 合成一组（TUI 渲染 + 审计落盘互不干扰）。 */
export function combineHooks(...groups: (LoopHooks | undefined)[]): LoopHooks {
  const active = groups.filter((group): group is LoopHooks => group !== undefined);
  return {
    onUser: (message) => {
      for (const group of active) group.onUser?.(message);
    },
    onText: (delta) => {
      for (const group of active) group.onText?.(delta);
    },
    onReasoning: (delta) => {
      for (const group of active) group.onReasoning?.(delta);
    },
    onAssistant: (message) => {
      for (const group of active) group.onAssistant?.(message);
    },
    onToolCall: (call) => {
      for (const group of active) group.onToolCall?.(call);
    },
    onToolProgress: (call, chunk, stream) => {
      for (const group of active) group.onToolProgress?.(call, chunk, stream);
    },
    onToolResult: (call, result, message) => {
      for (const group of active) group.onToolResult?.(call, result, message);
    },
    // 用户交互只走第一个提供了它的 hook —— 不该被广播多次
    onRequestCapability: async (call, escalation) => {
      for (const group of active) {
        if (group.onRequestCapability !== undefined) {
          return group.onRequestCapability(call, escalation);
        }
      }
      return false;
    },
    onAskUser: async (call, questions) => {
      for (const group of active) {
        if (group.onAskUser !== undefined) return group.onAskUser(call, questions);
      }
      return undefined;
    },
    onUsage: (usage) => {
      for (const group of active) group.onUsage?.(usage);
    },
  };
}

/**
 * 用户发一句话并推进一轮。
 *
 * 存在的意义：把"追加用户消息"这一步收进 API，避免调用方（CLI / TUI）忘记写 session。
 * 之前 TUI 就因为漏了 `appendUser` 导致模型看不到用户输入。
 */
export async function runUserTurn(
  session: AgentSession,
  text: string,
  options: RunTurnOptions = {},
): Promise<TurnResult> {
  const message = session.appendUser(text);
  options.hooks?.onUser?.(message);
  return runTurn(session, options);
}

export async function runTurn(
  session: AgentSession,
  options: RunTurnOptions = {},
): Promise<TurnResult> {
  const hooks = options.hooks ?? {};
  const tools = options.tools;
  const cwd = options.cwd ?? process.cwd();
  const signal = options.signal ?? new AbortController().signal;
  const maxSteps = options.maxSteps ?? 16;

  session.advanceTurn();

  let usage = EMPTY_USAGE;
  let steps = 0;

  for (;;) {
    if (steps >= maxSteps) {
      throw new Error(`单轮超过 ${maxSteps} 步，疑似工具调用死循环`);
    }
    steps += 1;

    session.noteContextSent();

    const schemas = tools?.schemas() ?? [];
    const request: ChatRequest = {
      model: session.model,
      messages: session.buildContext(),
      signal,
      ...(schemas.length > 0 ? { tools: schemas } : {}),
    };

    let text = "";
    let reasoning = "";
    const pending = new Map<string, PendingCall>();
    let reason: FinishReason = "stop";

    for await (const chunk of session.client.chat(request)) {
      switch (chunk.type) {
        case "text":
          text += chunk.delta;
          hooks.onText?.(chunk.delta);
          break;

        case "reasoning":
          // UI 实时展示 + 持久化到当前 assistant 消息，供需要 replay 的 provider 回放。
          reasoning += chunk.delta;
          hooks.onReasoning?.(chunk.delta);
          break;

        case "tool_call": {
          const existing = pending.get(chunk.id);
          if (existing === undefined) {
            pending.set(chunk.id, { id: chunk.id, name: chunk.name, args: chunk.argsDelta });
          } else {
            if (chunk.name.length > 0) existing.name = chunk.name;
            existing.args += chunk.argsDelta;
          }
          break;
        }

        case "usage":
          usage = addUsage(usage, chunk.usage);
          hooks.onUsage?.(chunk.usage);
          break;

        case "done":
          reason = chunk.reason;
          break;
      }
    }

    const calls: ToolCall[] = [...pending.values()].map((acc) => ({
      id: acc.id,
      name: acc.name,
      args: parseArgs(acc.args),
    }));

    const assistantMessage = session.appendAssistant(
      text,
      calls,
      reasoning.length > 0 ? reasoning : undefined,
    );
    hooks.onAssistant?.(assistantMessage);

    if (calls.length === 0) {
      return { text, toolCalls: [], steps, reason, usage };
    }

    if (tools === undefined) {
      for (const call of calls) {
        session.appendToolResult(call.id, `Error: 没有注册任何工具，无法执行 "${call.name}"`);
      }
      return { text, toolCalls: calls, steps, reason, usage };
    }

    for (const call of calls) {
      hooks.onToolCall?.(call);
      const progress = hooks.onToolProgress;
      const requestCapability = hooks.onRequestCapability;
      const askUser = hooks.onAskUser;
      const result = await tools.execute(call, {
        cwd,
        signal,
        callId: call.id,
        sessionId: session.id,
        ...(progress !== undefined
          ? { onProgress: (chunk: string, stream: "stdout" | "stderr") => progress(call, chunk, stream) }
          : {}),
        ...(requestCapability !== undefined
          ? { onRequestCapability: (escalation: CapabilityEscalation) => requestCapability(call, escalation) }
          : {}),
        ...(askUser !== undefined ? { askUser: (qs: readonly AskUserQuestion[]) => askUser(call, qs) } : {}),
      });
      const resultMessage = session.appendToolResult(
        call.id,
        result.ok ? result.output : `Error: ${result.output}`,
        result.workspace,
      );
      hooks.onToolResult?.(call, result, resultMessage);
    }

    // 带着工具结果回到循环，让模型继续。
  }
}
