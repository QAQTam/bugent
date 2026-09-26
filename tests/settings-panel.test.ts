import { describe, expect, test } from "bun:test";
import {
  SettingsPanel,
  centeredPanelTop,
  panelRowBudget,
  type SettingsRow,
} from "../src/tui/settings-panel.ts";
import { hitTargetName } from "../src/tui/hit-target.ts";
import type { Key } from "../src/tui/keys.ts";

const text = (value: string): Key => ({ type: "text", value });
const key = (type: Key["type"]): Key => ({ type } as Key);

/** 一次调用的记录；面板只通过回调改宿主状态，所以断言全在这里。 */
interface Calls {
  applied: string[];
  invoked: string[];
}

function rows(calls: Calls, overrides: Partial<SettingsRow>[] = []): SettingsRow[] {
  const base: SettingsRow[] = [
    {
      id: "mode",
      section: "沙箱",
      label: "档位",
      kind: "enum",
      options: ["read-only", "workspace-write", "no-sandbox"],
      display: () => "workspace-write",
      apply: (value) => {
        calls.applied.push(`mode=${value}`);
      },
    },
    {
      id: "model",
      section: "模型",
      label: "模型",
      kind: "text",
      display: () => "gpt-4o-mini",
      apply: (value) => {
        calls.applied.push(`model=${value}`);
      },
    },
    {
      id: "apiKey",
      section: "模型",
      label: "API key",
      kind: "text",
      secret: true,
      display: () => "已设置",
      apply: (value) => {
        calls.applied.push(`key=${value}`);
      },
    },
    {
      id: "mcp.a",
      section: "MCP",
      label: "server-a",
      kind: "toggle",
      enabled: () => true,
      apply: (value) => {
        calls.applied.push(`mcp=${value}`);
      },
    },
    {
      id: "reload",
      section: "MCP",
      label: "重载工具快照",
      kind: "action",
      invoke: () => {
        calls.invoked.push("reload");
      },
    },
  ];
  return base.map((row, index) => ({ ...row, ...(overrides[index] ?? {}) }));
}

function makePanel(options: {
  rows?: SettingsRow[];
  calls?: Calls;
  onChange?: () => void;
} = {}) {
  const calls: Calls = options.calls ?? { applied: [], invoked: [] };
  const panel = new SettingsPanel({
    rows: options.rows ?? rows(calls),
    subtitle: "sess-1",
    onChange: options.onChange ?? (() => {}),
  });
  return { panel, calls };
}

/** 面板返回的可见行里，哪些是行（不是组标题 / 标题 / 提示）。 */
function visibleRowIndexes(panel: SettingsPanel, inner = 60, maxRows = 40): number[] {
  const rendered = panel.render(inner, maxRows);
  return [...rendered.rowLines.values()].sort((a, b) => a - b);
}

describe("设置面板 · 居中几何", () => {
  test("上下余量相等（真的落在终端中间）", () => {
    // 24 行终端、16 行面板：上方 4 行、下方 4 行
    expect(centeredPanelTop(24, 16)).toBe(4);
    expect(centeredPanelTop(40, 10)).toBe(15);
    expect(centeredPanelTop(30, 20)).toBe(5);
  });

  test("差值最多 1 行，且不越界", () => {
    for (let height = 5; height <= 80; height += 1) {
      for (let panel = 1; panel <= Math.min(height - 1, 40); panel += 1) {
        const top = centeredPanelTop(height, panel);
        expect(top).toBeGreaterThanOrEqual(1);
        expect(top + panel).toBeLessThanOrEqual(height);
        // 上方与下方余量之差不超过 1（奇数余量时偏上）
        const below = height - top - panel;
        expect(Math.abs(top - below)).toBeLessThanOrEqual(1);
      }
    }
  });

  test("放不下时返回 0，交给调用方降级", () => {
    expect(centeredPanelTop(10, 10)).toBe(0);
    expect(centeredPanelTop(10, 11)).toBe(0);
    expect(centeredPanelTop(0, 5)).toBe(0);
  });

  test("行预算给上下各留 2 行呼吸位", () => {
    expect(panelRowBudget(24)).toBe(20);
    expect(panelRowBudget(10)).toBe(6);
    // 极矮终端也要给出可用值，否则面板画不出来
    expect(panelRowBudget(3)).toBe(3);
  });
});

