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
import type { ToolExecution, ToolRegistry } from "../tools/types.ts";

export interface LoopHooks {
  onText?(delta: string): void;
  onAssistant?(message: StoredMessage): void;
  onToolCall?(call: ToolCall): void;
  onToolResult?(call: ToolCall, result: ToolExecution): void;
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
  session.appendUser(text);
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
    const pending = new Map<string, PendingCall>();
    let reason: FinishReason = "stop";

    for await (const chunk of session.client.chat(request)) {
      switch (chunk.type) {
        case "text":
          text += chunk.delta;
          hooks.onText?.(chunk.delta);
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

    const assistantMessage = session.appendAssistant(text, calls);
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
      const result = await tools.execute(call, { cwd, signal, callId: call.id });
      hooks.onToolResult?.(call, result);
      session.appendToolResult(call.id, result.ok ? result.output : `Error: ${result.output}`);
    }

    // 带着工具结果回到循环，让模型继续。
  }
}
