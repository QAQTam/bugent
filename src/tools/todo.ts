/**
 * todo_write —— 模型自主规划工具。
 *
 * 设计要点：
 *   1. **整写语义**：每次提交完整清单，不是增量改某项。增量同步会引入一堆
 *      "模型以为改了这一项"的 bug，整写则天然幂等。
 *   2. **rich snapshot**：清单本身带 summary，单项带稳定 id、进行时文案和完成描述。
 *      这样模型和 UI 都能看到"计划是什么、现在做什么、做完有什么结果"。
 *   3. **状态从消息历史派生**：因为整写，当前清单 = 历史里最后一次 todo_write
 *      调用的参数。不需要新表、不需要改 SessionInit —— 持久化和 --resume 白送。
 *   4. **无副作用**：它只改变显示状态，所以默认权限是 allow，不打断用户。
 *
 * 与 P2 的"只追加"铁律天然契合：todo 的演进历史本身就是可回放的。
 */

import type { JSONSchema } from "../provider/types.ts";
import type { StoredMessage } from "../core/message.ts";
import type { GoalController } from "../goal/controller.ts";
import type { Tool, ToolCtx } from "./types.ts";

export const TODO_TOOL_NAME = "todo_write";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  /** 稳定标识；模型省略时由宿主按位置生成。 */
  id: string;
  /** 祈使句，具体可验证："补 edit_file 的单测"。 */
  content: string;
  /** 进行时文案（可选）："正在补 edit_file 的单测"。 */
  activeForm?: string;
  /** 完成描述或证据（可选），只在 completed 时展示。 */
  completion?: string;
  /** Goal 模式下所属 Checkpoint。 */
  checkpointId?: string;
  /** Goal 模式下 completed 必须提供的结构化证据。 */
  completionEvidence?: string[];
  status: TodoStatus;
}

export interface TodoList {
  /** 整份计划的一句话摘要。 */
  summary?: string;
  todos: Todo[];
}

const VALID_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

export const TODO_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "整份计划的一句话摘要，可选",
    },
    checkpoint_id: {
      type: "string",
      description: "Goal 模式下当前 Checkpoint ID；清单内各项也可以分别提供 checkpointId",
    },
    todos: {
      type: "array",
      description: "完整的待办清单（整写覆盖，不是增量）",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "稳定 id；后续更新与审计引用它。省略时宿主会自动生成",
          },
          content: { type: "string", description: "祈使句描述，具体可验证" },
          activeForm: { type: "string", description: "进行时文案，可选" },
          completion: {
            type: "string",
            description: "完成描述或证据，可选；仅 completed 项使用",
          },
          checkpointId: {
            type: "string",
            description: "Goal 模式下所属 Checkpoint；通常由顶层 checkpoint_id 统一提供",
          },
          completionEvidence: {
            type: "array",
            description: "Goal 模式下 completed 项必须提供；每项应是可核验的产物或命令结果",
            items: { type: "string" },
          },
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

  // 先收集显式 id，避免“某项省略 id 时自动生成的值撞上后面显式 id”。
  const explicitIds = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item === null || typeof item !== "object") continue;
    const id = (item as Record<string, unknown>).id;
    if (id === undefined) continue;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error(`todos[${index}].id 必须是非空字符串`);
    }
    const normalized = id.trim();
    if (explicitIds.has(normalized)) {
      throw new Error(`todos[${index}].id 重复：${normalized}`);
    }
    explicitIds.add(normalized);
  }

  const todos: Todo[] = [];
  const usedIds = new Set<string>();
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

    const completion = record.completion;
    if (completion !== undefined && typeof completion !== "string") {
      throw new Error(`${at}.completion 必须是字符串`);
    }
    if (completion !== undefined && status !== "completed") {
      throw new Error(`${at}.completion 只能用于 completed 项`);
    }

    const checkpointId = record.checkpointId;
    if (checkpointId !== undefined && typeof checkpointId !== "string") {
      throw new Error(`${at}.checkpointId 必须是字符串`);
    }

    let completionEvidence: string[] | undefined;
    if (record.completionEvidence !== undefined) {
      if (!Array.isArray(record.completionEvidence)) {
        throw new Error(`${at}.completionEvidence 必须是字符串数组`);
      }
      completionEvidence = record.completionEvidence.map((evidence, evidenceIndex) => {
        if (typeof evidence !== "string" || evidence.trim().length === 0) {
          throw new Error(`${at}.completionEvidence[${evidenceIndex}] 必须是非空字符串`);
        }
        return evidence.trim();
      });
    }
    if (status === "completed" && completionEvidence !== undefined && completionEvidence.length === 0) {
      throw new Error(`${at}.completionEvidence 不能为空数组`);
    }

    let id: string;
    const rawId = record.id;
    if (typeof rawId === "string" && rawId.trim().length > 0) {
      id = rawId.trim();
    } else {
      let candidate = `todo-${index + 1}`;
      let suffix = 2;
      while (explicitIds.has(candidate) || usedIds.has(candidate)) {
        candidate = `todo-${index + 1}-${suffix}`;
        suffix += 1;
      }
      id = candidate;
    }
    usedIds.add(id);

    if (status === "in_progress") inProgress += 1;

    todos.push({
      id,
      content: content.trim(),
      status: status as TodoStatus,
      ...(typeof activeForm === "string" && activeForm.trim().length > 0
        ? { activeForm: activeForm.trim() }
        : {}),
      ...(typeof completion === "string" && completion.trim().length > 0
        ? { completion: completion.trim() }
        : {}),
      ...(typeof checkpointId === "string" && checkpointId.trim().length > 0
        ? { checkpointId: checkpointId.trim() }
        : {}),
      ...(completionEvidence !== undefined ? { completionEvidence } : {}),
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
export interface CurrentTodoOptions {
  /**
   * 全部 completed 后，等到下一条真实用户消息出现就隐藏。
   * 默认关闭，保持纯历史派生函数的行为可预测。
   */
  hideCompletedAfterUserTurn?: boolean;
}

export function currentTodoList(
  messages: readonly StoredMessage[],
  options: CurrentTodoOptions = {},
): TodoList {
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

      const args = call.args as { summary?: unknown; todos?: unknown } | null;
      const todos = tryParseTodos(args?.todos);
      if (todos !== undefined) {
        if (
          options.hideCompletedAfterUserTurn === true &&
          todos.every((todo) => todo.status === "completed") &&
          messages.some((later) => later.msgid > message.msgid && later.origin === "user")
        ) {
          return { todos: [] };
        }

        const summary =
          typeof args?.summary === "string" && args.summary.trim().length > 0
            ? args.summary.trim()
            : undefined;
        return {
          todos,
          ...(summary !== undefined ? { summary } : {}),
        };
      }
    }
  }

  return { todos: [] };
}

