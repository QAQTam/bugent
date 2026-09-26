/**
 * `/setting` 居中设置面板的 PTY 验收。
 *
 * 单测只能证明状态机与几何函数对；"画在终端正中"和"鼠标点得动"必须看真实
 * 终端输出 —— 这里按差分帧还原屏幕，再断言面板的上下留白相等、左右留白相等，
 * 最后用一次真实左键点击证明行真的能改配置。
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const strip = (text: string): string => Bun.stripANSI(text);

async function waitFor(
  getText: () => string,
  predicate: (text: string) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate(getText())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`PTY 等待超时，最后输出：\n${strip(getText()).slice(-2000)}`);
    }
    await Bun.sleep(20);
  }
}

/** 按差分帧还原屏幕：后写的行覆盖先写的，和真实终端一致。 */
function screenOf(text: string, rows: number): string[] {
  const screen = Array.from({ length: rows }, () => "");
  for (const match of text.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H|\x1b\[\?25|$)/g)) {
    const row = Number(match[1]) - 1;
    if (row >= 0 && row < rows) screen[row] = strip(match[2]!);
  }
  return screen;
}

const COLS = 80;
const ROWS = 24;

describe("/setting 居中设置面板（PTY）", () => {
  test(
    "面板落在终端正中，且鼠标左键点行能改配置",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "bugent-setting-"));
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: COLS,
        rows: ROWS,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, TERM: "xterm-256color" },
        terminal,
      });

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));

        output = "";
        terminal.write("/setting");
        terminal.write("\r");
        await waitFor(() => output, (text) => strip(text).includes("Esc 关闭"));

        const screen = screenOf(output, ROWS);
        const topIndex = screen.findIndex((line) => line.includes("┌"));
        const bottomIndex = screen.findIndex((line) => line.includes("└"));
        expect(topIndex).toBeGreaterThan(0);
        expect(bottomIndex).toBeGreaterThan(topIndex);

        // 垂直居中：上下留白相等（1-based 屏幕行号）
        const marginAbove = topIndex;
        const marginBelow = ROWS - 1 - bottomIndex;
        expect(Math.abs(marginAbove - marginBelow)).toBeLessThanOrEqual(1);
        // 而且必须**不是**贴底（贴底时下方留白为 0，上方一大截）
        expect(marginBelow).toBeGreaterThan(1);

        // 水平居中：左右留白相等
        const top = screen[topIndex]!;
        const left = top.indexOf("┌");
        const right = top.lastIndexOf("┐");
        expect(left).toBeGreaterThan(0);
        expect(left).toBe(COLS - 1 - right);

        // 面板内容确实在：组标题、行、提示
        const text = screen.join("\n");
        expect(text).toContain("档位");
        expect(text).toContain("沙箱");

        // 左键点「档位」行 -> 档位从 workspace-write 前进到 no-sandbox，
        // 状态栏（第 1 行）必须跟着变 —— 证明点击真的落到了这一行上。
        // 注意从面板内部开始找：正文里的启动横幅也含"档位"二字。
        const modeRow =
          screen.findIndex((line, index) => index > topIndex && line.includes("档位")) + 1;
        expect(modeRow).toBeGreaterThan(topIndex + 1);
        expect(modeRow).toBeLessThanOrEqual(bottomIndex + 1);
        expect(screen[0]).toContain("workspace-write");

        output = "";
        terminal.write(`\x1b[<0;20;${modeRow}M\x1b[<0;20;${modeRow}m`);
        await waitFor(() => output, () => screenOf(output, ROWS)[0]?.includes("no-sandbox") ?? false);

        // Esc 关闭面板，回到普通界面
        output = "";
        terminal.write("\x1b");
        await waitFor(() => output, (frame) => !strip(frame).includes("Esc 关闭"));

        terminal.write("\x03");
        expect(await proc.exited).toBe(0);
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
