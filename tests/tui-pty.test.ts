import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bg } from "../src/tui/markdown.ts";
import { COLOR } from "../src/tui/theme.ts";
import { USER_BAND_MARK } from "../src/tui/user-band.ts";

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
  /** 差分帧里每行的起点是 `ESC[<行>;1H ESC[2K`，据此还原某段文字所在的屏幕行。 */
  const rowOfIn = (text: string, needle: string): number => {
    let found = 0;
    for (const m of text.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H|$)/g)) {
      if (strip(m[2]!).includes(needle)) found = Number(m[1]);
    }
    return found;
  };

  /**
   * 最后一帧的可见文字（帧以隐藏光标的 `\x1b[?25l` 开头）。
   *
   * 按钮是按下-抬起生效的：按下的那一帧只会换底色，动作要等抬起才发生。
   * 判断"动作有没有发生"必须看最后一帧，不能看累积输出 —— 累积里还留着
   * 按下那一帧的旧画面。
   */
  const lastFrame = (text: string): string => {
    const frames = text.split("\x1b[?25l").filter((frame) => frame.length > 0);
    return strip(frames.at(-1) ?? "");
  };

  /**
   * 找出画着某个按钮的那一行，以及按钮左边框的 1-based **显示列**。
   *
   * 不写死列号：按钮是居中的矩形，宽度一变（文案或边框改动）写死的坐标就
   * 点空了 —— 之前正是这样把「查看更多消息」点到了旁边的提示文字上。
   * 列号必须按显示宽度算：`indexOf` 给的是 UTF-16 下标，提示文字里的中文
   * 一个字符占两列，直接用下标会整体偏左。
   *
   * 取标签**左边最近**的边框字符：框形态是 `│`，紧凑形态是 `▐`；弹窗里还有
   * 一层对话框自己的竖线，不能认错。
   */
  const buttonAt = (text: string, label: string): { row: number; column: number } => {
    let found = { row: 0, column: -1 };
    for (const m of text.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H|$)/g)) {
      const visible = strip(m[2]!);
      const labelAt = visible.indexOf(label);
      if (labelAt < 0) continue;
      const before = visible.slice(0, labelAt);
      const edge = Math.max(before.lastIndexOf("│"), before.lastIndexOf("▐"));
      if (edge < 0) continue;
      found = { row: Number(m[1]), column: Bun.stringWidth(before.slice(0, edge)) + 1 };
    }
    return found;
  };

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
        terminal.write("line1");
        await waitFor(() => output, (text) => strip(text).includes("line1"));

        // Ctrl+J 必须真的换行：光标落到新一行的行首（第 13 行第 3 列）。
        // 这里刻意拆成两次写入并各等一帧：整段一次性写入会被帧调度器合流成
        // 一帧，中间态（新行还是空的）就不会被画出来。
        output = "";
        terminal.write("\n");
        await waitFor(() => output, (text) => text.includes("\x1b[13;3H\x1b[?25h"));

        output = "";
        terminal.write("line2");
        await waitFor(() => output, (text) => strip(text).includes("line2"));

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
    "左键点聊天正文不弹菜单，右键才弹",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "bugent-rightclick-"));
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

        /** 差分帧里每行的起点是 `ESC[<行>;1H ESC[2K`，据此还原回复正文所在的屏幕行。 */
        const replyRow = rowOfIn(output, "[mock] hello");
        expect(replyRow).toBeGreaterThan(0);

        // 左键点在正文上：什么都不该发生，尤其不能弹出消息操作菜单。
        output = "";
        terminal.write(`\x1b[<0;20;${replyRow}M\x1b[<0;20;${replyRow}m`);
        await Bun.sleep(300);
        expect(strip(output)).not.toContain("消息操作");

        // 同一个位置换成右键：菜单照常打开。
        output = "";
        terminal.write(`\x1b[<2;20;${replyRow}M\x1b[<2;20;${replyRow}m`);
        await waitFor(() => output, (text) => strip(text).includes("消息操作 · #"));

        // 菜单打开期间 Ctrl+C 归它（和对话框一样），先 Esc 关掉再退出。
        terminal.write("\x1b");
        await Bun.sleep(150);

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
        // 30 轮：回看窗口有 100 行的绝对下限，10 轮在 14 行终端上顶不到上限，
        // 滚动条 thumb 就不会出现在底部之外的行程上。
        terminal.write(
          Array.from({ length: 30 }, (_, index) => `drag-${index + 1}`).join("\r") + "\r",
        );
        await waitFor(() => output, (text) => strip(text).includes("turn 30"));

        // thumb 现在只有 1 格高、贴轨道底部：14 行终端正文 7 行 → 轨道 2..8，
        // 所以 thumb 在第 8 行（不是以前那对 6-7）。拖到轨道顶格。
        output = "";
        terminal.write("\x1b[<0;60;8M");
        terminal.write("\x1b[<32;60;2M");
        terminal.write("\x1b[<0;60;2m");

        await waitFor(() => output, (text) => strip(text).includes("查看更多消息"));

        // 核心断言：拖动确实把 chat 同步滚离了底部 —— 最后一条消息退出视口。
        //
        // 注意**不能**断言"第一条消息 drag-1 可见"：250 行内容里主视图只覆盖
        // 最近 100 行，drag-1 从定义上就是够不着的早期消息。
        expect(strip(output)).not.toContain("drag-30");

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
    "滚到回看上限可打开历史抽屉并回到最新",
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

        // 多轮消息把 transcript 推过回看上限（100 行绝对下限，10 轮不够）。
        terminal.write(
          Array.from({ length: 30 }, (_, index) => `m${String(index + 1).padStart(2, "0")}`).join("\r") +
            "\r",
        );
        await waitFor(() => output, (text) => strip(text).includes("turn 30"));

        output = "";
        // 一次 PageUp 滚「正文高度」行，而上限有 90+ 行 —— 按三下远远到不了，
        // 得一路滚到底。上限用稳定高度算，所以一次到底就正好停在最大值上。
        terminal.write("\x1b[5~".repeat(60));
        await waitFor(() => output, (text) => strip(text).includes("查看更多消息"));

        // 先按画出来的位置定位，再清空输出观察点击结果
        const more = buttonAt(output, "查看更多消息");
        expect(more.row).toBeGreaterThan(0);

        // 悬停到「查看更多消息」上：底色换成高亮色（变亮），形状与位置不变
        output = "";
        terminal.write(`\x1b[<35;${more.column + 3};${more.row}M`);
        await waitFor(() => output, (text) => text.includes(HOVER_BG));
        expect(strip(output)).toContain("│ 查看更多消息 │");
        expect(rowOfIn(output, "查看更多消息")).toBe(more.row);

        // 按下-抬起：只按下只换底色，不能提前生效；抬起才打开抽屉
        output = "";
        const moreX = more.column + 3;
        terminal.write(`\x1b[<0;${moreX};${more.row}M`);
        await waitFor(() => output, (text) => text.includes(PRESSED_BG));
        expect(lastFrame(output)).not.toContain("更早消息 · ↑↓");
        expect(strip(output)).toContain("│ 查看更多消息 │");

        output = "";
        terminal.write(`\x1b[<0;${moreX};${more.row}m`);
        await waitFor(() => output, (text) => strip(text).includes("更早消息 · ↑↓"));

        // 输入框变成 3 行框之后思考区下移一格，「回到最新消息」画在思考区最后三行。
        const back = buttonAt(output, "回到最新消息");
        expect(back.row).toBe(8);

        // 悬停到矩形按钮上：换的是底色（变亮），位置和形状都不动
        output = "";
        const hoverX = back.column + 3;
        terminal.write(`\x1b[<35;${hoverX};${back.row}M`);
        await waitFor(() => output, (text) => text.includes(HOVER_BG));
        const hovered = rowOfIn(output, "回到最新消息");
        expect(hovered).toBe(8);
        expect(strip(output)).toContain("│ 回到最新消息 │");

        output = "";
        const backX = back.column + 3;
        terminal.write(`\x1b[<0;${backX};${back.row}M\x1b[<0;${backX};${back.row}m`);
        // 按下只换底色，抬起才回到最新：等到"抽屉那一行不再是分隔线"为止
        await waitFor(
          () => output,
          (text) => text.length > 0 && !lastFrame(text).includes("更早消息 · ↑↓"),
        );
        expect(lastFrame(output)).not.toContain("更早消息 · ↑↓");

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
    "本轮用户消息滚出可视区后吸顶在顶部，下一轮输入后让位",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "bugent-band-"));
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 60,
        rows: 12,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      // 需要持久化：吸顶行要按 msgid 登记命中区（右键开消息菜单），
      // 没有 msgid 时它和普通消息一样不可点。
      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, TERM: "xterm-256color", BUGENT_HIT_PROBE: "1" },
        terminal,
        timeout: 20_000,
        killSignal: "SIGKILL",
      });

      // mock 只对第一轮做回显，所以"长提示词 = 长回复"这一轮必须放在第一个：
      // 回复一长，这一轮的用户消息就整块落到窗口上方（三屏上限之外），
      // 正是吸顶存在的意义。
      const longPrompt = `ALPHA-USER-MESSAGE ${"padding ".repeat(80)}TAIL-ALPHA`;

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));

        // 第一轮长消息：作答比窗口高，长回答保护把视口停在作答开头。
        terminal.write(`${longPrompt}\r`);
        await waitFor(() => output, (text) => strip(text).includes("[mock] ALPHA-USER-MESSAGE"));

        // 锚定刻意留了几行余量（高度要按"吸顶行 + 按钮都占位"估，否则作答开头
        // 会被切），所以用户消息的**尾部**此刻还露着 —— 吸顶行按定义不该出现。
        expect(strip(output)).not.toContain(USER_BAND_MARK);
        const headRow = rowOfIn(output, "[mock] ALPHA-USER-MESSAGE");
        expect(headRow).toBeGreaterThan(2);

        // 往下滚，把用户消息整块推出窗口 -> 顶部常驻一行
        output = "";
        terminal.write("\x1b[<65;10;5M\x1b[<65;10;5M");
        await waitFor(() => output, (text) => strip(text).includes(USER_BAND_MARK));
        expect(rowOfIn(output, USER_BAND_MARK)).toBe(2);
        expect(strip(output)).toContain(`${USER_BAND_MARK} › ALPHA-USER-MESSAGE`);

        // 吸顶行可点：右键它开消息菜单（顺便验证它的命中区是对的）
        output = "";
        terminal.write("\x1b[<2;20;2M\x1b[<2;20;2m");
        await waitFor(() => output, (text) => strip(text).includes("消息操作 · #"));
        expect(rowOfIn(output, "消息操作")).toBeGreaterThan(2);
        terminal.write("\x1b");
        await Bun.sleep(250);

        // 再滚回去：吸顶让位，正文回到原处 —— 吸顶只是顶部多一行，正文没有错位。
        //
        // 这里断言"吸顶消失 + 正文内容仍在"，不断言精确行号：差分渲染只重写变化的
        // 行，而往返之后的行内容与上一帧相比有些行是相同的，用累积输出反推行号会
        // 取到中间帧的位置。状态本身是对称的（滚动偏移 / 窗口起点 / 吸顶行数
        // 首尾完全一致），那才是这条用例真正要证的东西。
        output = "";
        terminal.write("\x1b[<64;10;5M\x1b[<64;10;5M");
        await Bun.sleep(300);
        expect(strip(output)).not.toContain(USER_BAND_MARK);
        expect(rowOfIn(output, "[mock] ALPHA-USER-MESSAGE")).toBeGreaterThan(2);

        // 第二轮（短消息）：新的一条就在窗口里，吸顶让位
        output = "";
        terminal.write("short-two\r");
        await waitFor(() => output, (text) => strip(text).includes("[mock] script exhausted"));
        // 它出现在正文里（带 `›` 前缀的行），而不是被钉在顶部的吸顶行
        expect(strip(output)).toContain("› short-two");
        expect(strip(output)).not.toContain(USER_BAND_MARK);

        terminal.write("/exit\r");
        expect(await proc.exited).toBe(0);
        // 自检开着：吸顶行参与命中登记后，仍然没有点不到的区域
        expect(strip(output)).not.toContain("[hit-probe]");
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
        await rm(home, { recursive: true, force: true });
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

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));
        terminal.write("hello\r");
        await waitFor(() => output, (text) => strip(text).includes("[mock] hello"));

        const replyRow = rowOfIn(output, "[mock] hello");
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
    "矮终端下弹窗按钮退化成紧凑形态，仍然点得到",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "bugent-compact-"));
      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        // 12 行放不下 3 行高的方框按钮（菜单要 15 行），必须整体退化
        cols: 60,
        rows: 12,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, TERM: "xterm-256color", BUGENT_HIT_PROBE: "1" },
        terminal,
        timeout: 20_000,
        killSignal: "SIGKILL",
      });

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));
        terminal.write("hello\r");
        await waitFor(() => output, (text) => strip(text).includes("[mock] hello"));

        const replyRow = rowOfIn(output, "[mock] hello");
        output = "";
        terminal.write(`\x1b[<2;20;${replyRow}M\x1b[<2;20;${replyRow}m`);
        await waitFor(() => output, (text) => strip(text).includes("消息操作 · #"));

        // 紧凑形态：一行一个 `▐ 标签 ▌`，菜单整个塞进 12 行里
        expect(strip(output)).toContain("▐ 复制（c） ▌");
        expect(strip(output)).toContain("└");

        const button = buttonAt(output, "复制");
        expect(button.row).toBeGreaterThan(2);
        output = "";
        const x = button.column + 3;
        terminal.write(`\x1b[<0;${x};${button.row}M\x1b[<0;${x};${button.row}m`);
        await waitFor(() => output, (text) => strip(text).includes("已复制"));

        terminal.write("/exit\r");
        expect(await proc.exited).toBe(0);
        expect(strip(output)).not.toContain("[hit-probe]");
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    20_000,
  );

  test(
    "待办面板默认折叠三行，点按钮展开/收起",
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

      const todos = Array.from({ length: 6 }, (_, index) => ({
        id: `step-${index + 1}`,
        content: `步骤 ${index + 1}：做点事情`,
        status: "pending",
      }));
      const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "--mock", "--no-persist"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERM: "xterm-256color",
          BUGENT_HIT_PROBE: "1",
          // mock 默认只回显文本；这里让它先发一次 todo_write，面板才有东西可画
          BUGENT_MOCK_TOOL_CALL: JSON.stringify({
            name: "todo_write",
            args: { summary: "联调待办面板", todos },
          }),
        },
        terminal,
        timeout: 20_000,
        killSignal: "SIGKILL",
      });

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));
        terminal.write("做个计划\r");
        await waitFor(() => output, (text) => strip(text).includes("展开全部"));

        // 折叠态 = 标题 + 当前项 + 展开按钮，第 6 项不该出现
        const collapsed = strip(output);
        expect(collapsed).toContain("待办 · 联调待办面板");
        expect(collapsed).toContain("[ ] 步骤 1：做点事情");
        expect(collapsed).not.toContain("步骤 6：做点事情");

        const expand = buttonAt(output, "展开全部");
        expect(expand.row).toBeGreaterThan(2);
        const expandX = expand.column + 3;
        output = "";
        terminal.write(`\x1b[<0;${expandX};${expand.row}M\x1b[<0;${expandX};${expand.row}m`);
        await waitFor(() => output, (text) => strip(text).includes("收起"));
        expect(strip(output)).toContain("步骤 6：做点事情");

        // 展开态最后一行是收起按钮
        const collapse = buttonAt(output, "收起");
        const collapseX = collapse.column + 3;
        output = "";
        terminal.write(`\x1b[<0;${collapseX};${collapse.row}M\x1b[<0;${collapseX};${collapse.row}m`);
        // 折叠后第 6 项要消失：判最后一帧，累积输出里还留着展开时的旧画面
        await waitFor(
          () => output,
          (text) => text.length > 0 && lastFrame(text).includes("展开全部"),
        );
        expect(lastFrame(output)).not.toContain("步骤 6：做点事情");

        terminal.write("/exit\r");
        expect(await proc.exited).toBe(0);
        expect(strip(output)).not.toContain("[hit-probe]");
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
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

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));
        terminal.write("hello\r");
        await waitFor(() => output, (text) => strip(text).includes("[mock] hello"));

        // 1) 消息操作菜单：弹窗按钮 + 弹窗正文 + 左右边框
        const replyRow = rowOfIn(output, "[mock] hello");
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
        // 一次性灌入 10 条消息，加上开头的 "hello" 共 11 轮，跑完停在 turn 11。
        // 只等最终态：中间轮次会被帧调度器合流成一帧，逐轮的 turn 号不再单独出现。
        await waitFor(() => output, (text) => strip(text).includes("turn 11"), 20_000);
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
  test(
    "流式文本逐帧出现：帧率跟着 token 到达走，而不是被定时器压到 12.5fps",
    async () => {
      // 回归防线。曾经 onText 不请求重绘，纯文本流式时只剩 80ms 的菊花定时器
      // 在兜底 —— 300 tok/s 下每 80ms 一次性吐约 24 个 token，肉眼就是"成批"。
      //
      // 这里用 mock 的分块流式把 token 到达节奏钉死（20ms 一块），然后只测
      // **帧率**。帧率是时长归一化的，所以机器快慢都不影响判据：
      //   回归（定时器兜底）：1000 / 80ms = 12.5 fps
      //   修复（内容驱动）  ：约 50 fps，受 20ms 到达间隔限制
      // 实测：回归 14.2 fps / 修复 48.2 fps，阈值取 25 两边都留了约 2 倍余量。
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
        env: {
          ...process.env,
          TERM: "xterm-256color",
          BUGENT_MOCK_CHUNK_CHARS: "1",
          BUGENT_MOCK_CHUNK_DELAY_MS: "20",
        },
        terminal,
        timeout: 20_000,
        killSignal: "SIGKILL",
      });

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));

        output = "";
        const startedAt = Date.now();
        terminal.write("abcdefghijklmnopqrstuvwxyz\r");
        await waitFor(
          () => output,
          (text) => strip(text).includes("[mock] abcdefghijklmnopqrstuvwxyz"),
          15_000,
        );
        const elapsedMs = Date.now() - startedAt;

        // 一帧 = 一段以隐藏光标开头的差分输出。
        const frames = (output.match(/\x1b\[\?25l/g) ?? []).length;
        expect(frames / (elapsedMs / 1000)).toBeGreaterThanOrEqual(25);

        // 顺带钉住语义：回复是"逐步长出来"的，不是一两批画完。
        const growthSteps = new Set(
          [...output.matchAll(/\[mock\]\s?[a-z]*/g)].map((match) => match[0].length),
        ).size;
        expect(growthSteps).toBeGreaterThanOrEqual(12);

        terminal.write("\x03");
        expect(await proc.exited).toBe(0);
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
      }
    },
    30_000,
  );

  test(
    "滚动条出现时，工具卡片行尾的 +N -M 徽标不被吞掉",
    async () => {
      // 回归防线。`composeScrollbar` 会把正文每一行截断到 `width - 1` 再在最右列
      // 画轨道 —— 正文此前没有右侧留白，于是行尾**右对齐**的徽标正好被这一列吃掉，
      // 截断补上的省略号盖在徽标上，看上去就像"徽标超出了终端宽度"。
      //
      // 这里用矮终端（rows=20）逼出滚动条，再断言 apply_patch 那一行仍带着 +N。
      const home = await mkdtemp(join(tmpdir(), "bugent-gutter-"));
      const work = await mkdtemp(join(tmpdir(), "bugent-gutter-ws-"));
      const patch = [
        "*** Begin Patch",
        "*** Add File: probe.ts",
        "+one",
        "+two",
        "+three",
        "*** End Patch",
      ].join("\n");

      let output = "";
      const decoder = new TextDecoder();
      const terminal = new Bun.Terminal({
        cols: 80,
        rows: 20,
        data(_terminal, data) {
          output += decoder.decode(data, { stream: true });
        },
      });

      const proc = Bun.spawn(
        [process.execPath, "run", join(process.cwd(), "src/index.ts"), "--mock", "--mode", "workspace-write"],
        {
          cwd: work,
          env: {
            ...process.env,
            HOME: home,
            TERM: "xterm-256color",
            BUGENT_MOCK_TOOL_CALL: JSON.stringify({ name: "apply_patch", args: { patch } }),
          },
          terminal,
          timeout: 20_000,
          killSignal: "SIGKILL",
        },
      );

      try {
        await waitFor(() => output, (text) => strip(text).includes("已就绪"));

        output = "";
        terminal.write("go\r");
        // 等到工具真正执行完 —— 此时卡片头部应当是 "⏺ apply_patch … +3"
        await waitFor(() => output, (text) => strip(text).includes("Success. Updated"), 15_000);

        const frames = output.split("\x1b[?25l").filter((frame) => frame.length > 0);
        const lastFrame = strip(frames.at(-1) ?? "");
        const cardLine = lastFrame.split("\n").find((line) => line.includes("apply_patch")) ?? "";

        expect(cardLine).toContain("apply_patch");
        expect(cardLine).toMatch(/\+3/);

        terminal.write("\x03");
        expect(await proc.exited).toBe(0);
      } finally {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        terminal.close();
        await rm(home, { recursive: true, force: true });
        await rm(work, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
