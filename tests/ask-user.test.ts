import { describe, expect, test } from "bun:test";
import {
  AskUserFlow,
  ESC_WINDOW_MS,
  formatAnswers,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  type AskUserQuestion,
} from "../src/tui/ask-user.ts";
import { createAskUserTool, parseQuestions } from "../src/tools/ask_user.ts";
import type { Key } from "../src/tui/keys.ts";

const text = (value: string): Key => ({ type: "text", value });
const key = (type: Key["type"]): Key => ({ type } as Key);

const QUESTIONS: AskUserQuestion[] = [
  { question: "偏好哪种风格？", options: ["简洁", "详细", "函数式"] },
  { question: "需要哪些内容？", options: ["单测", "文档", "示例"], multiple: true },
  { question: "项目叫什么？", options: [] },
];

/** 可精确控制定时器的 flow，用于测 Esc 双击窗口。 */
function makeFlow(questions: readonly AskUserQuestion[] = QUESTIONS, onChange = () => {}) {
  let pending: (() => void) | undefined;
  const flow = new AskUserFlow({
    questions,
    onChange,
    setTimeoutFn: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimeoutFn: () => {
      pending = undefined;
    },
  });
  return { flow, fireTimer: () => pending?.() };
}

describe("ask_user · 参数校验", () => {
  test("接受合法输入", () => {
    const parsed = parseQuestions([
      { question: "Q1", options: ["a", "b"] },
      { question: "Q2", multiple: true, options: ["x", "y"] },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.multiple).toBe(true);
  });

  test(`最多 ${MAX_QUESTIONS} 个问题`, () => {
    const tooMany = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({ question: `Q${i}` }));
    expect(() => parseQuestions(tooMany)).toThrow(/最多问 5 个问题/);
  });

  test(`每题最多 ${MAX_OPTIONS} 个选项`, () => {
    expect(() =>
      parseQuestions([{ question: "Q", options: ["a", "b", "c", "d", "e"] }]),
    ).toThrow(/最多 4 个/);
  });

  test("拒绝空问题、空选项、非布尔 multiple", () => {
    expect(() => parseQuestions([{ question: "  " }])).toThrow(/非空字符串/);
    expect(() => parseQuestions([{ question: "Q", options: [""] }])).toThrow(/非空字符串/);
    expect(() => parseQuestions([{ question: "Q", multiple: "yes" }])).toThrow(/布尔值/);
  });

  test("多选必须有选项", () => {
    expect(() => parseQuestions([{ question: "Q", multiple: true }])).toThrow(/没有选项/);
  });

  test("拒绝空数组与非数组", () => {
    expect(() => parseQuestions([])).toThrow(/不能为空/);
    expect(() => parseQuestions("nope")).toThrow(/必须是数组/);
  });
});

describe("ask_user · 工具", () => {
  test("describe 给出题数", () => {
    const tool = createAskUserTool();
    expect(tool.describe({ questions: QUESTIONS })).toEqual({
      resource: "3 个问题",
      summary: "向用户提问（3 题）",
    });
  });

  test("没有交互界面时明确报错，而不是静默失败", async () => {
    const tool = createAskUserTool();
    const ctx = { cwd: "/tmp", signal: new AbortController().signal, callId: "c1", sessionId: "s" };

    await expect(tool.run({ questions: QUESTIONS }, ctx)).rejects.toThrow(/没有可交互的界面/);
  });

  test("用户中止时返回 abort 说明，引导模型继续", async () => {
    const tool = createAskUserTool();
    const ctx = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      callId: "c1",
      sessionId: "s",
      askUser: async () => undefined,
    };

    const out = await tool.run({ questions: QUESTIONS }, ctx);
    expect(out).toContain("abort");
    expect(out).toContain("不要再追问");
  });

  test("默认权限是 allow（它本身就是问用户，不该再被拦一道）", () => {
    expect(createAskUserTool().defaultPermission).toBe("allow");
  });
});

