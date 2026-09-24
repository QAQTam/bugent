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
        await waitFor(
          () => output,
          (text) => strip(text).includes("one") && strip(text).includes("two"),
        );
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
    "硬件光标跟随输入逻辑位置，供 IME 定位候选窗",
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
        expect(output).toContain("\x1b[13;3H\x1b[?25h");

        output = "";
        terminal.write("你好");
        await waitFor(() => output, (text) => strip(text).includes("你好"));
        expect(output).toContain("\x1b[13;7H\x1b[?25h");

        output = "";
        terminal.write("\x1b[D");
        await waitFor(() => output, (text) => text.includes("\x1b[13;5H\x1b[?25h"));

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
    "Ctrl+J 输入多行，Enter 一次性提交",
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
        terminal.write("line1\nline2");
        await waitFor(
          () => output,
          (text) => strip(text).includes("line1") && strip(text).includes("line2"),
        );
        expect(output).toContain("\x1b[13;3H\x1b[?25h");

        output = "";
        terminal.write("\r");
        await waitFor(
          () => output,
          (text) => strip(text).includes("[mock] line1") && strip(text).includes("line2"),
        );
        expect(strip(output)).toContain("turn 1");

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
        terminal.write("hello\r");
        await waitFor(() => output, (text) => strip(text).includes("[mock] hello"));

        terminal.write("\x1b[<2;20;12M\x1b[<2;20;12m");
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

        terminal.write("/\r");
        await waitFor(() => output, (text) => strip(text).includes("选择命令"));
        await waitFor(() => output, (text) => strip(text).includes("/context"));

        terminal.write("a\r");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\r");

        await waitFor(() => output, (text) => strip(text).includes("会话上下文"));
        await waitFor(() => output, (text) => strip(text).includes("sandbox"));

        terminal.write("m");
        await waitFor(() => output, (text) => strip(text).includes("选择要调整的配置"));
        terminal.write("a\r");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\r");

        await waitFor(() => output, (text) => strip(text).includes("选择当前 session 的沙箱档位"));
        terminal.write("a\r");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\r");

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

        terminal.write("/key\r");
        await waitFor(() => output, (text) => strip(text).includes("输入 API key"));
        terminal.write("sk-secret-123\r");
        output = "";
        terminal.write("\r");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        output = "";
        terminal.write("\r");
        await waitFor(() => output, (text) => strip(text).includes("API key 仅当前进程生效"));
        expect(strip(output)).not.toContain("sk-secret-123");

        output = "";
        terminal.write("/model\r");
        await waitFor(() => output, (text) => strip(text).includes("输入模型名"));
        terminal.write("echo2\r");
        output = "";
        terminal.write("\r");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        output = "";
        terminal.write("\r");
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
        terminal.write("/provider\r");
        await waitFor(() => output, (text) => strip(text).includes("选择当前 session 的 provider"));
        terminal.write("c\r");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\r");

        await waitFor(() => output, (text) => strip(text).includes("输入 provider id"));
        terminal.write("localnew\r");
        output = "";
        terminal.write("\r");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\r");

        await waitFor(() => output, (text) => strip(text).includes("选择 provider endpoint"));
        terminal.write("b\r");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\r");

        await waitFor(() => output, (text) => strip(text).includes("输入 base URL"));
        terminal.write("\r");
        output = "";
        terminal.write("\r");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\r");

        await waitFor(() => output, (text) => strip(text).includes("配置高级字段？"));
        terminal.write("a\r");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\r");

        await waitFor(() => output, (text) => strip(text).includes("输入 API key"));
        terminal.write("\r");
        output = "";
        terminal.write("\r");
        await waitFor(() => output, (text) => strip(text).includes("汇总"));
        terminal.write("\r");

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
    "右侧 scrollback 拖动时同步滚动 chat",
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
        terminal.write(
          Array.from({ length: 10 }, (_, index) => `drag-${index + 1}`).join("\r") + "\r",
        );
        await waitFor(() => output, (text) => strip(text).includes("turn 10"));

        // Bottom thumb occupies rows 6-7. Drag it to the top track cell.
        output = "";
        terminal.write("\x1b[<0;60;6M");
        terminal.write("\x1b[<32;60;2M");
        terminal.write("\x1b[<0;60;2m");
        await waitFor(() => output, (text) => strip(text).includes("查看更多消息"));

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
          Array.from({ length: 10 }, (_, index) => `m${String(index + 1).padStart(2, "0")}`).join("\r") +
            "\r",
        );
        await waitFor(() => output, (text) => strip(text).includes("turn 10"));

        terminal.write("\x1b[5~\x1b[5~\x1b[5~");
        await waitFor(() => output, (text) => strip(text).includes("查看更多消息"));

        output = "";
        terminal.write("\x1b[<0;30;2M\x1b[<0;30;2m");
        await waitFor(() => output, (text) => strip(text).includes("更早消息 · ↑↓"));

        output = "";
        // 输入框变成 3 行框之后思考区下移一格，“回到最新消息”在第 9 行。
        terminal.write("\x1b[<0;30;9M\x1b[<0;30;9m");
        await waitFor(() => output, (text) => text.length > 0);
        expect(strip(output)).not.toContain("更早消息 · ↑↓");

        terminal.write("/exit\r");
        expect(await proc.exited).toBe(0);
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
      }
    },
    20_000,
  );

  test(
    "点击输入框定位光标；点框外不影响输入焦点",
    async () => {
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 80,
        rows: 24,
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

      const click = (x: number, y: number): void => {
        terminal.write(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
      };

      try {
        // 80x24：空输入是 3 行框，占第 22-24 行，内容行 23。
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));
        expect(strip(output)).toContain("┌");
        expect(strip(output)).toContain("输入消息，/ 查看命令");
        expect(output).toContain("\x1b[23;3H\x1b[?25h");

        output = "";
        terminal.write("abc");
        await waitFor(() => output, (text) => strip(text).includes("abc"));
        expect(strip(output)).not.toContain("输入消息");
        expect(output).toContain("\x1b[23;6H\x1b[?25h");

        // 点正文空白处：光标不动，输入框仍然是按键汇聚点。
        output = "";
        click(20, 16);
        await Bun.sleep(120);
        terminal.write("d");
        await waitFor(() => output, (text) => strip(text).includes("abcd"));
        expect(output).toContain("\x1b[23;7H\x1b[?25h");

        // 点框内第 4 列（文本区第 2 格）：光标回到索引 1。
        output = "";
        click(4, 23);
        await waitFor(() => output, (text) => text.includes("\x1b[23;4H\x1b[?25h"));
        output = "";
        terminal.write("X");
        await waitFor(() => output, (text) => strip(text).includes("aXbcd"));

        // 点框外最右一列（框只到第 79 列）：什么都不做，继续能打字。
        // 此时光标在 "aX|bcd" 的索引 2，所以 e 插在中间。
        output = "";
        click(80, 23);
        await Bun.sleep(120);
        terminal.write("e");
        await waitFor(() => output, (text) => strip(text).includes("aXebcd"));
        expect(output).toContain("\x1b[23;6H\x1b[?25h");

        // 点边框不是死区：光标落到首行末尾。
        output = "";
        click(10, 22);
        await waitFor(() => output, (text) => text.includes("\x1b[23;9H\x1b[?25h"));
        output = "";
        terminal.write("f");
        await waitFor(() => output, (text) => strip(text).includes("aXebcdf"));

        // 一轮点击之后回车照样提交：不存在"未激活"状态。
        output = "";
        terminal.write("\r");
        await waitFor(() => output, (text) => strip(text).includes("[mock] aXebcdf"));

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
    "弹窗占据输入框位置时不登记命中，关闭后输入框立刻恢复可输入",
    async () => {
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 80,
        rows: 24,
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
        expect(strip(output)).toContain("输入消息，/ 查看命令");

        // `/` 打开命令面板：它取代输入框。
        output = "";
        terminal.write("/");
        terminal.write("\r");
        await waitFor(() => output, (text) => strip(text).includes("选择命令"));
        await Bun.sleep(150);

        // 画出面板的那一帧不应该再画输入框（清空输入时会有一帧过渡，
        // 所以只看最后一帧）。帧以隐藏光标的 `\x1b[?25l` 开头。
        const frames = output.split("\x1b[?25l").filter((frame) => frame.length > 0);
        const lastFrame = frames.at(-1) ?? "";
        expect(strip(lastFrame)).toContain("选择命令");
        expect(strip(lastFrame)).not.toContain("输入消息，/ 查看命令");

        // 点到原输入框所在的位置：不应把光标放进一个看不见的框里 ——
        // 面板打开期间这次点击应该什么都不做。
        output = "";
        terminal.write("\x1b[<0;10;23M\x1b[<0;10;23m");
        await Bun.sleep(200);
        expect(output).toBe("");

        // Esc 两次终止面板，输入框应当立刻回来。
        output = "";
        terminal.write("\x1b\x1b");
        await waitFor(() => output, (text) => strip(text).includes("输入消息，/ 查看命令"));

        output = "";
        terminal.write("z");
        await waitFor(() => output, (text) => strip(text).includes("z"));
        expect(strip(output)).not.toContain("输入消息");

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
    "COLORFGBG 说浅色终端时行内代码改用浅色底，且不再查询",
    async () => {
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 80,
        rows: 24,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock", "--no-persist"], {
        cwd: process.cwd(),
        env: { ...process.env, TERM: "xterm-256color", COLORFGBG: "0;15" },
        terminal,
        timeout: 15_000,
        killSignal: "SIGKILL",
      });

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));
        // 横幅里的 `/context`、`ESC` 等行内代码用浅色底 254，而不是深色底 236
        expect(output).toContain("\x1b[48;5;254m");
        expect(output).not.toContain("\x1b[48;5;236m");
        // 已经有线索了，就不该再发查询
        expect(output).not.toContain("\x1b]11;?");

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
    "没有 COLORFGBG 时会查询底色，迟到的应答不会漏进输入框",
    async () => {
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 80,
        rows: 24,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const env: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color" };
      delete env.COLORFGBG;

      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock", "--no-persist"], {
        cwd: process.cwd(),
        env,
        terminal,
        timeout: 15_000,
        killSignal: "SIGKILL",
      });

      try {
        await waitFor(() => output, (text) => text.includes("\x1b]11;?"));
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));

        // 探测已经超时收场，这时才把应答喂进来：它必须被整段吃掉。
        output = "";
        terminal.write("\x1b]11;rgb:ffff/ffff/ffff\x07");
        terminal.write("abc");
        await waitFor(() => output, (text) => strip(text).includes("abc"));
        expect(strip(output)).not.toContain("]11;rgb");
        expect(strip(output)).toContain("abc");

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
    "宽终端下弹窗按钮就画在鼠标能点到的地方",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "bugent-dialog-"));
      const COLS = 120;
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: COLS,
        rows: 30,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, TERM: "xterm-256color" },
        terminal,
        timeout: 20_000,
        killSignal: "SIGKILL",
      });

      /** 差分帧里每行的起点是 `ESC[<行>;1H ESC[2K`，据此还原某段文字所在的屏幕行。 */
      const rowOf = (text: string, needle: string): number => {
        let found = 0;
        for (const m of text.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H|$)/g)) {
          if (strip(m[2]!).includes(needle)) found = Number(m[1]);
        }
        return found;
      };
      /** 找出画着某个按钮的那一行，以及它第一个 `▐` 的 0-based 列。 */
      const buttonAt = (text: string, label: string): { row: number; column: number } => {
        let found = { row: 0, column: -1 };
        for (const m of text.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H|$)/g)) {
          const visible = strip(m[2]!);
          if (visible.includes("▐") && visible.includes(label)) {
            found = { row: Number(m[1]), column: visible.indexOf("▐") + 1 }; // 1-based 列
          }
        }
        return found;
      };

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));
        terminal.write("hello\r");
        await waitFor(() => output, (text) => strip(text).includes("[mock] hello"));

        const replyRow = rowOf(output, "[mock] hello");
        expect(replyRow).toBeGreaterThan(0);

        output = "";
        terminal.write(`\x1b[<2;10;${replyRow}M\x1b[<2;10;${replyRow}m`);
        await waitFor(() => output, (text) => strip(text).includes("消息操作 · #"));

        const button = buttonAt(output, "复制");
        expect(button.column).toBeGreaterThan(0);
        // 120 列下弹窗居中留白 22 列，按钮画在第 25 列往后
        expect(button.column).toBe(25);

        // 点在按钮**画出来的位置**上，必须命中
        output = "";
        const x = button.column + 3;
        terminal.write(`\x1b[<0;${x};${button.row}M\x1b[<0;${x};${button.row}m`);
        await waitFor(() => output, (text) => strip(text).includes("已复制"));

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
    "命中区间自检：一轮真实交互里没有点不到的区域",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "bugent-hitprobe-"));
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        // 用 120 列：坐标系偏移类问题的偏差随终端宽度放大，窄屏容易蒙中
        cols: 120,
        rows: 30,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, TERM: "xterm-256color", BUGENT_HIT_PROBE: "1" },
        terminal,
        timeout: 30_000,
        killSignal: "SIGKILL",
      });

      /** 差分帧里每行的起点是 `ESC[<行>;1H ESC[2K`，据此还原某段文字所在的屏幕行。 */
      const rowOf = (needle: string): number => {
        let found = 0;
        for (const m of output.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H|$)/g)) {
          if (strip(m[2]!).includes(needle)) found = Number(m[1]);
        }
        return found;
      };

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));
        terminal.write("hello\r");
        await waitFor(() => output, (text) => strip(text).includes("[mock] hello"));

        // 1) 消息操作菜单：弹窗按钮 + 弹窗正文 + 左右边框
        const replyRow = rowOf("[mock] hello");
        terminal.write(`\x1b[<2;10;${replyRow}M\x1b[<2;10;${replyRow}m`);
        await waitFor(() => output, (text) => strip(text).includes("消息操作 · #"));
        terminal.write("\x1b");
        await Bun.sleep(150);

        // 2) ask_user 面板
        terminal.write("/\r");
        await waitFor(() => output, (text) => strip(text).includes("选择命令"));
        terminal.write("\x1b\x1b");
        await Bun.sleep(200);

        // 3) 输入框
        terminal.write("\x1b[<0;10;29M\x1b[<0;10;29m");
        await Bun.sleep(150);

        // 4) 内容溢出：滚动条、查看更多消息、回到最新消息
        terminal.write(Array.from({ length: 10 }, (_, index) => `m${index + 1}`).join("\r") + "\r");
        await waitFor(() => output, (text) => strip(text).includes("turn 10"), 20_000);
        terminal.write("\x1b[5~\x1b[5~");
        await Bun.sleep(300);

        // 自检报告写 stderr，和屏幕共用同一个 PTY。只比对报告本身，
        // 免得失败时把整屏输出都打出来。
        const reports = [...strip(output).matchAll(/\[hit-probe\][^\n]*\n(?:  [^\n]*\n)*/g)]
          .map((match) => match[0].trim())
          .join("\n");
        expect(reports).toBe("");

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
