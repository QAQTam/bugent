import { useState } from "react";
import type { PendingView } from "../state/store";
import { actions } from "../bridge";
import type { AskUserAnswer } from "@protocol";

/** 选项下标 → 显示标签（A/B/C/D…）；与 core/ask-user.ts 的 optionLabel 同口径。 */
function optionLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

/** 待决交互卡（A5/A6）：权限 / 越界能力 / ask_user / 协议角色回退。 */
export function PermissionCard({ pending }: { pending: PendingView }) {
  const questions = pending.questions;
  if (pending.kind === "ask_user" && questions !== undefined) {
    return <AskUserForm requestId={pending.requestId} questions={questions} />;
  }

  const isAlwaysAllowed = pending.kind === "permission";
  return (
    <div className="rounded-xl border border-amber-700/50 bg-amber-950/30 p-4">
      <p className="text-sm font-medium text-amber-200">
        {pending.kind === "permission" ? "权限确认" : pending.kind === "capability" ? "越界能力授权" : "协议角色回退"}
      </p>
      <p className="mt-1 break-all text-sm text-neutral-200">{pending.summary}</p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => actions.resolvePermission(pending.requestId, "approved")}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
        >
          批准
        </button>
        {isAlwaysAllowed && (
          <button
            type="button"
            onClick={() => actions.alwaysAllow(pending.requestId)}
            className="rounded-lg border border-emerald-700 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-900/40"
          >
            总是允许
          </button>
        )}
        <button
          type="button"
          onClick={() => actions.resolvePermission(pending.requestId, "denied")}
          className="rounded-lg bg-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-600"
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

function AskUserForm({
  requestId,
  questions,
}: {
  requestId: string;
  questions: NonNullable<PendingView["questions"]>;
}) {
  const [selected, setSelected] = useState<Record<number, number[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});

  const toggle = (questionIndex: number, optionIndex: number, multiple: boolean): void => {
    setSelected((prev) => {
      const current = prev[questionIndex] ?? [];
      if (multiple) {
        const next = current.includes(optionIndex) ? current.filter((i) => i !== optionIndex) : [...current, optionIndex];
        return { ...prev, [questionIndex]: next };
      }
      return { ...prev, [questionIndex]: current[0] === optionIndex ? [] : [optionIndex] };
    });
  };

  const submit = (): void => {
    const answers: AskUserAnswer[] = questions.map((question, index) => ({
      question: question.question,
      selected: selected[index] ?? [],
      ...(custom[index] !== undefined && custom[index]!.length > 0 ? { custom: custom[index] } : {}),
    }));
    actions.answerAskUser(requestId, answers);
  };

  return (
    <div className="rounded-xl border border-violet-700/50 bg-violet-950/30 p-4">
      <p className="text-sm font-medium text-violet-200">需要你回答</p>
      <div className="mt-2 flex flex-col gap-3">
        {questions.map((question, questionIndex) => (
          <div key={questionIndex}>
            <p className="text-sm text-neutral-100">{question.question}</p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {question.options.map((option, optionIndex) => {
                const active = (selected[questionIndex] ?? []).includes(optionIndex);
                return (
                  <button
                    key={optionIndex}
                    type="button"
                    onClick={() => toggle(questionIndex, optionIndex, question.multiple === true)}
                    className={`rounded-lg border px-2.5 py-1 text-sm ${
                      active
                        ? "border-violet-400 bg-violet-600/30 text-violet-100"
                        : "border-neutral-700 text-neutral-300 hover:bg-neutral-800"
                    }`}
                  >
                    {optionLabel(optionIndex)}. {option}
                  </button>
                );
              })}
            </div>
            <input
              type="text"
              value={custom[questionIndex] ?? ""}
              onChange={(event) => setCustom((prev) => ({ ...prev, [questionIndex]: event.target.value }))}
              placeholder="自定义补充（可留空）"
              className="mt-1.5 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-200 outline-none focus:border-violet-500"
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={submit}
          className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500"
        >
          提交
        </button>
        <button
          type="button"
          onClick={() => actions.abortAskUser(requestId)}
          className="rounded-lg bg-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-600"
        >
          中止
        </button>
      </div>
    </div>
  );
}
