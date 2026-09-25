import { describe, expect, test } from "bun:test";
import { makeMessage, textPart } from "../src/core/message.ts";
import { Transcript, displayActionMsgId, displayMsgId, type DisplayItem } from "../src/tui/transcript.ts";

type AssistantItem = Extract<DisplayItem, { kind: "assistant" }>;
type ToolItem = Extract<DisplayItem, { kind: "tool" }>;

const assistantsOf = (t: Transcript): AssistantItem[] =>
  t.items.filter((i): i is AssistantItem => i.kind === "assistant");
const toolsOf = (t: Transcript): ToolItem[] =>
  t.items.filter((i): i is ToolItem => i.kind === "tool");

describe("P5 · Transcript 显示块归并", () => {
  test("同一段回复的流式增量合并成一个块", () => {
    const t = new Transcript();
    t.appendAssistantText("你");
    t.appendAssistantText("好");
    expect(assistantsOf(t)).toEqual([{ kind: "assistant", text: "你好" }]);
  });

  test("回归：工具调用前后的两段 assistant 文本必须分开成块", () => {
    const t = new Transcript();

    // 第一轮：说明文本 + 工具调用
    t.appendAssistantText("我来看看目录。");
    t.endAssistant(); // 对应 loop 的 onAssistant
    t.startTool({ id: "c1", name: "bash", args: { command: "ls" } });
    t.finishTool("c1", "a.txt", true);

    // 第二轮：收尾文本
    t.appendAssistantText("命令执行完毕。");
    t.endAssistant();

    const assistants = assistantsOf(t);
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.text).toBe("我来看看目录。");
    expect(assistants[1]?.text).toBe("命令执行完毕。");
  });

  test("条目顺序为 user -> assistant -> tool -> assistant", () => {
    const t = new Transcript();
    t.pushUser("跑一下");
    t.appendAssistantText("好的");
    t.endAssistant();
    t.startTool({ id: "c1", name: "bash", args: {} });
    t.finishTool("c1", "ok", true);
    t.appendAssistantText("完成");
    t.endAssistant();

    expect(t.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  test("纯工具调用（无文本）不会产生空的 assistant 块", () => {
    const t = new Transcript();
    t.endAssistant();
    t.startTool({ id: "c1", name: "bash", args: {} });
    expect(assistantsOf(t)).toHaveLength(0);
  });

  test("工具参数增量复用同一张 provisional 卡片", () => {
    const t = new Transcript();
    t.updateToolCallDelta({
      id: "c1",
      name: "apply_patch",
      argsDelta: '{"patch":"',
      rawArgs: '{"patch":"',
      args: { _raw: '{"patch":"', _parseError: true },
    });
    t.updateToolCallDelta({
      id: "c1",
      name: "apply_patch",
      argsDelta: "*** Begin Patch",
      rawArgs: '{"patch":"*** Begin Patch',
      args: { patch: "*** Begin Patch" },
    });

    expect(toolsOf(t)).toHaveLength(1);
    expect(toolsOf(t)[0]?.streaming).toBe(true);

    t.startTool({ id: "c1", name: "apply_patch", args: { patch: "*** Begin Patch\n*** End Patch" } });
    expect(toolsOf(t)).toHaveLength(1);
    expect(toolsOf(t)[0]?.streaming).toBe(false);

    t.finishTool("c1", "Success. Updated the following files:", true);
    expect(toolsOf(t)[0]?.done).toBe(true);
  });

  test("空增量被忽略", () => {
    const t = new Transcript();
    t.appendAssistantText("");
    expect(t.items).toHaveLength(0);
  });

  test("工具结果按 callId 精确匹配，不会串台", () => {
    const t = new Transcript();
    t.startTool({ id: "a", name: "bash", args: {} });
    t.startTool({ id: "b", name: "bash", args: {} });

    t.finishTool("b", "第二个的输出", true);

    const tools = toolsOf(t);
    expect(tools[0]?.done).toBe(false);
    expect(tools[1]?.done).toBe(true);
    expect(tools[1]?.output).toBe("第二个的输出");
  });

  test("工具失败会被标记 ok:false", () => {
    const t = new Transcript();
    t.startTool({ id: "c1", name: "bash", args: {} });
    t.finishTool("c1", "炸了", false);
    expect(toolsOf(t)[0]?.ok).toBe(false);
  });

  test("itemVersion 在流式文本、进度、展开和完成时递增", () => {
    const t = new Transcript();

    t.appendAssistantText("a");
    const assistantBefore = t.itemVersion(0);
    t.appendAssistantText("b");
    expect(t.itemVersion(0)).toBe(assistantBefore + 1);

    t.startTool({ id: "c1", name: "bash", args: {} });
    const toolIndex = t.items.length - 1;
    expect(t.itemVersion(toolIndex)).toBe(0);

    t.appendToolProgress("c1", "progress");
    expect(t.itemVersion(toolIndex)).toBe(1);

    t.toggleToolExpanded("c1");
    expect(t.itemVersion(toolIndex)).toBe(2);

    t.finishTool("c1", "done", true);
    expect(t.itemVersion(toolIndex)).toBe(3);
  });

  test("mergeUsage 累加 token，cached 只在有值时出现", () => {
    const a = Transcript.mergeUsage({ input: 10, output: 2 }, { input: 5, output: 1 });
    expect(a).toEqual({ input: 15, output: 3 });

    const b = Transcript.mergeUsage(a, { input: 3, output: 1, cached: 7 });
    expect(b).toEqual({ input: 18, output: 4, cached: 7 });
  });

  test("restore 从持久消息重建块，并把工具卡片指向结果 msgid", () => {
    const t = new Transcript();
    const messages = [
      makeMessage({
        msgid: 1,
        role: "user",
        origin: "user",
        parts: [textPart("看一下")],
        createdAt: 1,
      }),
      makeMessage({
        msgid: 2,
        parentMsgId: 1,
        role: "assistant",
        origin: "assistant",
        parts: [],
        createdAt: 2,
        toolCalls: [{ id: "c1", name: "bash", args: { command: "ls" } }],
      }),
      makeMessage({
        msgid: 3,
        parentMsgId: 2,
        role: "tool",
        origin: "tool",
        parts: [textPart("a.txt")],
        createdAt: 3,
        toolCallId: "c1",
      }),
      makeMessage({
        msgid: 4,
        parentMsgId: 3,
        role: "assistant",
        origin: "assistant",
        parts: [textPart("完成")],
        createdAt: 4,
      }),
    ];

    t.restore(messages);

    expect(t.items.map((item) => item.kind)).toEqual(["user", "tool", "assistant"]);
    expect(displayMsgId(t.items[0]!)).toBe(1);
    expect(displayMsgId(t.items[1]!)).toBe(3);
    expect(displayMsgId(t.items[2]!)).toBe(4);
    expect(displayActionMsgId(t.items[1]!)).toBe(2);
    expect(t.items[1]?.kind === "tool" && t.items[1].output).toBe("a.txt");
  });
});

/**
 * 变更通知 —— 回归防线。
 *
 * 流式文本曾经因为"改完内容没人请求重绘"而每 80ms 才吐一批。修法是把触发点
 * 从各个回调挪进 Transcript 自身：只要内容真的变了，就一定通知。这里逐个
 * 钉住每条会改内容的路径，将来新加的变更方法漏了 `#touch()` 会直接红。
 */
describe("Transcript 变更通知", () => {
  /** 返回 transcript 与一个累加的通知计数。 */
  function tracked() {
    const t = new Transcript();
    const counter = { n: 0 };
    t.onChange = () => {
      counter.n += 1;
    };
    return { t, counter };
  }

  test("流式文本增量每次都通知", () => {
    const { t, counter } = tracked();
    t.appendAssistantText("你");
    const first = counter.n;
    expect(first).toBeGreaterThan(0);
    t.appendAssistantText("好");
    expect(counter.n).toBeGreaterThan(first);
  });

  test("空增量不算变更", () => {
    const { t, counter } = tracked();
    t.appendAssistantText("");
    expect(counter.n).toBe(0);
  });

  test("用户消息、通知与错误都通知", () => {
    const { t, counter } = tracked();
    t.pushUser("hi");
    t.pushNotice("notice");
    t.pushError("boom");
    expect(counter.n).toBe(3);
  });

  test("工具卡片的开始、参数增量、进度、展开与完成都通知", () => {
    const { t, counter } = tracked();

    t.startTool({ id: "c1", name: "bash", args: {} });
    const afterStart = counter.n;
    expect(afterStart).toBeGreaterThan(0);

    t.updateToolCallDelta({
      id: "c1",
      name: "bash",
      argsDelta: '{"a":',
      rawArgs: '{"a":',
      args: { _raw: '{"a":', _parseError: true },
    });
    expect(counter.n).toBeGreaterThan(afterStart);

    const afterDelta = counter.n;
    t.appendToolProgress("c1", "out");
    expect(counter.n).toBeGreaterThan(afterDelta);

    const afterProgress = counter.n;
    t.toggleToolExpanded("c1");
    expect(counter.n).toBeGreaterThan(afterProgress);

    const afterToggle = counter.n;
    t.finishTool("c1", "done", true);
    expect(counter.n).toBeGreaterThan(afterToggle);
  });

  test("assistant 消息收尾（endAssistant）通知", () => {
    const { t, counter } = tracked();
    t.appendAssistantText("hi");
    const before = counter.n;
    t.endAssistant(1);
    expect(counter.n).toBeGreaterThan(before);
  });

  test("clearStreamingTools 通知", () => {
    const { t, counter } = tracked();
    t.updateToolCallDelta({
      id: "c1",
      name: "bash",
      argsDelta: "{}",
      rawArgs: "{}",
      args: {},
    });
    const before = counter.n;
    t.clearStreamingTools();
    expect(counter.n).toBeGreaterThan(before);
  });

  test("删除前面的 provisional 工具卡后，流式 assistant 索引不会错位", () => {
    const t = new Transcript();
    t.updateToolCallDelta({
      id: "c1",
      name: "bash",
      argsDelta: "{}",
      rawArgs: "{}",
      args: {},
    });
    t.appendAssistantText("a");
    t.clearStreamingTools();
    t.appendAssistantText("b");

    expect(t.items).toHaveLength(1);
    expect(t.items[0]?.kind).toBe("assistant");
    expect(t.items[0]?.kind === "assistant" ? t.items[0].text : "").toBe("ab");
  });

  test("restore 重建时通知", () => {
    const { t, counter } = tracked();
    t.restore([
      makeMessage({ msgid: 1, role: "user", origin: "user", parts: [textPart("hi")], createdAt: 1 }),
    ]);
    expect(counter.n).toBeGreaterThan(0);
  });

  test("通知到达时 revision 已经更新，且严格递增", () => {
    const t = new Transcript();
    const seen: number[] = [];
    t.onChange = () => {
      seen.push(t.revision);
    };

    t.appendAssistantText("a");
    t.appendAssistantText("b");

    // 一次 appendAssistantText 可能触发多于一次通知（建块 + 更新块），
    // 但每次通知到达时 revision 都必须**已经**变了 —— 否则布局层会复用旧行。
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const value of seen) expect(value).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    }
    expect(seen.at(-1)).toBe(t.revision);
  });

  test("没有订阅者时变更不报错", () => {
    const t = new Transcript();
    expect(() => {
      t.pushUser("hi");
      t.appendAssistantText("x");
    }).not.toThrow();
  });

  test("可以解除订阅", () => {
    const { t, counter } = tracked();
    t.onChange = undefined;
    t.pushUser("hi");
    expect(counter.n).toBe(0);
  });
});

