import { describe, expect, test } from "bun:test";
import { Screen } from "../src/tui/screen.ts";
import { KeyDecoder } from "../src/tui/keys.ts";
import { truncateAnsi, visibleWidth } from "../src/tui/ansi.ts";
import { renderMarkdown, wrapToLines } from "../src/tui/markdown.ts";
import { copyNotice } from "../src/tui/message-actions.ts";

describe("P5 · 差分渲染器", () => {
  test("首帧全量重绘，第二帧无变化则不输出", () => {
    const screen = new Screen(10, 3);
    const first = screen.draw(["aaa", "bbb", "ccc"]);
    expect(first).toContain("\x1b[1;1H");
    expect(first).toContain("\x1b[3;1H");

    expect(screen.draw(["aaa", "bbb", "ccc"])).toBe("");
    expect(screen.countChanged(["aaa", "bbb", "ccc"])).toBe(0);
  });

  test("只有变化的行会被重写（O(变化行数)）", () => {
    const screen = new Screen(10, 3);
    screen.draw(["aaa", "bbb", "ccc"]);

    expect(screen.countChanged(["aaa", "XXX", "ccc"])).toBe(1);
    expect(screen.draw(["aaa", "XXX", "ccc"])).toBe("\x1b[2;1H\x1b[2KXXX");
  });

  test("清行转义保证了旧内容不会残留", () => {
    const screen = new Screen(10, 2);
    screen.draw(["很长的一行内容", ""]);
    const out = screen.draw(["短", ""]);
    expect(out).toContain("\x1b[2K");
  });

  test("超宽内容被截断到屏幕宽度内", () => {
    const screen = new Screen(5, 1);
    const out = screen.draw(["这是一段很长的中文内容"]);
    const written = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    expect(visibleWidth(written)).toBeLessThanOrEqual(5);
  });

  test("resize 会强制全量重绘", () => {
    const screen = new Screen(10, 2);
    screen.draw(["a", "b"]);
    expect(screen.resize(20, 2)).toBe(true);
    expect(screen.draw(["a", "b"])).not.toBe("");
    expect(screen.resize(20, 2)).toBe(false);
  });
});

describe("P5 · 按键解析", () => {
  test("普通字符聚成一个 text key", () => {
    expect(new KeyDecoder().push("hello")).toEqual([{ type: "text", value: "hello" }]);
  });

  test("回车 / 退格 / Tab", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\r")).toEqual([{ type: "enter" }]);
    expect(decoder.push("\x7f")).toEqual([{ type: "backspace" }]);
    expect(decoder.push("\t")).toEqual([{ type: "tab" }]);
  });

  test("Ctrl+J / Alt+Enter / 增强键盘协议产生换行而非提交", () => {
    expect(new KeyDecoder().push("\n")).toEqual([{ type: "newline" }]);
    expect(new KeyDecoder().push("\x1b\r")).toEqual([{ type: "newline" }]);
    expect(new KeyDecoder().push("\x1b[13;2u")).toEqual([{ type: "newline" }]);
    expect(new KeyDecoder().push("\x1b[27;2;13~")).toEqual([{ type: "newline" }]);
  });

  test("bracketed paste 整体成为一个 paste 事件，内部换行不触发提交", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\x1b[200~hello\nworld\x1b[201~")).toEqual([
      { type: "paste", value: "hello\nworld" },
    ]);
  });

  test("bracketed paste 跨 chunk 也能拼回", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\x1b[200~hello")).toEqual([]);
    expect(decoder.push("\nworld\x1b[201~")).toEqual([
      { type: "paste", value: "hello\nworld" },
    ]);
  });

  test("复制反馈按字符数显示，不被换行拆成多条消息", () => {
    expect(copyNotice("你好\nworld")).toBe("[已复制 8 字符]");
  });

  test("方向键与 Home/End", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\x1b[A")).toEqual([{ type: "up" }]);
    expect(decoder.push("\x1b[B")).toEqual([{ type: "down" }]);
    expect(decoder.push("\x1b[C")).toEqual([{ type: "right" }]);
    expect(decoder.push("\x1b[D")).toEqual([{ type: "left" }]);
    expect(decoder.push("\x1b[H")).toEqual([{ type: "home" }]);
    expect(decoder.push("\x1b[F")).toEqual([{ type: "end" }]);
  });

  test("Delete / PageUp / PageDown", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\x1b[3~")).toEqual([{ type: "delete" }]);
    expect(decoder.push("\x1b[5~")).toEqual([{ type: "pageUp" }]);
    expect(decoder.push("\x1b[6~")).toEqual([{ type: "pageDown" }]);
  });

  test("控制键被识别为 ctrl", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\x03")).toEqual([{ type: "ctrl", key: "c" }]);
    expect(decoder.push("\x04")).toEqual([{ type: "ctrl", key: "d" }]);
  });

  test("鼠标移动事件带 motion 标记，且不会当成点击", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\x1b[<35;10;5M")).toEqual([
      { type: "mouse", button: "other", x: 10, y: 5, pressed: false, motion: true },
    ]);
  });

  test("被拆包的转义序列能正确拼接", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\x1b")).toEqual([]);
    expect(decoder.pendingLength).toBe(1);
    expect(decoder.push("[")).toEqual([]);
    expect(decoder.push("A")).toEqual([{ type: "up" }]);
    expect(decoder.pendingLength).toBe(0);
  });

  test("裸 ESC 由 flush 兑现", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\x1b")).toEqual([]);
    expect(decoder.flush()).toEqual([{ type: "escape" }]);
    expect(decoder.flush()).toEqual([]);
  });

  test("ESC 后面跟普通字符时立即产出 escape + text", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\x1bq")).toEqual([{ type: "escape" }, { type: "text", value: "q" }]);
  });
});

