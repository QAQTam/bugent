/**
 * ANSI 回放器：把 TUI 的输出流还原成"最终整屏"。
 *
 * 为什么需要它：TUI 用差分渲染，只重写发生变化的行。
 * 直接 cat 输出是一堆碎片，看不出屏幕最终长什么样 —— 调试 TUI 时非常难判断
 * "到底是没画，还是画了又被覆盖了"。
 *
 * 用法：
 *   bun run scripts/replay-ansi.ts <捕获文件> [行数] [列数]
 */

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (path === undefined) {
  process.stderr.write("用法：bun run scripts/replay-ansi.ts <捕获文件> [行数] [列数]\n");
  process.exit(1);
}

const rows = Number.parseInt(process.argv[3] ?? "24", 10);
const cols = Number.parseInt(process.argv[4] ?? "80", 10);
const raw = readFileSync(path, "utf8");

// 每个单元格存一个字符；宽字符占两格，第二格留空占位
const screen: string[][] = Array.from({ length: rows }, () => Array<string>(cols).fill(" "));
let row = 0;
let col = 0;

function clearAll(): void {
  for (const line of screen) line.fill(" ");
}

let i = 0;
while (i < raw.length) {
  const char = raw[i]!;

  if (char === "\x1b") {
    const match = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(raw.slice(i));
    if (match === null) {
      i += 1;
      continue;
    }

    const params = match[1]!;
    const final = match[2]!;

    if (final === "H") {
      const [r, c] = params.split(";").map((part) => Number.parseInt(part, 10) || 1);
      row = (r ?? 1) - 1;
      col = (c ?? 1) - 1;
    } else if (final === "K") {
      if (row >= 0 && row < rows) screen[row]!.fill(" ");
      col = 0;
    } else if (final === "J") {
      clearAll();
      row = 0;
      col = 0;
    }
    // 其余（颜色、光标显示/隐藏、备用屏切换）不影响字符布局

    i += match[0].length;
    continue;
  }

  if (char === "\n") {
    row += 1;
    col = 0;
    i += 1;
    continue;
  }
  if (char === "\r") {
    col = 0;
    i += 1;
    continue;
  }

  if (row >= 0 && row < rows && col >= 0 && col < cols) {
    screen[row]![col] = char;
    const width = Bun.stringWidth(char);
    if (width === 2 && col + 1 < cols) screen[row]![col + 1] = "";
    col += Math.max(1, width);
  }
  i += 1;
}

for (let r = 0; r < rows; r += 1) {
  process.stdout.write(`${String(r + 1).padStart(2)}│${screen[r]!.join("").replace(/\s+$/, "")}\n`);
}
