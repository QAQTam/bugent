import { describe, expect, test } from "bun:test";
import {
  countTodos,
  createTodoWriteTool,
  currentTodos,
  parseTodos,
  TODO_TOOL_NAME,
  tryParseTodos,
  type Todo,
} from "../src/tools/todo.ts";
import { ToolRegistry } from "../src/tools/types.ts";
import { PermissionGate } from "../src/permission/gate.ts";
import { composePolicy, PermissionPolicy } from "../src/permission/policy.ts";
import { ScriptedPrompter } from "../src/permission/prompt.ts";
import { makeMessage, textPart, type StoredMessage } from "../src/core/message.ts";
import { composeTodoPanel, renderTodoLine, renderTodoTool, TODO_MARKERS } from "../src/tui/render-todo.ts";
import {
  registerToolRenderer,
  registeredToolRenderers,
  renderToolItem,
  type ToolItem,
} from "../src/tui/renderers.ts";
import { TuiApp } from "../src/tui/app.ts";
import { AgentSession } from "../src/core/session.ts";
import { createMockClient } from "../src/provider/adapters/mock.ts";

/* --------------------------- 构造测试数据 --------------------------- */

function assistantWithTodo(callId: string, todos: unknown, msgid: number): StoredMessage {
  return makeMessage({
    msgid,
    role: "assistant",
    origin: "assistant",
    parts: [],
    toolCalls: [{ id: callId, name: TODO_TOOL_NAME, args: { todos } }],
    createdAt: 0,
  });
}

function toolResult(callId: string, text: string, msgid: number): StoredMessage {
  return makeMessage({
    msgid,
    role: "tool",
    origin: "tool",
    parts: [textPart(text)],
    toolCallId: callId,
    createdAt: 0,
  });
}

const sample: Todo[] = [
  { content: "读 src/core/loop.ts", status: "completed" },
  { content: "重构 Transcript", activeForm: "正在重构 Transcript", status: "in_progress" },
  { content: "补单测", status: "pending" },
];

/* ------------------------------ 校验 ------------------------------ */

describe("todo_write · 参数校验", () => {
  test("接受合法清单", () => {
    expect(parseTodos(sample)).toEqual(sample);
  });

  test("拒绝非数组", () => {
    expect(() => parseTodos("nope")).toThrow(/必须是数组/);
    expect(() => parseTodos(undefined)).toThrow(/必须是数组/);
  });

  test("拒绝空数组（要求保留已完成项而不是清空）", () => {
    expect(() => parseTodos([])).toThrow(/不能为空/);
  });

  test("拒绝空 content", () => {
    expect(() => parseTodos([{ content: "   ", status: "pending" }])).toThrow(/content 必须是非空字符串/);
    expect(() => parseTodos([{ status: "pending" }])).toThrow(/content 必须是非空字符串/);
  });

  test("拒绝非法 status，并在报错里给出收到的值", () => {
    expect(() => parseTodos([{ content: "x", status: "doing" }])).toThrow(/doing/);
  });

  test("同一时刻最多一项 in_progress —— 这是 todo 工具的核心纪律", () => {
    expect(() =>
      parseTodos([
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ]),
    ).toThrow(/最多只能有一项 in_progress/);
  });

  test("content 被 trim，空 activeForm 被丢弃", () => {
    const [todo] = parseTodos([{ content: "  有空格  ", activeForm: "   ", status: "pending" }]);
    expect(todo).toEqual({ content: "有空格", status: "pending" });
    expect(todo?.activeForm).toBeUndefined();
  });

  test("tryParseTodos 对畸形输入返回 undefined 而不抛错", () => {
    expect(tryParseTodos("nope")).toBeUndefined();
    expect(tryParseTodos(sample)).toEqual(sample);
  });

  test("countTodos 统计三态", () => {
    expect(countTodos(sample)).toEqual({ pending: 1, in_progress: 1, completed: 1 });
  });
});

/* --------------------------- 历史派生 --------------------------- */