describe("Transcript layout changes", () => {
  test("追加和内容更新分别报告 appendedFrom / dirty", () => {
    const t = new Transcript();
    t.pushUser("u");
    t.appendAssistantText("a");

    const first = t.consumeLayoutChanges();
    expect(first.rebuild).toBe(false);
    expect(first.appendedFrom).toBe(0);
    expect(first.dirty).toEqual([0, 1]);

    const second = t.consumeLayoutChanges();
    expect(second).toEqual({ rebuild: false, dirty: [] });

    t.appendAssistantText("b");
    const third = t.consumeLayoutChanges();
    expect(third.appendedFrom).toBeUndefined();
    expect(third.dirty).toEqual([1]);
  });

  test("结构性删除和 restore 会要求 rebuild", () => {
    const t = new Transcript();
    t.updateToolCallDelta({
      id: "c1",
      name: "bash",
      argsDelta: "{}",
      rawArgs: "{}",
      args: {},
    });
    t.consumeLayoutChanges();
    t.clearStreamingTools();
    expect(t.consumeLayoutChanges().rebuild).toBe(true);

    t.restore([
      makeMessage({ msgid: 1, role: "user", origin: "user", parts: [textPart("hi")], createdAt: 1 }),
    ]);
    expect(t.consumeLayoutChanges().rebuild).toBe(true);
  });
});
