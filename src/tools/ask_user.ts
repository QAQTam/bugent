/**
 * ask_user —— 让模型主动向用户澄清。
 *
 * 这是 agent 从"单向执行"变成"会提问"的分水岭：以前遇到歧义只能猜，
 * 现在可以停下来问清楚。
 *
 * 纪律写进了 description 里，因为**滥用提问比不问更烦人**：
 * 能从上下文推断的别问，能自己查的别问，只在真的会走错方向时才问。
 */

import type { JSONSchema } from "../provider/types.ts";
import type { AskUserAnswer, AskUserQuestion } from "../tui/ask-user.ts";
import { MAX_OPTIONS, MAX_QUESTIONS } from "../tui/ask-user.ts";
import { formatAnswers } from "../tui/ask-user.ts";
import type { Tool, ToolCtx } from "./types.ts";

export const ASK_USER_TOOL_NAME = "ask_user";
export { MAX_QUESTIONS };

export interface AskUserInput {
  questions?: unknown;
}

export const ASK_USER_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      description: `要问的问题，最多 ${MAX_QUESTIONS} 个。用户用上下键选选项、可以输入自定义答案。`,
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "问题正文，一句话说清" },
          options: {
            type: "array",
            description: `候选项，最多 ${MAX_OPTIONS} 个（界面按 A~D 展示）。留空表示纯自由回答。`,
            items: { type: "string" },
          },
          multiple: {
            type: "boolean",
            description: "是否为多选。省略即单选 —— 只有在确实允许多个答案时才设为 true。",
          },
        },
        required: ["question"],
      },
    },
  },
  required: ["questions"],
};

const DESCRIPTION = [
  "向用户提问以澄清需求。用户会看到分页的选择界面，可以选项也可以自由作答。",
  "",
  "什么时候该用：",
  "- 需求有歧义，且不同理解会导致完全不同的实现方向",
  "- 涉及用户的偏好或业务决策，你无法从代码里推断",
  "- 要做破坏性操作前需要确认范围",
  "",
  "什么时候不该用（重要）：",
  "- 能从当前上下文、代码或文档推断出来的，自己判断",
  "- 能通过读文件 / 跑命令查清楚的，自己去查",
  "- 只是想让用户帮你做本该你做的技术决策",
  "- 一次问超过 5 个问题 —— 说明你该先自己调研",
  "",
  "写法要求：",
  "- 每个问题给出 2~4 个具体、互斥的选项（会显示为 A/B/C/D）",
  "- 选项要能直接指导行动，不要写\"其他\"这类空泛选项（用户本来就能自定义回答）",
  "- 只有确实允许多个答案时才设 multiple: true，否则保持单选",
].join("\n");

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

export function parseQuestions(raw: unknown): AskUserQuestion[] {
  if (!Array.isArray(raw)) {
    throw new Error("questions 必须是数组");
  }
  if (raw.length === 0) {
    throw new Error("questions 不能为空");
  }
  if (raw.length > MAX_QUESTIONS) {
    throw new Error(`一次最多问 ${MAX_QUESTIONS} 个问题，收到 ${raw.length} 个。请先自己调研再问`);
  }

  return raw.map((item, index) => {
    const at = `questions[${index}]`;
    if (item === null || typeof item !== "object") {
      throw new Error(`${at} 必须是对象`);
    }

    const record = item as Record<string, unknown>;
    const question = record.question;
    if (typeof question !== "string" || question.trim().length === 0) {
      throw new Error(`${at}.question 必须是非空字符串`);
    }

    let options: string[] = [];
    if (record.options !== undefined) {
      if (!Array.isArray(record.options)) throw new Error(`${at}.options 必须是字符串数组`);
      if (record.options.length > MAX_OPTIONS) {
        throw new Error(`${at}.options 最多 ${MAX_OPTIONS} 个，收到 ${record.options.length} 个`);
      }
      for (const option of record.options) {
        if (typeof option !== "string" || option.trim().length === 0) {
          throw new Error(`${at}.options 里每一项都必须是非空字符串`);
        }
      }
      options = (record.options as string[]).map((option) => option.trim());
    }

    if (record.multiple !== undefined && typeof record.multiple !== "boolean") {
      throw new Error(`${at}.multiple 必须是布尔值`);
    }
    if (record.multiple === true && options.length === 0) {
      throw new Error(`${at} 是多选但没有选项，用户无从勾选`);
    }

    return {
      question: question.trim(),
      options,
      ...(record.multiple === true ? { multiple: true } : {}),
    };
  });
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

export function createAskUserTool(): Tool<AskUserInput, string> {
  return {
    name: ASK_USER_TOOL_NAME,
    description: DESCRIPTION,
    parameters: ASK_USER_PARAMETERS,
    // 它本身就是"问用户"，不需要再被权限系统拦一道
    defaultPermission: "allow",

    resources() {
      // 交互式问答必须独占；并发工具里同时弹两个 ask_user 会互相覆盖状态。
      return [{ key: "interaction", access: "write" }];
    },

    describe(input: unknown) {
      const raw = (input as AskUserInput | null)?.questions;
      const count = Array.isArray(raw) ? raw.length : 0;
      return { resource: `${count} 个问题`, summary: `向用户提问（${count} 题）` };
    },

    async run(input: AskUserInput, ctx: ToolCtx): Promise<string> {
      const questions = parseQuestions(input.questions);

      if (ctx.askUser === undefined) {
        throw new Error("当前环境没有可交互的界面，无法提问。请基于已有信息自行判断并继续");
      }

      const answers: AskUserAnswer[] | undefined = await ctx.askUser(questions);
      if (answers === undefined) {
        return "用户中止了回答（abort）。不要再追问，基于现有信息继续，并在回答里说明你做了哪些假设。";
      }

      return formatAnswers(answers);
    },
  };
}