/** 兼容旧调用：只要清单，不要摘要。 */
export function currentTodos(messages: readonly StoredMessage[]): Todo[] {
  return currentTodoList(messages).todos;
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
  summary?: unknown;
  checkpoint_id?: unknown;
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
  "清单可以包含：",
  "- summary：整份计划的一句话摘要",
  "- id：稳定标识，建议用短横线命名，例如 fix-sandbox-ui",
  "- completion：完成项的结果或证据，例如 338 tests pass",
  "",
  "纪律：",
  "- 每次提交**完整清单**（整写覆盖），不是只改某一项",
  "- 同一时刻**最多一项** in_progress",
  "- 开始某项前标为 in_progress，做完立刻标为 completed，不要事后批量补",
  "- 描述要具体可验证：\"补 edit_file 的单测\" 而不是 \"写测试\"",
  "- completed 项尽量写一句 completion，让用户知道结果，不要只留一个勾",
].join("\n");

export interface TodoWriteToolOptions {
  /** Goal 模式下把整写校验与状态推进交给 GoalController。 */
  goalController?: GoalController;
}

export function createTodoWriteTool(
  options: TodoWriteToolOptions = {},
): Tool<TodoWriteInput, string> {
  return {
    name: TODO_TOOL_NAME,
    description:
      options.goalController === undefined
        ? DESCRIPTION
        : [
            DESCRIPTION,
            "",
            "Goal 模式扩展：",
            "- 必须用 checkpoint_id 指定当前 Checkpoint",
            "- completed 项必须提供 completionEvidence",
            "- 只能为当前 Checkpoint 写 Todo，不能提前生成后续阶段清单",
          ].join("\n"),
    parameters: TODO_PARAMETERS,
    // 无副作用，只改显示状态 —— 不该为它打断用户
    needsSandbox: false,
    defaultPermission: "allow",

    describe(input: unknown) {
      const raw = (input as TodoWriteInput | null)?.todos;
      const summary = (input as TodoWriteInput | null)?.summary;
      const count = Array.isArray(raw) ? raw.length : 0;
      const prefix =
        typeof summary === "string" && summary.trim().length > 0 ? `${summary.trim()} · ` : "";
      return {
        resource: `${count} 项`,
        summary: `更新待办清单（${prefix}${count} 项）`,
      };
    },

    async run(input: TodoWriteInput, _ctx: ToolCtx): Promise<string> {
      const todos = parseTodos(input.todos);
      const counts = countTodos(todos);
      const summary =
        typeof input.summary === "string" && input.summary.trim().length > 0
          ? input.summary.trim()
          : undefined;

      const currentGoal = options.goalController?.currentGoal();
      const goal = currentGoal?.status === "complete" ? undefined : currentGoal;
      if (goal !== undefined) {
        const topLevelCheckpoint =
          typeof input.checkpoint_id === "string" && input.checkpoint_id.trim().length > 0
            ? input.checkpoint_id.trim()
            : undefined;
        const checkpointIds = new Set(
          todos
            .map((todo) => todo.checkpointId ?? topLevelCheckpoint)
            .filter((value): value is string => value !== undefined),
        );
        if (checkpointIds.size !== 1) {
          throw new Error("Goal 模式下必须提供唯一的 checkpoint_id");
        }
        const checkpointId = [...checkpointIds][0]!;
        const snapshot = options.goalController!.writeTodos({
          checkpointId,
          ...(summary !== undefined ? { summary } : {}),
          todos: todos.map(({ checkpointId: _checkpointId, ...todo }) => todo),
        });
        return [
          `Goal Checkpoint：${checkpointId}`,
          `Todo snapshot revision：${snapshot.revision}`,
          `共 ${todos.length} 项`,
          counts.completed > 0 ? `${counts.completed} 已完成（含 evidence）` : "",
          counts.in_progress > 0 ? `${counts.in_progress} 进行中` : "",
          counts.pending > 0 ? `${counts.pending} 待办` : "",
        ]
          .filter((line) => line.length > 0)
          .join("\n");
      }

      const parts = [`共 ${todos.length} 项`];
      if (counts.completed > 0) parts.push(`${counts.completed} 已完成`);
      if (counts.in_progress > 0) parts.push(`${counts.in_progress} 进行中`);
      if (counts.pending > 0) parts.push(`${counts.pending} 待办`);

      const idLine = todos.map((todo) => `${todo.id}=${todo.status}`).join(", ");
      return [
        ...(summary !== undefined ? [`计划：${summary}`] : []),
        `待办清单已更新：${parts.join("，")}`,
        `id：${idLine}`,
      ].join("\n");
    },
  };
}
