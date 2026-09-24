import { describe, expect, test } from "bun:test";
import {
  composeThinkingBlock,
  isSpinningActivity,
  tailToWidth,
  ThinkingBuffer,
  THINKING_BLOCK_ROWS,
  THINKING_FRAMES,
  THINKING_LINE_INDEX,
  type AgentActivity,
} from "../src/tui/thinking.ts";
import { mapStreamEvent } from "../src/provider/adapters/openai-chat.ts";
import type { ChatChunk } from "../src/provider/types.ts";
import { BOLD, fg } from "../src/tui/markdown.ts";
import { COLOR } from "../src/tui/theme.ts";

describe("思考链路 · 缓冲", () => {
  test("累积增量", () => {
    const buffer = new ThinkingBuffer();
    buffer.push("我在");
    buffer.push("思考");
    expect(buffer.current).toBe("我在思考");
  });

  test("遇到 \\n 直接销毁上一行，从空开始", () => {
    const buffer = new ThinkingBuffer();
    buffer.push("第一行内容");
    buffer.push("\n");
    expect(buffer.current).toBe("");

    buffer.push("第二行");
    expect(buffer.current).toBe("第二行");
  });

  test("多行内容只保留最后一行 —— 内存 O(一行)", () => {
    const buffer = new ThinkingBuffer();
    buffer.push("第一行\n第二行\n第三行\n正在写的");
    expect(buffer.current).toBe("正在写的");
  });

  test("reset 清空缓冲", () => {
    const buffer = new ThinkingBuffer();
    buffer.push("思考中");
    buffer.reset();
    expect(buffer.current).toBe("");
  });

  test("空增量被忽略", () => {
    const buffer = new ThinkingBuffer();
    buffer.push("已有");
    buffer.push("");
    expect(buffer.current).toBe("已有");
  });
});

describe("思考链路 · 横向滚动", () => {
  test("短文本原样返回", () => {
    expect(tailToWidth("abc", 10)).toEqual({ text: "abc", truncated: false });
  });

  test("超长时从尾部截取，右侧是最新字符", () => {
    const { text, truncated } = tailToWidth("0123456789", 4);
    expect(text).toBe("6789");
    expect(truncated).toBe(true);
  });

  test("CJK 按显示宽度截取，不会切出半个字", () => {
    const { text } = tailToWidth("一二三四五六七八九十", 6);
    expect(Bun.stringWidth(text)).toBeLessThanOrEqual(6);
    expect(text).toBe("八九十");
  });

  test("宽度为 0 时返回空", () => {
    expect(tailToWidth("abc", 0)).toEqual({ text: "", truncated: true });
  });
});