describe("todo_write · 从消息历史派生当前清单", () => {
  test("没有调用过时返回空数组", () => {
    expect(currentTodos([])).toEqual([]);
    expect(currentTodos([makeMessage({ msgid: 0, role: "system", origin: "system", parts: [textPart("SYS")], createdAt: 0 })])).toEqual([]);
  });

  test("从最后一次调用派生", () => {
    const messages = [
      assistantWithTodo("c1", [{ content: "旧计划", status: "pending" }], 1),
      toolResult("c1", "待办清单已更新", 2),
      assistantWithTodo("c2", sample, 3),
      toolResult("c2", "待办清单已更新", 4),
    ];
    expect(currentTodos(messages)).toEqual(sample);
  });

  test("被拒绝的调用不算数（否则会显示一份用户没批准的计划）", () => {
    const messages = [
      assistantWithTodo("c1", sample, 1),
      toolResult("c1", "待办清单已更新", 2),
      assistantWithTodo("c2", [{ content: "没被批准的", status: "pending" }], 3),
      toolResult("c2", "Error: 用户拒绝执行：更新待办清单（1 项）", 4),
    ];
    expect(currentTodos(messages)).toEqual(sample);
  });

  test("参数畸形的调用被跳过", () => {
    const messages = [
      assistantWithTodo("c1", sample, 1),
      toolResult("c1", "ok", 2),
      assistantWithTodo("c2", [{ content: "x", status: "非法" }], 3),
      toolResult("c2", "ok", 4),
    ];
    expect(currentTodos(messages)).toEqual(sample);
  });

  test("没有工具调用消息时不误判", () => {
    const messages = [makeMessage({ msgid: 1, role: "user", origin: "user", parts: [textPart("hi")], createdAt: 0 })];
    expect(currentTodos(messages)).toEqual([]);
  });
});

/* ------------------------------ 工具 ------------------------------ */