describe("P8 · markdown 渲染（Bun 原生）", () => {
  test("Bun.markdown.ansi 存在且产出 ANSI", () => {
    const lines = renderMarkdown("# 标题\n\n**粗体**", 40);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).toContain("\x1b[");
  });

  test("代码块被 Bun 原生高亮（ts/js）", () => {
    const lines = renderMarkdown("```ts\nconst x: number = 1;\n```", 60);
    expect(lines.join("\n")).toContain("\x1b[");
  });

  test("折行后每行都不超过给定宽度", () => {
    const text = "这是一段很长的中文文本，用来验证按可见宽度折行是否生效，包括 CJK 宽字符。";
    const lines = wrapToLines(text, 20);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  });

  test("折行不会切断 ANSI 转义序列", () => {
    const colored = "\x1b[31m这是一段红色的很长的中文文本需要折行\x1b[0m";
    const lines = wrapToLines(colored, 10);
    for (const line of lines) {
      // 每个 \x1b 后面都必须紧跟完整的 CSI（以字母结尾）
      const stripped = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      expect(stripped).not.toContain("\x1b");
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    }
  });
});

describe("P8 · ANSI 宽度工具", () => {
  test("stringWidth 忽略 ANSI 且正确处理 CJK", () => {
    expect(visibleWidth("中文")).toBe(4);
    expect(visibleWidth("\x1b[31mred\x1b[0m")).toBe(3);
  });

  test("截断保留 ANSI 完整性并加省略号", () => {
    const result = truncateAnsi("\x1b[31mabcdefghij\x1b[0m", 6);
    expect(visibleWidth(result)).toBeLessThanOrEqual(6);
    expect(result).toContain("…");
    expect(result.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")).not.toContain("\x1b");
  });

  test("截断 OSC 8 超链接不会切断控制序列", () => {
    const link = "\x1b]8;;https://example.com\x07click me\x1b]8;;\x07";
    const result = truncateAnsi(link, 5);

    expect(visibleWidth(result)).toBe(5);
    expect(result).toContain("\x1b]8;;https://example.com\x07");
    expect(result).toContain("\x1b]8;;\x07");
    expect(Bun.stripANSI(result)).toBe("clic…");
  });

  test("emoji ZWJ 按一个字素截断", () => {
    const result = truncateAnsi("👩‍👩‍👧‍👦abc", 3);

    expect(visibleWidth(result)).toBe(3);
    expect(Bun.stripANSI(result)).toBe("👩‍👩‍👧‍👦…");
  });

  test("ambiguous-width 与 stringWidth 使用同一规则", () => {
    const result = truncateAnsi("ααα", 2);

    expect(visibleWidth(result)).toBe(2);
    expect(Bun.stripANSI(result)).toBe("α…");
  });

  test("不需要截断时原样返回", () => {
    expect(truncateAnsi("abc", 10)).toBe("abc");
    expect(truncateAnsi("abc", 0)).toBe("");
  });
});
