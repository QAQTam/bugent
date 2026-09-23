import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const strip = (text: string): string => Bun.stripANSI(text);

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

        output = "";
        terminal.write("\x1b[<35;5;15M");
        await waitFor(() => output, (text) => text.includes("\x1b[48;"));

        output = "";
        terminal.write("\x1b[<0;5;15M");
        await waitFor(() => output, (text) => text.includes("\x1b[48;"));

        output = "";
        terminal.write("\x1b[<0;5;15m");
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
