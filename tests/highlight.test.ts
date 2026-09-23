import { afterAll, describe, expect, test } from "bun:test";
import { renderMarkdown, renderPlain, splitMarkdown, wrapToLines } from "../src/tui/markdown.ts";
import {
  clearHighlightCache,
  highlightCode,
  isLanguageReady,
  isNativeLanguage,
  normalizeLanguage,
  setHighlightReadyHandler,
} from "../src/tui/highlight.ts";

afterAll(() => {
  setHighlightReadyHandler(undefined);
  clearHighlightCache();
});

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const colorCount = (text: string): number => (text.match(/\x1b\[[0-9;]+m/g) ?? []).length;

describe("折行：缩进必须保留", () => {
  test("回归：wrapAnsi 默认 trim:true 会把 Python 缩进削掉", () => {
    const lines = wrapToLines("def f(x):\n    if x:\n        return 1", 60);
    expect(lines).toEqual(["def f(x):", "    if x:", "        return 1"]);
  });

  test("超长缩进行的续行从 0 列开始，且不超宽", () => {
    const long = "        " + "word ".repeat(20).trim();
    const lines = wrapToLines(long, 30);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toStartWith("        "); // 首行保留缩进
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(30);
  });

  test("renderPlain 也保留缩进（bash / read_file 走这条）", () => {
    expect(renderPlain("a\n    b\n        c", 40)).toEqual(["a", "    b", "        c"]);
  });
});

describe("markdown 切分", () => {
  test("散文与代码块被正确切开", () => {
    const segments = splitMarkdown("前文\n\n```python\ncode\n```\n\n后文");
    expect(segments).toEqual([
      { kind: "prose", text: "前文\n" },
      { kind: "code", language: "python", code: "code" },
      { kind: "prose", text: "\n后文" },
    ]);
  });

  test("没有语言标注也能切", () => {
    const segments = splitMarkdown("```\nplain\n```");
    expect(segments).toEqual([{ kind: "code", language: "", code: "plain" }]);
  });

  test("~~~ 围栏同样识别", () => {
    const segments = splitMarkdown("~~~rust\nfn main() {}\n~~~");
    expect(segments[0]).toMatchObject({ kind: "code", language: "rust" });
  });

  test("未闭合的围栏按普通文本处理（流式输出中途）", () => {
    const segments = splitMarkdown("前文\n```python\n还在写");
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe("prose");
  });

  test("多个代码块", () => {
    const segments = splitMarkdown("```a\n1\n```\n\n```b\n2\n```");
    expect(segments.filter((s) => s.kind === "code")).toHaveLength(2);
  });
});

describe("语言归一化", () => {
  test("别名映射到规范名", () => {
    expect(normalizeLanguage("py")).toBe("python");
    expect(normalizeLanguage("PY")).toBe("python");
    expect(normalizeLanguage("rs")).toBe("rust");
    expect(normalizeLanguage("sh")).toBe("bash");
    expect(normalizeLanguage("yml")).toBe("yaml");
    expect(normalizeLanguage("c++")).toBe("cpp");
    expect(normalizeLanguage("ts")).toBe("ts");
  });

  test("未知语言原样返回，不会崩", () => {
    expect(normalizeLanguage("brainfuck")).toBe("brainfuck");
    expect(normalizeLanguage(undefined)).toBe("");
  });

  test("ts/js 系列走 Bun 原生", () => {
    for (const lang of ["ts", "typescript", "js", "javascript", "jsx", "tsx"]) {
      expect(isNativeLanguage(lang)).toBe(true);
    }
    expect(isNativeLanguage("python")).toBe(false);
  });

  test("未知语言不触发加载，直接当纯文本", () => {
    expect(isLanguageReady("brainfuck")).toBe(true);
    expect(highlightCode("code", "brainfuck")).toBe("code");
  });
});

describe("高亮：懒加载与缓存", () => {
  test("模块未加载时先返回纯文本，并触发加载", () => {
    clearHighlightCache();
    const first = highlightCode("def f():\n    pass", "python");
    // 首次是纯文本（模块还在加载）
    expect(first).not.toContain("\x1b[");
    expect(isLanguageReady("python")).toBe(false);
  });

  test("加载完成后返回带 ANSI 的高亮，且不残留 HTML 标签", async () => {
    let ready = false;
    setHighlightReadyHandler(() => {
      ready = true;
    });

    highlightCode("def f(x):\n    return x", "python");
    await Bun.sleep(400);

    const highlighted = highlightCode("def f(x):\n    return x", "python");
    expect(highlighted).toContain("\x1b[");
    expect(strip(highlighted)).not.toContain("<span");
    expect(ready).toBe(true);
  });

  test("缓存命中后内容一致", async () => {
    const code = "const x = 1";
    const a = highlightCode(code, "rust");
    await Bun.sleep(400);
    const b = highlightCode(code, "rust");
    const c = highlightCode(code, "rust");
    expect(c).toBe(b);
    void a;
  });
});

describe("markdown 折行宽度", () => {
  test("回归：Bun.markdown.ansi 默认按 80 列折行，必须显式传 columns", () => {
    const long = "这是一段很长的中文文本用来测试折行行为到底受什么控制".repeat(3);

    const narrow = renderMarkdown(long, 80);
    const wide = renderMarkdown(long, 200);

    // 宽终端下应该更少行 —— 如果 columns 没生效，两者行数会一样
    expect(wide.length).toBeLessThan(narrow.length);

    for (const line of wide) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(200);
  });

  test("超宽终端的段落不会被硬编码在 80 列", () => {
    const text = "中文".repeat(100); // 400 列
    const lines = renderMarkdown(text, 300);
    expect(lines[0]!.length).toBeGreaterThan(80);
  });

  test("窄终端仍然正确折行", () => {
    const lines = renderMarkdown("这是一段需要在窄终端里折行的文本".repeat(3), 40);
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
  });
});

describe("renderMarkdown：代码块渲染", () => {
  test("代码块带边框与语言标签", async () => {
    renderMarkdown("```python\nx = 1\n```", 60);
    await Bun.sleep(400);

    const lines = renderMarkdown("```python\nx = 1\n```", 60).map(strip);
    expect(lines[0]).toContain("python");
    expect(lines.some((l) => l.includes("│ x = 1"))).toBe(true);
    expect(lines.at(-1)).toContain("└");
  });

  test("ts 代码块走 Bun 原生（不需要加载 highlight.js）", () => {
    const raw = renderMarkdown("```ts\nconst x: number = 1;\n```", 60).join("\n");
    expect(colorCount(raw)).toBeGreaterThan(0);
  });

  test("散文部分保留 Bun 原生排版", () => {
    const lines = renderMarkdown("# 标题\n\n- 项目", 60).map(strip);
    expect(lines.join("\n")).toContain("标题");
    expect(lines.join("\n")).toContain("项目");
  });

  test("长代码行折行后仍带边框，且不超宽", async () => {
    renderMarkdown("```python\nx = 1\n```", 40);
    await Bun.sleep(400);

    const raw = renderMarkdown("```python\n" + "x".repeat(200) + "\n```", 40);
    for (const line of raw) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
  });
});