describe("todo_write · 工具行为", () => {
  const tool = createTodoWriteTool();

  test("name 与 describe 正确", () => {
    expect(tool.name).toBe(TODO_TOOL_NAME);
    expect(tool.describe({ todos: sample })).toEqual({
      resource: "3 项",
      summary: "更新待办清单（3 项）",
    });
  });

  test("run 返回各状态计数", async () => {
    const out = await tool.run({ todos: sample }, { cwd: "/tmp", signal: new AbortController().signal, callId: "c1", sessionId: "test-session" });
    expect(out).toContain("共 3 项");
    expect(out).toContain("1 已完成");
    expect(out).toContain("1 进行中");
    expect(out).toContain("1 待办");
  });

  test("非法参数通过 registry 执行时转成 ok:false", async () => {
    const registry = new ToolRegistry().register(tool);
    const result = await registry.execute(
      { id: "c1", name: TODO_TOOL_NAME, args: { todos: "nope" } },
      { cwd: "/tmp", signal: new AbortController().signal, callId: "c1", sessionId: "test-session" },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("必须是数组");
  });

  test("工具自报 defaultPermission，组装后自动放行不打扰用户", async () => {
    const prompter = new ScriptedPrompter([]);
    const tools = new ToolRegistry().register(createTodoWriteTool());
    const gate = new PermissionGate({
      policy: new PermissionPolicy(composePolicy(undefined, tools.defaultPermissionRules())),
      mode: "workspace-write",
      prompter,
    });

    const verdict = await gate.check({
      tool: TODO_TOOL_NAME,
      resource: "3 项",
      summary: "更新待办清单（3 项）",
    });

    expect(verdict.allowed).toBe(true);
    expect(prompter.seen).toHaveLength(0); // 关键：没弹窗
  });

  test("用户的显式规则优先于工具自报的默认权限", async () => {
    const tools = new ToolRegistry().register(createTodoWriteTool());
    const gate = new PermissionGate({
      policy: new PermissionPolicy(
        composePolicy({ rules: [{ tool: TODO_TOOL_NAME, decision: "deny" }] }, tools.defaultPermissionRules()),
      ),
      mode: "workspace-write",
    });

    const verdict = await gate.check({ tool: TODO_TOOL_NAME, resource: "3 项", summary: "更新待办清单" });

    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("策略禁止");
  });

  test("没有规则时放行交给档位判断（不再默认弹窗）", async () => {
    const gate = new PermissionGate({
      policy: new PermissionPolicy(composePolicy(undefined, [])),
      mode: "workspace-write",
    });
    const verdict = await gate.check({ tool: "bash", resource: "ls", summary: "执行命令：ls" });
    expect(verdict.allowed).toBe(true);
  });
});

/* ------------------------------ 渲染 ------------------------------ */

describe("todo_write · 渲染", () => {
  test("三个标记都是纯 ASCII 且等宽（保证内容左对齐）", () => {
    for (const marker of Object.values(TODO_MARKERS)) {
      expect(marker).toMatch(/^\[[ x>]\]$/);
      expect(Bun.stringWidth(marker)).toBe(3);
    }
  });

  test("进行中的项显示 activeForm 而不是 content", () => {
    const line = renderTodoLine(sample[1]!, 60);
    expect(line).toContain("正在重构 Transcript");
    expect(line).toContain("[>]");
  });

  test("没有 activeForm 时回退到 content", () => {
    const line = renderTodoLine({ content: "跑测试", status: "in_progress" }, 60);
    expect(line).toContain("跑测试");
  });

  test("sticky 面板：没有待办时返回空数组", () => {
    expect(composeTodoPanel([], 60)).toEqual([]);
  });

  test("sticky 面板：标题含完成进度，每项一行", () => {
    const lines = composeTodoPanel(sample, 60);
    expect(lines[0]).toContain("1/3");
    expect(lines).toHaveLength(4); // 标题 + 3 项
    expect(lines[1]).toContain("[x]");
    expect(lines[2]).toContain("[>]");
    expect(lines[3]).toContain("[ ]");
  });

  test("sticky 面板：超长时截断并给出溢出提示", () => {
    const many: Todo[] = Array.from({ length: 12 }, (_, i) => ({
      content: `任务 ${i + 1}`,
      status: "pending" as const,
    }));
    const lines = composeTodoPanel(many, 60, { maxLines: 5 });

    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.at(-1)).toContain("还有");
  });

  test("sticky 面板：截断时把进行中的项钉在最前面", () => {
    const many: Todo[] = Array.from({ length: 12 }, (_, i) => ({
      content: `任务 ${i + 1}`,
      status: "pending" as const,
    }));
    many[10] = { content: "关键任务", status: "in_progress" };

    const lines = composeTodoPanel(many, 60, { maxLines: 4 });
    expect(lines[1]).toContain("关键任务");
  });

  test("transcript 里只留一行摘要（列表交给 sticky 面板）", () => {
    const item: ToolItem = {
      kind: "tool",
      callId: "c1",
      name: TODO_TOOL_NAME,
      args: { todos: sample },
      output: "待办清单已更新",
      ok: true,
      done: true,
      progress: "",
      expanded: false,
    };
    const lines = renderTodoTool(item, 80);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("共 3 项");
    expect(lines[0]).toContain("1 进行中");
  });
});

/* --------------------------- 渲染扩展点 --------------------------- */

describe("渲染扩展点", () => {
  const baseItem: ToolItem = {
    kind: "tool",
    callId: "c1",
    name: "some_tool",
    args: { a: 1 },
    output: "out",
    ok: true,
    done: true,
    progress: "",
    expanded: false,
  };

  test("未注册的工具走通用外观", () => {
    const lines = renderToolItem(baseItem, 80);
    expect(lines[0]).toContain("some_tool");
    expect(lines[0]).toContain('{"a":1}');
  });

  test("注册后走自定义外观", () => {
    registerToolRenderer("some_tool", () => ["自定义外观"]);
    expect(renderToolItem(baseItem, 80)).toEqual(["自定义外观"]);
  });

  test("回归：构造 TuiApp 会自动注册内置渲染器，不依赖 CLI 入口", () => {
    // 曾经的 bug：注册写在 src/index.ts，导致任何绕过 CLI 的入口
    // （测试、冒烟脚本、将来的 WebUI）都拿不到自定义外观，todo 又变回 JSON。
    const session = new AgentSession({
      id: "renderer-regression",
      system: "SYS",
      client: createMockClient({ script: [] }),
      model: "test-model",
    });
    const tools = new ToolRegistry().register(createTodoWriteTool());

    new TuiApp({ session, tools, cwd: "/tmp" });

    expect(registeredToolRenderers()).toContain(TODO_TOOL_NAME);
  });
});