describe("ask_user · 选择交互", () => {
  test("单选：↑↓ 直接改变选择", () => {
    const { flow } = makeFlow();
    expect(flow.answers[0]?.selected).toEqual([]);

    flow.handleKey(key("down"));
    expect(flow.answers[0]?.selected).toEqual([1]);

    flow.handleKey(key("up"));
    expect(flow.answers[0]?.selected).toEqual([0]);
  });

  test("单选：选项循环，不会越界", () => {
    const { flow } = makeFlow();
    flow.handleKey(key("up")); // 从 0 往上 -> 最后一个
    expect(flow.answers[0]?.selected).toEqual([2]);
  });

  test("多选：↑↓ 只移动光标，Space 才勾选", () => {
    const { flow } = makeFlow();
    flow.handleKey(key("right")); // 到第 2 题（多选）
    expect(flow.page).toBe(1);

    flow.handleKey(key("down"));
    expect(flow.answers[1]?.selected).toEqual([]); // 移动不勾选

    flow.handleKey(text(" "));
    expect(flow.answers[1]?.selected).toEqual([1]);

    flow.handleKey(key("down"));
    flow.handleKey(text(" "));
    expect(flow.answers[1]?.selected).toEqual([1, 2]);

    // 再按一次取消
    flow.handleKey(text(" "));
    expect(flow.answers[1]?.selected).toEqual([1]);
  });

  test("A~D 字母键快捷选择", () => {
    const { flow } = makeFlow();
    flow.handleKey(text("c"));
    expect(flow.answers[0]?.selected).toEqual([2]);
  });

  test("无选项的题目提示直接输入", () => {
    const { flow } = makeFlow();
    flow.handleKey(key("right"));
    flow.handleKey(key("right"));
    expect(flow.page).toBe(2);
    expect(flow.render(60).join("\n")).toContain("按 e 直接输入");
  });
});

describe("ask_user · 自定义回答", () => {
  test("按 e 进入输入态，Enter 确认", () => {
    const { flow } = makeFlow();
    flow.handleKey(text("e"));
    expect(flow.isTyping).toBe(true);

    for (const ch of "用 Rust 风格") flow.handleKey(text(ch));
    flow.handleKey(key("enter"));

    expect(flow.isTyping).toBe(false);
    expect(flow.answers[0]?.custom).toBe("用 Rust 风格");
  });

  test("输入态暴露硬件光标位置，供 TUI/IME 锚定", () => {
    const { flow } = makeFlow();
    flow.handleKey(text("e"));
    flow.handleKey(text("a"));
    const lines = flow.render(60);
    const cursor = flow.cursorPosition();

    expect(cursor).toBeDefined();
    expect(lines[cursor!.line]).toContain("▸");
    expect(cursor!.column).toBe(3);
  });

  test("secret 问题自动进入输入态，渲染和汇总都不回显明文", () => {
    const { flow } = makeFlow([{ question: "API key", options: [], secret: true }]);
    expect(flow.isTyping).toBe(true);

    for (const ch of "sk-secret") flow.handleKey(text(ch));
    const typingView = flow.render(60).join("\n");
    expect(typingView).toContain("•••••••••");
    expect(typingView).not.toContain("sk-secret");

    flow.handleKey(key("enter"));
    flow.handleKey(key("right")); // 进入汇总页
    const summaryView = flow.render(60).join("\n");
    expect(summaryView).toContain("已隐藏");
    expect(summaryView).not.toContain("sk-secret");
    expect(flow.answers[0]?.custom).toBe("sk-secret");
  });

  test("自定义回答与选项选择并存", () => {
    const { flow } = makeFlow();
    flow.handleKey(key("down")); // 选 B
    flow.handleKey(text("e"));
    for (const ch of "补充说明") flow.handleKey(text(ch));
    flow.handleKey(key("enter"));

    expect(flow.answers[0]?.selected).toEqual([1]);
    expect(flow.answers[0]?.custom).toBe("补充说明");
  });

  test("Backspace 能删字符", () => {
    const { flow } = makeFlow();
    flow.handleKey(text("e"));
    for (const ch of "abc") flow.handleKey(text(ch));
    flow.handleKey(key("backspace"));
    flow.handleKey(key("enter"));
    expect(flow.answers[0]?.custom).toBe("ab");
  });

  test("重新进入输入态时带出已有答案", () => {
    const { flow } = makeFlow();
    flow.handleKey(text("e"));
    flow.handleKey(text("x"));
    flow.handleKey(key("enter"));
    flow.handleKey(text("e"));
    flow.handleKey(text("y"));
    flow.handleKey(key("enter"));
    expect(flow.answers[0]?.custom).toBe("xy");
  });

  test("空白输入不写入答案", () => {
    const { flow } = makeFlow();
    flow.handleKey(text("e"));
    flow.handleKey(text("   "));
    flow.handleKey(key("enter"));
    expect(flow.answers[0]?.custom).toBeUndefined();
  });
});

