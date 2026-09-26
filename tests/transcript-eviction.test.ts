/**
 * Transcript 保留窗口与点击回放（PERF-002）。
 *
 * 会话正文（session.messages）是 provider 上下文的来源，必须常驻；
 * 这里验证的是 transcript 这份渲染拷贝的瘦身与恢复：
 *   - 超出保留窗口的已完成条目正文移出内存，替换为"已释放"占位；
 *   - 运行中 / 窗口内的条目不受影响；
 *   - rebuildFrom() 从会话消息整体回放，占位恢复为完整内容；
 *   - 渲染层对已释放卡片输出引导文案，且不再走自定义渲染器。
 */

import { describe, expect, test } from "bun:test";
import { Transcript } from "../src/tui/transcript.ts";
import { renderToolItem } from "../src/tui/renderers.ts";
import { registerBuiltinToolRenderers } from "../src/tui/renderers-builtin.ts";
import type { StoredMessage } from "../src/core/message.ts";
import { makeMessage, SYSTEM_MSGID, textPart } from "../src/core/message.ts";

registerBuiltinToolRenderers();

function msg(msgid: number, role: StoredMessage["role"], text: string): StoredMessage {
  return makeMessage({
    msgid,
    parentMsgId: msgid - 1,
    role,
    origin: role === "system" ? "system" : role === "tool" ? "tool" : "user",
    parts: [textPart(text)],
    createdAt: 0,
  });
}

function makeTranscript(): Transcript {
  return new Transcript({ retentionItems: 6 });
}

describe("Transcript 保留窗口（PERF-002）", () => {
  test("窗口外的已完成工具卡片正文被移出内存并标记 evicted", () => {
    const transcript = makeTranscript();
    for (let index = 0; index < 10; index += 1) {
      transcript.startTool({ id: `call_${index}`, name: "bash", args: { command: "x" } });
      transcript.finishTool(`call_${index}`, `output-${index}`.repeat(50), true, 100 + index);
    }

    const items = transcript.items.filter((item) => item.kind === "tool");
    const old = items[0]!;
    const recent = items[items.length - 1]!;
    if (old.kind !== "tool" || recent.kind !== "tool") throw new Error("unreachable");

    expect(old.evicted).toBe(true);
    expect(old.output).toBe("");
    expect(recent.evicted).toBeUndefined();
    expect(recent.output).toContain("output-9");
    expect(transcript.evictedCount).toBeGreaterThan(0);
  });

  test("运行中的工具不会被释放", () => {
    const transcript = makeTranscript();
    transcript.startTool({ id: "running", name: "bash", args: {} });
    for (let index = 0; index < 20; index += 1) {
      transcript.pushUser(`msg-${index}`);
      transcript.startTool({ id: `c_${index}`, name: "bash", args: {} });
      transcript.finishTool(`c_${index}`, "out", true, 100 + index);
    }
    const running = transcript.items.find(
      (item) => item.kind === "tool" && item.callId === "running",
    );
    if (running?.kind !== "tool") throw new Error("unreachable");
    expect(running.done).toBe(false);
    expect(running.evicted).toBeUndefined();
  });

  test("rebuildFrom 从会话消息整体回放，占位恢复为完整内容", () => {
    const transcript = makeTranscript();
    const outputs: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      transcript.startTool({ id: `call_${index}`, name: "bash", args: { command: "x" } });
      const output = `out-${index}`;
      transcript.finishTool(`call_${index}`, output, true, 100 + index);
      outputs.push(output);
    }
    expect(transcript.evictedCount).toBeGreaterThan(0);

    // 会话消息侧的真相：assistant(toolCalls) + tool(result) 成对出现
    const messages: StoredMessage[] = [msg(SYSTEM_MSGID, "system", "SYS")];
    for (const [index, output] of outputs.entries()) {
      messages.push(
        makeMessage({
          msgid: 10 + index,
          parentMsgId: 10 + index - 1,
          role: "assistant",
          origin: "assistant",
          parts: [textPart("")],
          createdAt: 0,
          toolCalls: [{ id: `call_${index}`, name: "bash", args: {} }],
        }),
      );
      messages.push(
        makeMessage({
          msgid: 100 + index,
          parentMsgId: 10 + index,
          role: "tool",
          origin: "tool",
          toolCallId: `call_${index}`,
          parts: [textPart(output)],
          createdAt: 0,
        }),
      );
    }

    transcript.rebuildFrom(messages);

    const items = transcript.items.filter((item) => item.kind === "tool");
    expect(transcript.evictedCount).toBe(0);
    const first = items[0]!;
    if (first.kind !== "tool") throw new Error("unreachable");
    expect(first.evicted).toBeUndefined();
    expect(first.output).toBe("out-0");
  });

  test("已释放卡片渲染引导文案，且不走自定义渲染器", () => {
    const transcript = makeTranscript();
    transcript.startTool({ id: "call_0", name: "bash", args: { command: "ls" } });
    transcript.finishTool("call_0", "done", true, 100);
    for (let index = 0; index < 20; index += 1) transcript.pushUser(`m-${index}`);

    const evicted = transcript.items.find(
      (item) => item.kind === "tool" && item.callId === "call_0",
    );
    if (evicted?.kind !== "tool") throw new Error("unreachable");
    expect(evicted.evicted).toBe(true);

    const lines = renderToolItem(evicted, 80).join("\n");
    expect(lines).toContain("已从内存释放");
    expect(lines).not.toContain("done");
  });
});