describe("思考链路 · 区块渲染", () => {
  test("空闲且没有思考内容时，中间那行只剩一个灰色菊花", () => {
    const lines = composeThinkingBlock(new ThinkingBuffer(), 60, {
      activity: { state: "idle" },
    });
    expect(lines).toHaveLength(THINKING_BLOCK_ROWS);
    expect(Bun.stripANSI(lines[THINKING_LINE_INDEX]!)).toBe(THINKING_FRAMES[0]);

    // 其余行必须是空的（留白）
    lines.forEach((line, index) => {
      if (index !== THINKING_LINE_INDEX) expect(line).toBe("");
    });
  });

  test("思考内容渲染在中间那一行，且不带状态文字", () => {
    const buffer = new ThinkingBuffer();
    buffer.push("正在推理");

    const lines = composeThinkingBlock(buffer, 60, { activity: { state: "working" } });
    expect(lines).toHaveLength(THINKING_BLOCK_ROWS);
    expect(lines[THINKING_LINE_INDEX]).toContain("正在推理");
    expect(Bun.stripANSI(lines[THINKING_LINE_INDEX]!)).toBe(`${THINKING_FRAMES[0]} 正在推理`);

    // 其余行必须是空的
    lines.forEach((line, index) => {
      if (index !== THINKING_LINE_INDEX) expect(line).toBe("");
    });
  });

  test("菊花帧切换，spinner 为青色，正文为土金色", () => {
    const buffer = new ThinkingBuffer();
    buffer.push("正在推理");

    const first = composeThinkingBlock(buffer, 60, {
      activity: { state: "working" },
      frame: 0,
    })[THINKING_LINE_INDEX]!;
    const second = composeThinkingBlock(buffer, 60, {
      activity: { state: "working" },
      frame: 1,
    })[THINKING_LINE_INDEX]!;

    expect(first).toContain(THINKING_FRAMES[0]);
    expect(second).toContain(THINKING_FRAMES[1]);
    expect(first).not.toBe(second);
    expect(first).toContain("\x1b[");
    expect(first).not.toContain("\x1b[2m");
  });

  test("超宽时保留尾部并加省略号提示", () => {
    const buffer = new ThinkingBuffer();
    buffer.push("0123456789".repeat(20));

    const lines = composeThinkingBlock(buffer, 30, { activity: { state: "working" } });
    const line = lines[THINKING_LINE_INDEX]!;

    expect(line).toContain("…");
    expect(line).toContain("9"); // 最新字符在右侧
    // 可见宽度不能超过给定宽度
    expect(Bun.stringWidth(line)).toBeLessThanOrEqual(30);
  });

  test("可自定义行数与渲染位置", () => {
    const buffer = new ThinkingBuffer();
    buffer.push("x");
    const lines = composeThinkingBlock(buffer, 40, {
      activity: { state: "working" },
      rows: 3,
      lineIndex: 0,
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("x");
  });

  test("工作状态只闪菊花，不带任何状态文字", () => {
    const line = composeThinkingBlock(new ThinkingBuffer(), 80, {
      activity: { state: "working" },
      frame: 0,
    })[THINKING_LINE_INDEX]!;
    // 只剩菊花本身：去掉 ANSI 后就是那一个字符
    expect(Bun.stripANSI(line)).toBe(THINKING_FRAMES[0]);

    // 只有 working 会转；其余三个都是静态终态
    expect(isSpinningActivity({ state: "working" })).toBe(true);
    expect(isSpinningActivity({ state: "idle" })).toBe(false);
    expect(isSpinningActivity({ state: "disconnected", detail: "x" })).toBe(false);
    expect(isSpinningActivity({ state: "aborted" })).toBe(false);
  });

  test("空闲显示灰色静止菊花，和工作的青色区分开", () => {
    const idle = composeThinkingBlock(new ThinkingBuffer(), 80, {
      activity: { state: "idle" },
      frame: 0,
    })[THINKING_LINE_INDEX]!;
    const working = composeThinkingBlock(new ThinkingBuffer(), 80, {
      activity: { state: "working" },
      frame: 0,
    })[THINKING_LINE_INDEX]!;

    expect(Bun.stripANSI(idle)).toBe(THINKING_FRAMES[0]);
    expect(idle).toContain(fg(COLOR.spinnerIdle));
    expect(working).not.toContain(fg(COLOR.spinnerIdle));
    // 空闲不加粗，保持安静
    expect(idle).not.toContain(BOLD);
    expect(working).toContain(BOLD);
  });

  test("空闲时若有思考残留，仍然显示思考尾部", () => {
    const buffer = new ThinkingBuffer();
    buffer.push("上一轮的思考");
    const line = composeThinkingBlock(buffer, 80, {
      activity: { state: "idle" },
      frame: 0,
    })[THINKING_LINE_INDEX]!;

    expect(line).toContain("上一轮的思考");
    expect(line).toContain(fg(COLOR.spinnerIdle));
  });

  test("disconnect / abort 保留静态终态，不继续动画", () => {
    const disconnected = composeThinkingBlock(new ThinkingBuffer(), 80, {
      activity: { state: "disconnected", detail: "ECONNRESET" },
    })[THINKING_LINE_INDEX]!;
    const aborted = composeThinkingBlock(new ThinkingBuffer(), 80, {
      activity: { state: "aborted" },
    })[THINKING_LINE_INDEX]!;

    // 断线是唯一保留文字的状态：那是真实报错，不是状态描述
    expect(disconnected).toContain("ECONNRESET");
    expect(disconnected).toContain("✖");
    expect(disconnected).not.toContain(THINKING_FRAMES[0]);
    expect(Bun.stripANSI(aborted)).toBe("■");
  });
});

describe("思考链路 · provider 解析", () => {
  test("reasoning_content 被映射成 reasoning chunk", () => {
    const { chunks } = mapStreamEvent(
      { choices: [{ delta: { reasoning_content: "我在想" } }] },
      new Map(),
    );
    expect(chunks).toEqual<ChatChunk[]>([{ type: "reasoning", delta: "我在想" }]);
  });

  test("reasoning 命名（另一种网关风格）也被识别", () => {
    const { chunks } = mapStreamEvent({ choices: [{ delta: { reasoning: "thinking" } }] }, new Map());
    expect(chunks).toEqual<ChatChunk[]>([{ type: "reasoning", delta: "thinking" }]);
  });

  test("思考与正文同时到达时分别产出，顺序为 reasoning 在前", () => {
    const { chunks } = mapStreamEvent(
      { choices: [{ delta: { reasoning_content: "想", content: "答" } }] },
      new Map(),
    );
    expect(chunks).toEqual<ChatChunk[]>([
      { type: "reasoning", delta: "想" },
      { type: "text", delta: "答" },
    ]);
  });

  test("没有思考字段时不产出 reasoning chunk", () => {
    const { chunks } = mapStreamEvent({ choices: [{ delta: { content: "答" } }] }, new Map());
    expect(chunks.some((c) => c.type === "reasoning")).toBe(false);
  });
});
