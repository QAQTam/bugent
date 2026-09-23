/**
 * 按键解析器（raw mode 输入 -> 语义化 Key）。
 *
 * 纯函数式、可单测：不碰 stdin，只吃字符串吐 Key[]。
 * 难点在于转义序列可能被 TCP/PTY 拆包，所以内部维护 pending 缓冲，
 * 遇到不完整的序列就等下一批数据。
 */

export type MouseButton = "left" | "middle" | "right" | "wheelUp" | "wheelDown" | "other";

export type Key =
  | { type: "text"; value: string }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "tab" }
  | { type: "escape" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "pageUp" }
  | { type: "pageDown" }
  | { type: "ctrl"; key: string }
  /** 鼠标事件（SGR 扩展模式，坐标是 1-based）。 */
  | { type: "mouse"; button: MouseButton; x: number; y: number; pressed: boolean };

function mouseButton(code: number): MouseButton {
  // 低两位是按键；64 以上是滚轮
  if ((code & 64) !== 0) {
    return (code & 1) === 0 ? "wheelUp" : "wheelDown";
  }
  switch (code & 3) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "other";
  }
}

/** 解析 SGR 鼠标序列的参数，如 `"<0;10;5"`。 */
function parseMouse(params: string, final: string): Key | undefined {
  if (!params.startsWith("<")) return undefined;
  const parts = params.slice(1).split(";");
  if (parts.length !== 3) return undefined;

  const [codeRaw, xRaw, yRaw] = parts;
  const code = Number.parseInt(codeRaw ?? "", 10);
  const x = Number.parseInt(xRaw ?? "", 10);
  const y = Number.parseInt(yRaw ?? "", 10);
  if (!Number.isFinite(code) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;

  return { type: "mouse", button: mouseButton(code), x, y, pressed: final === "M" };
}

function csiToKey(final: string, params: string): Key | undefined {
  // 鼠标（SGR 扩展）优先：参数以 "<" 开头，终止符是 M（按下）或 m（抬起）
  if (final === "M" || final === "m") {
    const mouse = parseMouse(params, final);
    if (mouse !== undefined) return mouse;
  }

  switch (final) {
    case "A":
      return { type: "up" };
    case "B":
      return { type: "down" };
    case "C":
      return { type: "right" };
    case "D":
      return { type: "left" };
    case "H":
      return { type: "home" };
    case "F":
      return { type: "end" };
    case "~": {
      switch (Number.parseInt(params, 10)) {
        case 1:
          return { type: "home" };
        case 3:
          return { type: "delete" };
        case 4:
          return { type: "end" };
        case 5:
          return { type: "pageUp" };
        case 6:
          return { type: "pageDown" };
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

const SS3_MAP: Record<string, Key> = {
  A: { type: "up" },
  B: { type: "down" },
  C: { type: "right" },
  D: { type: "left" },
  H: { type: "home" },
  F: { type: "end" },
};

export class KeyDecoder {
  #pending = "";

  push(chunk: string): Key[] {
    this.#pending += chunk;
    const keys: Key[] = [];
    let i = 0;

    while (i < this.#pending.length) {
      const char = this.#pending[i]!;

      if (char === "\x1b") {
        const parsed = this.#parseEscape(i);
        if (parsed === undefined) break; // 不完整，等更多数据
        keys.push(...parsed.keys);
        i = parsed.next;
        continue;
      }

      const code = char.charCodeAt(0);

      if (code === 0x0d || code === 0x0a) {
        keys.push({ type: "enter" });
        i += 1;
        continue;
      }
      if (code === 0x7f || code === 0x08) {
        keys.push({ type: "backspace" });
        i += 1;
        continue;
      }
      if (code === 0x09) {
        keys.push({ type: "tab" });
        i += 1;
        continue;
      }
      if (code >= 0x01 && code <= 0x1a) {
        keys.push({ type: "ctrl", key: String.fromCharCode(code + 0x60) });
        i += 1;
        continue;
      }

      // 连续可打印字符聚成一个 text key（粘贴时更高效）
      let text = "";
      while (i < this.#pending.length) {
        const current = this.#pending[i]!;
        const currentCode = current.charCodeAt(0);
        if (current === "\x1b" || currentCode < 0x20 || currentCode === 0x7f) break;
        text += current;
        i += 1;
      }
      if (text.length > 0) keys.push({ type: "text", value: text });
      else i += 1; // 兜底，绝不空转
    }

    this.#pending = this.#pending.slice(i);
    return keys;
  }

  /** 超时后调用：把孤立的 ESC 兑现成 escape 键。 */
  flush(): Key[] {
    if (this.#pending === "\x1b") {
      this.#pending = "";
      return [{ type: "escape" }];
    }
    return [];
  }

  get pendingLength(): number {
    return this.#pending.length;
  }

  #parseEscape(index: number): { keys: Key[]; next: number } | undefined {
    const second = this.#pending[index + 1];

    if (second === undefined) return undefined; // 可能是裸 ESC，交给 flush

    if (second === "[") {
      let i = index + 2;
      let params = "";
      while (i < this.#pending.length) {
        const code = this.#pending.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) {
          const key = csiToKey(this.#pending[i]!, params);
          return { keys: key === undefined ? [] : [key], next: i + 1 };
        }
        params += this.#pending[i]!;
        i += 1;
      }
      return undefined; // CSI 未结束
    }

    if (second === "O") {
      const third = this.#pending[index + 2];
      if (third === undefined) return undefined;
      const key = SS3_MAP[third];
      return { keys: key === undefined ? [] : [key], next: index + 3 };
    }

    // 裸 ESC + 其它字符：ESC 本身作为一次按键
    return { keys: [{ type: "escape" }], next: index + 1 };
  }
}
