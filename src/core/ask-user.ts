/**
 * ask_user 的问答协议 —— 模型侧（工具 schema/回传格式）与 UI 侧（表单流程）
 * 共享的中立契约。
 *
 * 放在 core 而不是 tui/tools：tools 和 UI 都依赖 core，方向才是对的
 * （早期放在 tui/ask-user.ts 里，导致 core/loop 反向 import UI 模块）。
 */

export const MAX_QUESTIONS = 5;
export const MAX_OPTIONS = 4;

const OPTION_LABELS = ["A", "B", "C", "D"] as const;

export interface AskUserQuestion {
  question: string;
  options: string[];
  /** 显式声明多选；否则默认单选。 */
  multiple?: boolean;
  /** 敏感输入：输入态用 • 遮蔽，汇总页不回显明文。 */
  secret?: boolean;
}

export interface AskUserAnswer {
  question: string;
  /** 选中的选项下标（单选时最多一个）。 */
  selected: number[];
  /** 用户按 e 输入的自定义答案。 */
  custom?: string;
}

/** 选项下标 -> 显示标签（A/B/C/D…）。UI 与 formatAnswers 共用一套。 */
export function optionLabel(index: number): string {
  return OPTION_LABELS[index] ?? String(index + 1);
}

/** 把答案渲染成回传给模型的文本。 */
export function formatAnswers(answers: readonly AskUserAnswer[]): string {
  const blocks = answers.map((answer, index) => {
    const lines = [`${index + 1}. ${answer.question}`];

    if (answer.selected.length > 0) {
      lines.push(`   选择：${answer.selected.map((i) => optionLabel(i)).join("、")}`);
    }
    if (answer.custom !== undefined) {
      lines.push(`   补充：${answer.custom}`);
    }
    if (answer.selected.length === 0 && answer.custom === undefined) {
      lines.push("   回答：（用户未作答）");
    }

    return lines.join("\n");
  });

  return blocks.join("\n\n");
}