describe("ask_user · 分页", () => {
  test("→ 前进，← 后退", () => {
    const { flow } = makeFlow();
    expect(flow.page).toBe(0);

    flow.handleKey(key("right"));
    expect(flow.page).toBe(1);

    flow.handleKey(key("left"));
    expect(flow.page).toBe(0);
  });

  test("第一页按 ← 停在原地", () => {
    const { flow } = makeFlow();
    flow.handleKey(key("left"));
    expect(flow.page).toBe(0);
  });

  test("最后一页（汇总）后不再前进", () => {
    const { flow } = makeFlow();
    for (let i = 0; i < 10; i += 1) flow.handleKey(key("right"));
    expect(flow.page).toBe(QUESTIONS.length);
    expect(flow.isSummary).toBe(true);
  });

  test("翻页后光标对到已选项", () => {
    const { flow } = makeFlow();
    flow.handleKey(text("c")); // 第 1 题选 C
    flow.handleKey(key("right"));
    flow.handleKey(key("left"));
    // 回到第 1 题后再按 down 应从 C 往后循环到 A
    flow.handleKey(key("down"));
    expect(flow.answers[0]?.selected).toEqual([0]);
  });
});

describe("ask_user · 汇总与提交", () => {
  test("Enter 提交并带回全部答案", () => {
    const { flow } = makeFlow();

    flow.handleKey(text("b")); // 第 1 题选 B
    flow.handleKey(key("right"));
    flow.handleKey(text(" ")); // 第 2 题勾 A
    flow.handleKey(key("right"));
    flow.handleKey(text("e")); // 第 3 题自由回答
    for (const ch of "my-proj") flow.handleKey(text(ch));
    flow.handleKey(key("enter"));
    flow.handleKey(key("right")); // 到汇总

    const outcome = flow.handleKey(key("enter"));
    expect(outcome.kind).toBe("submit");
    if (outcome.kind !== "submit") return;

    expect(outcome.answers[0]?.selected).toEqual([1]);
    expect(outcome.answers[1]?.selected).toEqual([0]);
    expect(outcome.answers[2]?.custom).toBe("my-proj");
  });

  test("汇总页按 ← 返回上一页", () => {
    const { flow } = makeFlow();
    for (let i = 0; i < 10; i += 1) flow.handleKey(key("right"));
    expect(flow.isSummary).toBe(true);

    flow.handleKey(key("left"));
    expect(flow.isSummary).toBe(false);
    expect(flow.page).toBe(QUESTIONS.length - 1);
  });

  test("汇总页渲染出所有问题与答案", () => {
    const { flow } = makeFlow();
    flow.handleKey(text("a"));
    flow.handleKey(key("right"));
    flow.handleKey(key("right"));
    flow.handleKey(key("right"));

    const rendered = flow.render(70).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(rendered).toContain("汇总");
    expect(rendered).toContain("偏好哪种风格？");
    expect(rendered).toContain("A. 简洁");
    expect(rendered).toContain("未回答"); // 第 2、3 题没答
  });
});

describe("ask_user · Esc 双击终止", () => {
  test("第一次 Esc 只进入待确认，不终止", () => {
    const { flow } = makeFlow();
    const outcome = flow.handleKey(key("escape"));

    expect(outcome.kind).toBe("pending");
    expect(flow.escArmed).toBe(true);
    expect(flow.render(70).join("\n")).toContain("再按一次 Esc");
  });

  test("窗口内第二次 Esc 才真的终止", () => {
    const { flow } = makeFlow();
    flow.handleKey(key("escape"));
    const second = flow.handleKey(key("escape"));

    expect(second.kind).toBe("abort");
    expect(flow.escArmed).toBe(false);
  });

  test(`超过 ${ESC_WINDOW_MS}ms 未再按则自动解除`, () => {
    const { flow, fireTimer } = makeFlow();
    flow.handleKey(key("escape"));
    expect(flow.escArmed).toBe(true);

    fireTimer();
    expect(flow.escArmed).toBe(false);

    // 解除后再按一次不会终止
    expect(flow.handleKey(key("escape")).kind).toBe("pending");
  });

  test("按其它键会解除待确认状态", () => {
    const { flow } = makeFlow();
    flow.handleKey(key("escape"));
    flow.handleKey(key("down"));
    expect(flow.escArmed).toBe(false);
  });

  test("输入态下 Esc 同样走双击语义", () => {
    const { flow } = makeFlow();
    flow.handleKey(text("e"));
    expect(flow.isTyping).toBe(true);

    flow.handleKey(key("escape"));
    expect(flow.escArmed).toBe(true);
    expect(flow.handleKey(key("escape")).kind).toBe("abort");
  });

  test("dispose 清掉定时器", () => {
    const { flow } = makeFlow();
    flow.handleKey(key("escape"));
    flow.dispose();
    expect(flow.escArmed).toBe(true); // 状态没变，但定时器已清
  });
});

