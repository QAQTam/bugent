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
      description: `Questions to ask, at most ${MAX_QUESTIONS}.`,
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "Question text." },
          options: {
            type: "array",
            description: `Choices, at most ${MAX_OPTIONS}. Leave empty for a free-form answer.`,
            items: { type: "string" },
          },
          multiple: {
            type: "boolean",
            description: "Allow multiple selections. Defaults to false.",
          },
        },
        required: ["question"],
      },
    },
  },
  required: ["questions"],
};

const DESCRIPTION = "Ask the user a question and wait for the answer.";

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

export function parseQuestions(raw: unknown): AskUserQuestion[] {
  if (!Array.isArray(raw)) {
    throw new Error("questions must be an array");
  }
  if (raw.length === 0) {
    throw new Error("questions must not be empty");
  }
  if (raw.length > MAX_QUESTIONS) {
    throw new Error(`at most ${MAX_QUESTIONS} questions per call, received ${raw.length}. Investigate first, then ask`);
  }

  return raw.map((item, index) => {
    const at = `questions[${index}]`;
    if (item === null || typeof item !== "object") {
      throw new Error(`${at} must be an object`);
    }

    const record = item as Record<string, unknown>;
    const question = record.question;
    if (typeof question !== "string" || question.trim().length === 0) {
      throw new Error(`${at}.question must be a non-empty string`);
    }

    let options: string[] = [];
    if (record.options !== undefined) {
      if (!Array.isArray(record.options)) throw new Error(`${at}.options must be an array of strings`);
      if (record.options.length > MAX_OPTIONS) {
        throw new Error(`${at}.options allows at most ${MAX_OPTIONS}, received ${record.options.length}`);
      }
      for (const option of record.options) {
        if (typeof option !== "string" || option.trim().length === 0) {
          throw new Error(`every entry in ${at}.options must be a non-empty string`);
        }
      }
      options = (record.options as string[]).map((option) => option.trim());
    }

    if (record.multiple !== undefined && typeof record.multiple !== "boolean") {
      throw new Error(`${at}.multiple must be a boolean`);
    }
    if (record.multiple === true && options.length === 0) {
      throw new Error(`${at} is multi-select but has no options`);
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
        throw new Error("no interactive UI is available, so asking is impossible. Decide from the information you have and continue");
      }

      const answers: AskUserAnswer[] | undefined = await ctx.askUser(questions);
      if (answers === undefined) {
        return "the user aborted the question. Do not ask again; continue with what you have and state your assumptions in the answer.";
      }

      return formatAnswers(answers);
    },
  };
}
