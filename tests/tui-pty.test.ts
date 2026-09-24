import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bg } from "../src/tui/markdown.ts";
import { COLOR } from "../src/tui/theme.ts";

const strip = (text: string): string => Bun.stripANSI(text);
const HOVER_BG = bg(COLOR.buttonHoverBg);
const PRESSED_BG = bg(COLOR.buttonPressedBg);

async function waitFor(
  getText: () => string,
  predicate: (text: string) => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate(getText())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`PTY 等待超时，最后输出：\n${strip(getText()).slice(-2000)}`);
    }
    await Bun.sleep(20);
  }
}

describe("TUI PTY 冒烟", () => {
  test(
    "多行 bracketed paste 只进入输入框，不自动提交",
    async () => {
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 60,
        rows: 14,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock", "--no-persist"], {
        cwd: process.cwd(),
        env: { ...process.env, TERM: "xterm-256color" },
        terminal,
        timeout: 15_000,
        killSignal: "SIGKILL",
      });

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));

        output = "";
        terminal.write("\x1b[200~one\ntwo\x1b[201~");
        await waitFor(() => output, (text) => strip(text).includes("one two"));
        expect(strip(output)).not.toContain("turn 1");

        terminal.write("\x03");
        expect(await proc.exited).toBe(0);
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
      }
    },
    20_000,
  );

  test(
    "消息操作按钮支持 hover、按下和抬起确认",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "bugent-hover-"));
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 80,
        rows: 24,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, TERM: "xterm-256color" },
        terminal,
        timeout: 15_000,
        killSignal: "SIGKILL",
      });

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));
        terminal.write("hello\n");
        await waitFor(() => output, (text) => strip(text).includes("[mock] hello"));

        terminal.write("\x1b[<2;20;11M\x1b[<2;20;11m");
        await waitFor(() => output, (text) => strip(text).includes("消息操作"));
        expect(output).toContain(bg(COLOR.dialogBg));

        output = "";
        // 弹窗现在占据输入区，按钮在屏幕底部附近（第 22 行）。
        terminal.write("\x1b[<35;5;22M");
        await waitFor(() => output, (text) => text.includes(HOVER_BG));

        output = "";
        terminal.write("\x1b[<0;5;22M");
        await waitFor(() => output, (text) => text.includes(PRESSED_BG));

        output = "";
        terminal.write("\x1b[<0;5;22m");
        await waitFor(() => output, (text) => strip(text).includes("[已复制 5 字符]"));

        terminal.write("\x03");
        expect(await proc.exited).toBe(0);
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test(
    "斜杠命令菜单可以打开 /context 并切换 session 沙箱档位",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "bugent-context-"));
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 100,
        rows: 30,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, TERM: "xterm-256color" },
        terminal,
        timeout: 15_000,
        killSignal: "SIGKILL",
      });

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));

        terminal.write("/\n");
        await waitFor(() => output, (text) => strip(text).includes("选择命令"));
        await waitFor(() => output, (text) => strip(text).includes("/context"));

        terminal.write("a\n");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\n");

        await waitFor(() => output, (text) => strip(text).includes("会话上下文"));
        await waitFor(() => output, (text) => strip(text).includes("sandbox"));

        terminal.write("m");
        await waitFor(() => output, (text) => strip(text).includes("选择要调整的配置"));
        terminal.write("a\n");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\n");

        await waitFor(() => output, (text) => strip(text).includes("选择当前 session 的沙箱档位"));
        terminal.write("a\n");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\n");

        await waitFor(() => output, (text) => strip(text).includes("当前 session 配置已更新"));
        await waitFor(() => output, (text) => strip(text).includes("read-only"));

        terminal.write("\x03");
        expect(await proc.exited).toBe(0);
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test(
    "/key 掩码输入且 /model 可以切换当前 session 模型",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "bugent-key-"));
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 100,
        rows: 30,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, TERM: "xterm-256color" },
        terminal,
        timeout: 15_000,
        killSignal: "SIGKILL",
      });

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));

        terminal.write("/key\n");
        await waitFor(() => output, (text) => strip(text).includes("输入 API key"));
        terminal.write("sk-secret-123\n");
        output = "";
        terminal.write("\n");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        output = "";
        terminal.write("\n");
        await waitFor(() => output, (text) => strip(text).includes("API key 仅当前进程生效"));
        expect(strip(output)).not.toContain("sk-secret-123");

        output = "";
        terminal.write("/model\n");
        await waitFor(() => output, (text) => strip(text).includes("输入模型名"));
        terminal.write("echo2\n");
        output = "";
        terminal.write("\n");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        output = "";
        terminal.write("\n");
        await waitFor(() => output, (text) => strip(text).includes("mock/echo2"));

        terminal.write("\x03");
        expect(await proc.exited).toBe(0);
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test(
    "可以在 TUI 里新增 session 级 provider",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "bugent-provider-"));
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 100,
        rows: 30,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, TERM: "xterm-256color" },
        terminal,
        timeout: 15_000,
        killSignal: "SIGKILL",
      });

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));

        output = "";
        terminal.write("/provider\n");
        await waitFor(() => output, (text) => strip(text).includes("选择当前 session 的 provider"));
        terminal.write("c\n");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\n");

        await waitFor(() => output, (text) => strip(text).includes("输入 provider id"));
        terminal.write("localnew\n");
        output = "";
        terminal.write("\n");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\n");

        await waitFor(() => output, (text) => strip(text).includes("选择 provider endpoint"));
        terminal.write("b\n");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\n");

        await waitFor(() => output, (text) => strip(text).includes("输入 base URL"));
        terminal.write("\n");
        output = "";
        terminal.write("\n");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\n");

        await waitFor(() => output, (text) => strip(text).includes("配置高级字段？"));
        terminal.write("a\n");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\n");

        await waitFor(() => output, (text) => strip(text).includes("输入 API key"));
        terminal.write("\n");
        output = "";
        terminal.write("\n");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\n");

        await waitFor(() => output, (text) => strip(text).includes("localnew/echo"));

        terminal.write("\x03");
        expect(await proc.exited).toBe(0);
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test(
    "滚到三屏上限可打开历史抽屉并回到最新",
    async () => {
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 60,
        rows: 12,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock", "--no-persist"], {
        cwd: process.cwd(),
        env: { ...process.env, TERM: "xterm-256color" },
        terminal,
        timeout: 15_000,
        killSignal: "SIGKILL",
      });

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));

        // 多轮消息把 transcript 推过三屏阈值。
        terminal.write(
          Array.from({ length: 10 }, (_, index) => `m${String(index + 1).padStart(2, "0")}`).join("\n") +
            "\n",
        );
        await waitFor(() => output, (text) => strip(text).includes("turn 10"));

        terminal.write("\x1b[5~\x1b[5~\x1b[5~");
        await waitFor(() => output, (text) => strip(text).includes("查看更多消息"));

        output = "";
        terminal.write("\x1b[<0;30;2M\x1b[<0;30;2m");
        await waitFor(() => output, (text) => strip(text).includes("更早消息 · ↑↓"));

        output = "";
        terminal.write("\x1b[<0;30;8M\x1b[<0;30;8m");
        await waitFor(() => output, (text) => text.length > 0);
        expect(strip(output)).not.toContain("更早消息 · ↑↓");

        terminal.write("/exit\n");
        expect(await proc.exited).toBe(0);
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
      }
    },
    20_000,
  );
});