describe("ask_user · 鼠标点击", () => {
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

  /** 找到某个选项标签所在的行号（render 输出的下标）。 */
  function rowOf(flow: AskUserFlow, label: string, width = 70): number {
    return flow.render(width).findIndex((line) => strip(line).includes(`${label}.`));
  }

  test("单选：点选项即选中", () => {
    const { flow } = makeFlow();
    const row = rowOf(flow, "C");

    expect(flow.clickLine(row)).toBe(true);
    expect(flow.answers[0]?.selected).toEqual([2]);
  });

  test("多选：点选项即勾选，再点取消", () => {
    const { flow } = makeFlow();
    flow.handleKey(key("right")); // 第 2 题（多选）

    const rowB = rowOf(flow, "B");
    expect(flow.clickLine(rowB)).toBe(true);
    expect(flow.answers[1]?.selected).toEqual([1]);

    expect(flow.clickLine(rowB)).toBe(true);
    expect(flow.answers[1]?.selected).toEqual([]);
  });

  test("点非选项行返回 false（让调用方继续处理，比如滚动）", () => {
    const { flow } = makeFlow();
    expect(flow.clickLine(0)).toBe(false); // 标题行
    expect(flow.clickLine(999)).toBe(false);
  });

  test("行号映射每帧重建，翻页后不会错位", () => {
    const { flow } = makeFlow();

    // 第 1 题：点 B
    flow.clickLine(rowOf(flow, "B"));
    expect(flow.answers[0]?.selected).toEqual([1]);

    flow.handleKey(key("right")); // 到第 2 题
    // 第 2 题的行号映射必须已经刷新 —— 点它自己的 C
    flow.clickLine(rowOf(flow, "C"));
    expect(flow.answers[1]?.selected).toEqual([2]);
    expect(flow.answers[0]?.selected).toEqual([1]); // 第 1 题不受影响
  });

  test("汇总页：点某一题跳回那一题", () => {
    const { flow } = makeFlow();
    for (let i = 0; i < 10; i += 1) flow.handleKey(key("right"));
    expect(flow.isSummary).toBe(true);

    const row = flow.render(70).findIndex((line) => strip(line).includes("2."));
    expect(flow.clickLine(row)).toBe(true);
    expect(flow.isSummary).toBe(false);
    expect(flow.page).toBe(1);
  });

  test("汇总页点非问题行不跳转", () => {
    const { flow } = makeFlow();
    for (let i = 0; i < 10; i += 1) flow.handleKey(key("right"));
    expect(flow.clickLine(0)).toBe(false); // 标题行
  });

  test("输入态下不响应选项点击（避免误触）", () => {
    const { flow } = makeFlow();
    flow.handleKey(text("e"));
    expect(flow.isTyping).toBe(true);
    expect(flow.clickLine(3)).toBe(false);
  });
});

describe("formatAnswers", () => {
  test("渲染选择与补充", () => {
    const text = formatAnswers([
      { question: "风格？", selected: [1], custom: "尽量少用缩写" },
      { question: "内容？", selected: [0, 2] },
      { question: "名字？", selected: [] },
    ]);

    expect(text).toContain("1. 风格？");
    expect(text).toContain("选择：B");
    expect(text).toContain("补充：尽量少用缩写");
    expect(text).toContain("选择：A、C");
    expect(text).toContain("（用户未作答）");
  });
});