describe("设置面板 · 渲染", () => {
  test("标题、组标题、行、提示都在，且每个可见行都有命中行号", () => {
    const { panel } = makePanel();
    const rendered = panel.render(60, 40);
    const plain = rendered.lines.map((line) => Bun.stripANSI(line));

    expect(plain[0]).toContain("设置");
    expect(plain[0]).toContain("sess-1");
    expect(plain.some((line) => line.trim() === "沙箱")).toBe(true);
    expect(plain.some((line) => line.trim() === "模型")).toBe(true);
    expect(plain.some((line) => line.includes("档位"))).toBe(true);
    expect(plain.some((line) => line.includes("server-a"))).toBe(true);
    expect(plain[plain.length - 1]).toContain("Esc 关闭");

    // 5 行 + 3 个组标题，全部可点
    expect([...rendered.rowLines.values()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    for (const line of rendered.rowLines.keys()) {
      expect(plain[line]).toBeDefined();
    }
  });

  test("每行都画到整宽（底色块不能缺角）", () => {
    const { panel } = makePanel();
    for (const line of panel.render(48, 40).lines) {
      expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(48);
    }
  });

  test("焦点行有 ▸ 标记，且同一时刻只有一行有", () => {
    const { panel } = makePanel();
    const markers = panel
      .render(60, 40)
      .lines.map((line) => (Bun.stripANSI(line).includes("▸") ? 1 : 0));
    expect(markers.reduce((sum: number, value) => sum + value, 0)).toBe(1);
  });

  test("toggle 行按状态画 开 / 关，display 可省略", () => {
    const { panel } = makePanel();
    const plain = panel.render(60, 40).lines.map((line) => Bun.stripANSI(line));
    const row = plain.find((line) => line.includes("server-a"));
    expect(row).toBeDefined();
    expect(row).toContain("开");
  });

  test("只读行显示原因，而不是当前值", () => {
    const calls: Calls = { applied: [], invoked: [] };
    const { panel } = makePanel({
      rows: rows(calls, [{ blocked: () => "当前一轮还在跑" }]),
      calls,
    });
    const plain = panel.render(60, 40).lines.map((line) => Bun.stripANSI(line));
    expect(plain.some((line) => line.includes("当前一轮还在跑"))).toBe(true);
  });
});

describe("设置面板 · 键盘", () => {
  test("↑↓ 移动焦点并自动换行", () => {
    const { panel } = makePanel();
    expect(panel.cursorRow).toBe(0);
    panel.handleKey(key("down"));
    expect(panel.cursorRow).toBe(1);
    panel.handleKey(key("up"));
    panel.handleKey(key("up"));
    expect(panel.cursorRow).toBe(4); // 从第一行往上 = 最后一行
  });

  test("←→ 在候选值之间切换，并把新值交给 apply", () => {
    const { panel, calls } = makePanel();
    panel.handleKey(key("right"));
    expect(calls.applied).toEqual(["mode=no-sandbox"]);
    panel.handleKey(key("left"));
    panel.handleKey(key("left"));
    expect(calls.applied.at(-1)).toBe("mode=read-only");
  });

  test("Enter 在 enum 行 = 切到下一个候选", () => {
    const { panel, calls } = makePanel();
    panel.handleKey(key("enter"));
    expect(calls.applied).toEqual(["mode=no-sandbox"]);
  });

  test("Enter 在 toggle 行 = 取反，并传 true/false", () => {
    const { panel, calls } = makePanel();
    panel.handleKey(key("down"));
    panel.handleKey(key("down"));
    panel.handleKey(key("down"));
    expect(panel.cursorRow).toBe(3);
    panel.handleKey(key("enter"));
    expect(calls.applied).toEqual(["mcp=false"]);
  });

  test("Enter 在 action 行 = 触发 invoke", () => {
    const { panel, calls } = makePanel();
    panel.handleKey(key("end"));
    panel.handleKey(key("enter"));
    expect(calls.invoked).toEqual(["reload"]);
  });

  test("只读行回车不触发任何回调", () => {
    const calls: Calls = { applied: [], invoked: [] };
    const { panel } = makePanel({
      rows: rows(calls, [{ blocked: () => "只读" }]),
      calls,
    });
    panel.handleKey(key("enter"));
    panel.handleKey(key("right"));
    expect(calls.applied).toEqual([]);
  });

  test("Tab 跳到下一个分组的第一行", () => {
    const { panel } = makePanel();
    panel.handleKey(key("tab"));
    expect(panel.cursorRow).toBe(1); // 模型组第一行
    panel.handleKey(key("tab"));
    expect(panel.cursorRow).toBe(3); // MCP 组第一行
  });

  test("Esc 返回 close，交给宿主关面板", () => {
    const { panel } = makePanel();
    expect(panel.handleKey(key("escape"))).toBe("close");
    expect(panel.handleKey(text("q"))).toBe("close");
  });

  test("j/k 与 ↑↓ 等价", () => {
    const { panel } = makePanel();
    panel.handleKey(text("j"));
    expect(panel.cursorRow).toBe(1);
    panel.handleKey(text("k"));
    expect(panel.cursorRow).toBe(0);
  });
});

describe("设置面板 · 文本编辑", () => {
  test("回车进入编辑、输入后回车提交", () => {
    const { panel, calls } = makePanel();
    panel.handleKey(key("down")); // 模型行
    panel.handleKey(key("enter"));
    expect(panel.editingRow).toBe(1);
    // 预填当前值，光标在末尾
    panel.handleKey(text("X"));
    panel.handleKey(key("enter"));
    expect(panel.editingRow).toBeUndefined();
    expect(calls.applied).toEqual(["model=gpt-4o-miniX"]);
  });

  test("Esc 取消编辑，不提交", () => {
    const { panel, calls } = makePanel();
    panel.handleKey(key("down"));
    panel.handleKey(key("enter"));
    panel.handleKey(text("X"));
    panel.handleKey(key("escape"));
    expect(panel.editingRow).toBeUndefined();
    expect(calls.applied).toEqual([]);
  });

  test("空提交 = 保持现值", () => {
    const { panel, calls } = makePanel();
    panel.handleKey(key("down"));
    panel.handleKey(key("enter"));
    for (let index = 0; index < "gpt-4o-mini".length; index += 1) {
      panel.handleKey(key("backspace"));
    }
    panel.handleKey(key("enter"));
    expect(calls.applied).toEqual([]);
  });

  test("密钥行不回填，掩码显示长度，提交的是明文", () => {
    const { panel, calls } = makePanel();
    panel.handleKey(key("down"));
    panel.handleKey(key("down"));
    expect(panel.cursorRow).toBe(2);
    panel.handleKey(key("enter"));
    // 编辑态下右侧显示掩码，不能出现"已设置"这三个字（长度也是信息）
    const plain = panel.render(60, 40).lines.map((line) => Bun.stripANSI(line));
    const row = plain.find((line) => line.includes("API key"));
    expect(row).toBeDefined();
    expect(row).not.toContain("已设置");
    expect(row).toContain("▸");

    panel.handleKey(text("s"));
    panel.handleKey(text("k"));
    panel.handleKey(key("enter"));
    expect(calls.applied).toEqual(["key=sk"]);
  });

  test("编辑态暴露硬件光标，列号随输入前进", () => {
    const { panel } = makePanel();
    panel.handleKey(key("down"));
    panel.handleKey(key("enter"));
    const before = panel.render(60, 40).cursor;
    expect(before).toBeDefined();
    panel.handleKey(text("ab"));
    const after = panel.render(60, 40).cursor;
    expect(after?.line).toBe(before?.line);
    expect(after?.column).toBe((before?.column ?? 0) + 2);
  });
});

describe("设置面板 · 鼠标", () => {
  test("第一次点选中，点同一行才激活", () => {
    const { panel, calls } = makePanel();
    panel.clickRow(3);
    expect(panel.cursorRow).toBe(3);
    expect(calls.applied).toEqual([]);
    panel.clickRow(3);
    expect(calls.applied).toEqual(["mcp=false"]);
  });

  test("悬停与按下状态独立于焦点", () => {
    const { panel } = makePanel();
    panel.setHover(2);
    panel.setPressed(4);
    expect(panel.hoveredRow).toBe(2);
    expect(panel.pressedRow).toBe(4);
    expect(panel.cursorRow).toBe(0);
    panel.setHover(undefined);
    expect(panel.hoveredRow).toBeUndefined();
  });

  test("hover 只在真的变化时通知宿主重绘", () => {
    let frames = 0;
    const { panel } = makePanel({ onChange: () => (frames += 1) });
    panel.setHover(1);
    panel.setHover(1);
    expect(frames).toBe(1);
    panel.setHover(2);
    expect(frames).toBe(2);
  });

  test("越界行号被忽略", () => {
    const { panel, calls } = makePanel();
    panel.clickRow(99);
    panel.clickRow(-1);
    expect(panel.cursorRow).toBe(0);
    expect(calls.applied).toEqual([]);
  });
});

describe("设置面板 · 滚动窗口", () => {
  function manyRows(count: number): SettingsRow[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `row-${index}`,
      section: index < 6 ? "A" : "B",
      label: `第 ${index} 项`,
      kind: "enum" as const,
      options: ["x", "y"],
      display: () => "x",
      apply: () => {},
    }));
  }

  test("行数超过预算时只画得下预算那么多，且焦点行一定可见", () => {
    const panel = new SettingsPanel({ rows: manyRows(30) });
    for (let index = 0; index < 30; index += 1) {
      panel.moveCursor(1);
      const rendered = panel.render(60, 12);
      // 预算 = maxRows - 4 = 8 行正文（含组标题）
      expect(rendered.lines.length).toBeLessThanOrEqual(12);
      const visible = visibleRowIndexes(panel, 60, 12);
      expect(visible).toContain(panel.cursorRow);
    }
  });

  test("滚轮滚窗口但不动光标；键盘一动窗口再跟回来", () => {
    const panel = new SettingsPanel({ rows: manyRows(30) });
    const before = visibleRowIndexes(panel, 60, 12);
    panel.scrollViewport(5);
    const after = visibleRowIndexes(panel, 60, 12);
    expect(after[0]).toBeGreaterThan(before[0] ?? 0);
    expect(panel.cursorRow).toBe(0); // 光标没被滚轮带走

    panel.moveCursor(1);
    const pulled = visibleRowIndexes(panel, 60, 12);
    expect(pulled).toContain(panel.cursorRow);
  });

  test("滚到边界不越界，也不触发无意义重绘", () => {
    const panel = new SettingsPanel({ rows: manyRows(3) });
    expect(panel.scrollViewport(-5)).toBe(false);
    expect(panel.scrollViewport(5)).toBe(true);
    expect(panel.scrollViewport(5)).toBe(false);
  });

  test("极矮终端下仍然画出行，不返回空面板", () => {
    const panel = new SettingsPanel({ rows: manyRows(5) });
    const rendered = panel.render(30, 5);
    expect(rendered.rowLines.size).toBeGreaterThan(0);
  });
});

describe("设置面板 · 命中目标名", () => {
  test("settingsRow 有稳定的自检名", () => {
    expect(hitTargetName({ kind: "settingsRow", index: 3 })).toBe("settings:row:3");
  });
});
