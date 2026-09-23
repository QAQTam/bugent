/**
 * 工具协议 —— Phase 3 / 6 / 7 共用的地基。
 *
 * 设计要点：**工具本身保持纯净**（只做一件事），权限校验与沙箱包裹在
 * `ToolRegistry.execute` 外层。这样 P3 写完 bash 之后，P6 加沙箱、P7 加文件工具
 * 都不需要回头改工具实现。
 */

import type { JSONSchema, ToolCall, ToolSchema } from "../provider/types.ts";

export interface ToolCtx {
  cwd: string;
  signal: AbortSignal;
  callId: string;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** 标记为 true 时，P6 的沙箱层会强制包裹执行。 */
  needsSandbox?: boolean;
  run(input: I, ctx: ToolCtx): Promise<O>;
}

export interface ToolExecution {
  ok: boolean;
  output: string;
}

export function toToolSchema(tool: Tool): ToolSchema {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** 工具返回值 -> 喂回模型的字符串。 */
export function serializeToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class ToolRegistry {
  #tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.#tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  schemas(): ToolSchema[] {
    return this.list().map(toToolSchema);
  }

  /** 执行一次工具调用；任何异常都被转成 ok:false，绝不让 loop 崩掉。 */
  async execute(call: ToolCall, ctx: ToolCtx): Promise<ToolExecution> {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      const known = this.list().map((t) => t.name).join(", ") || "(空)";
      return { ok: false, output: `未知工具 "${call.name}"，可用：${known}` };
    }

    try {
      const value = await tool.run(call.args, ctx);
      return { ok: true, output: serializeToolOutput(value) };
    } catch (error) {
      return { ok: false, output: errorMessage(error) };
    }
  }
}
