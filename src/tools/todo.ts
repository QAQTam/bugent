/**
 * todo_write —— 模型自主规划工具。
 *
 * 设计要点：
 *   1. **整写语义**：每次提交完整清单，不是增量改某项。增量同步会引入一堆
 *      "模型以为改了这一项"的 bug，整写则天然幂等。
 *   2. **状态从消息历史派生**：因为整写，当前清单 = 历史里最后一次 todo_write
 *      调用的参数。不需要新表、不需要改 SessionInit —— 持久化和 --resume 白送。
 *   3. **无副作用**：它只改变显示状态，所以默认权限是 allow，不打断用户。
 *
 * 与 P2 的"只追加"铁律天然契合：todo 的演进历史本身就是可回放的。
 */

import type { JSONSchema } from "../provider/types.ts";
import type { StoredMessage } from "../core/message.ts";
import type { Tool, ToolCtx } from "./types.ts";

export const TODO_TOOL_NAME = "todo_write";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  /** 祈使句，具体可验证："补 edit_file 的单测"。 */
  content: string;
  /** 进行时文案（可选）："正在补 edit_file 的单测"。 */
  activeForm?: string;
  status: TodoStatus;
}

const VALID_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

export const TODO_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "完整的待办清单（整写覆盖，不是增量）",
      items: {
        type: "object",
        properties: {
          content: { type: "string", description: "祈使句描述，具体可验证" },
          activeForm: { type: "string", description: "进行时文案，可选" },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed"],
            description: "同一时刻最多一项为 in_progress",
          },
        },
        required: ["content", "status"],
      },
    },
  },
  required: ["todos"],
};

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

/**
 * 校验并归一化模型给的 todos。
 *
 * 严格在这里是有意的：清单是模型自我约束的载体，
 * 放行畸形数据等于放弃了这层约束。
 */
export function parseTodos(raw: unknown): Todo[] {
  if (!Array.isArray(raw)) {
    throw new Error("todos 必须是数组");
  }
  if (raw.length === 0) {
    throw new Error("todos 不能为空；如果任务已全部完成，请保留清单并把各项标为 completed");
  }

  const todos: Todo[] = [];
  let inProgress = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const at = `todos[${index}]`;

    if (item === null || typeof item !== "object") {
      throw new Error(`${at} 必须是对象`);
    }

    const record = item as Record<string, unknown>;
    const content = record.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error(`${at}.content 必须是非空字符串`);
    }

    const status = record.status;
    if (typeof status !== "string" || !VALID_STATUSES.includes(status as TodoStatus)) {
      throw new Error(`${at}.status 必须是 pending / in_progress / completed 之一，收到 ${JSON.stringify(status)}`);
    }

    const activeForm = record.activeForm;
    if (activeForm !== undefined && typeof activeForm !== "string") {
      throw new Error(`${at}.activeForm 必须是字符串`);
    }

    if (status === "in_progress") inProgress += 1;

    todos.push({
      content: content.trim(),
      status: status as TodoStatus,
      ...(typeof activeForm === "string" && activeForm.trim().length > 0
        ? { activeForm: activeForm.trim() }
        : {}),
    });
  }

  if (inProgress > 1) {
    throw new Error(
      `同一时刻最多只能有一项 in_progress，收到 ${inProgress} 项。请把其余项改为 pending，一次只专注一件事`,
    );
  }

  return todos;
}

/** 宽松解析：给渲染层用，畸形数据返回 undefined 而不是抛错。 */
export function tryParseTodos(raw: unknown): Todo[] | undefined {
  try {
    return parseTodos(raw);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* 从消息历史派生当前清单                                                */
/* ------------------------------------------------------------------ */

/**
 * 找出当前生效的待办清单。
 *
 * 从后往前扫，取最后一次成功的 todo_write 调用的参数。
 *
 * "成功"的判断依据是 loop 的既有约定：失败的调用会被写成 `Error: ...`
 * （见 src/core/loop.ts 的 appendToolResult）。没有这层判断的话，
 * 被权限拒绝的清单会被当成生效的，显示一份用户根本没批准的计划。
 */
export function currentTodos(messages: readonly StoredMessage[]): Todo[] {
  const failedCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || message.toolCallId === undefined) continue;
    const text = message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    if (text.startsWith("Error: ")) failedCallIds.add(message.toolCallId);
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined || message.role !== "assistant") continue;
    const calls = message.toolCalls;
    if (calls === undefined) continue;

    for (let j = calls.length - 1; j >= 0; j -= 1) {
      const call = calls[j];
      if (call === undefined || call.name !== TODO_TOOL_NAME) continue;
      if (failedCallIds.has(call.id)) continue;

      const todos = tryParseTodos((call.args as { todos?: unknown } | null)?.todos);
      if (todos !== undefined) return todos;
    }
  }

  return [];
}

/** 统计各状态数量。 */
export function countTodos(todos: readonly Todo[]): Record<TodoStatus, number> {
  const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
  for (const todo of todos) counts[todo.status] += 1;
  return counts;
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

export interface TodoWriteInput {
  todos?: unknown;
}

const DESCRIPTION = [
  "用待办清单规划并跟踪多步任务，用户会实时看到进度。",
  "",
  "什么时候该用：",
  "- 任务需要 3 步以上，或用户一次提了多个要求",
  "- 用户明确要求你先规划",
  "- 开始一项新任务之前",
  "",
  "什么时候不该用：",
  "- 一步就能做完的事（例如\"跑一下测试\"）",
  "- 纯问答、纯解释，没有可执行步骤",
  "",
  "纪律：",
  "- 每次提交**完整清单**（整写覆盖），不是只改某一项",
  "- 同一时刻**最多一项** in_progress",
  "- 开始某项前标为 in_progress，做完立刻标为 completed，不要事后批量补",
  "- 描述要具体可验证：\"补 edit_file 的单测\" 而不是 \"写测试\"",
].join("\n");

export function createTodoWriteTool(): Tool<TodoWriteInput, string> {
  return {
    name: TODO_TOOL_NAME,
    description: DESCRIPTION,
    parameters: TODO_PARAMETERS,
    // 无副作用，只改显示状态 —— 不该为它打断用户
    needsSandbox: false,
    defaultPermission: "allow",

    describe(input: unknown) {
      const raw = (input as TodoWriteInput | null)?.todos;
      const count = Array.isArray(raw) ? raw.length : 0;
      return {
        resource: `${count} 项`,
        summary: `更新待办清单（${count} 项）`,
      };
    },

    async run(input: TodoWriteInput, _ctx: ToolCtx): Promise<string> {
      const todos = parseTodos(input.todos);
      const counts = countTodos(todos);

      const parts = [`共 ${todos.length} 项`];
      if (counts.completed > 0) parts.push(`${counts.completed} 已完成`);
      if (counts.in_progress > 0) parts.push(`${counts.in_progress} 进行中`);
      if (counts.pending > 0) parts.push(`${counts.pending} 待办`);

      return `待办清单已更新：${parts.join("，")}`;
    },
  };
}
