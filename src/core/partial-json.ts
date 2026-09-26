/**
 * 流式 JSON 参数的局部解码。
 *
 * 工具参数是一个字一个字吐出来的，任何时刻它都可能是半截 JSON —— `JSON.parse`
 * 必然失败。但**已经收尾的字符串字段是可信的**：路径、命令、正在写入的内容都能
 * 在流式阶段就拿到，不必等整个参数到齐。
 *
 * 这个模块只做这一件事，纯函数 + 纯状态，不碰终端、不碰文件系统。
 *
 * 两个层次：
 *   - `jsonStringField(source, field)`：取一次，值可能还没收尾；
 *   - `StringFieldStream`：增量版，每次只解码**新增的那一段**。
 *
 * 为什么必须有增量版：一次性版每次都要从字段起点重解到当前末尾，而调用方每个
 * delta 都会调一次 —— 总代价是 O(长度²/chunk)。写一个 1MB 的文件，最后一个
 * delta 就要重解 1MB，累积起来是分钟级 CPU。增量版记住"解到哪儿了"，总代价
 * O(长度)。
 */

export interface JsonStringPrefix {
  /** 已经解出来的文本（不含未收尾的转义序列）。 */
  text: string;
  /** 字符串字面量是否已经收尾（遇到结束引号）。 */
  complete: boolean;
  /**
   * 从 `start` 起已经**完整解掉**的源字符数。
   *
   * 末尾那半个转义序列（`\` 或 `\u12`）不算在内 —— 增量解码要靠它决定下次
   * 从哪儿接着解，算进去就会把半个转义当成字符吃掉。
   */
  consumed: number;
}

/** 解码从 `start` 开始的 JSON 字符串字面量，遇到结束引号或源耗尽为止。 */
export function decodeJsonStringPrefix(source: string, start: number): JsonStringPrefix {
  let text = "";
  let consumed = start;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '"') return { text, complete: true, consumed: index + 1 };
    if (char !== "\\") {
      text += char;
      consumed = index + 1;
      continue;
    }

    index += 1;
    if (index >= source.length) break; // 反斜杠在末尾：整个转义都还没到齐
    const escaped = source[index]!;
    switch (escaped) {
      case '"':
      case "\\":
      case "/":
        text += escaped;
        break;
      case "b":
        text += "\b";
        break;
      case "f":
        text += "\f";
        break;
      case "n":
        text += "\n";
        break;
      case "r":
        text += "\r";
        break;
      case "t":
        text += "\t";
        break;
      case "u": {
        const hex = source.slice(index + 1, index + 5);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
          // 半个 \uXXXX：不消费，等下一批
          return { text, complete: false, consumed };
        }
        text += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        text += escaped;
        break;
    }
    consumed = index + 1;
  }
  return { text, complete: false, consumed };
}

/**
 * 找**顶层**键 `"field"` 的字符串值起点（开引号之后的位置）。
 *
 * 为什么不能直接正则找 `"field"\s*:\s*"`：键名也可能出现在别的字段的字符串值
 * 里（`content` 里写一段 JSON 就是），正则分不出那是值还是键。这里做一次真正的
 * 浅扫描：只在字符串字面量**之外**认键，并且要求键后面紧跟 `:`。
 *
 * 遇到半截字符串就停下（返回 undefined）—— 那一刻还没法判断它是键还是值，而
 * 排在它后面的字段本来就还没到。这正好是流式阶段要的语义：字段按顺序可见。
 */
export function topLevelValueStart(source: string, field: string): number | undefined {
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char !== '"') {
      index += 1;
      continue;
    }

    const scan = decodeJsonStringPrefix(source, index + 1);
    if (!scan.complete) return undefined;
    const end = scan.consumed;
    if (scan.text === field) {
      const rest = /^\s*:\s*"/.exec(source.slice(end));
      if (rest !== null) return end + rest[0].length;
    }
    index = end;
  }
  return undefined;
}

/**
 * 取一次某个字符串字段（值可能还没收尾，给到已经到达的部分）。
 *
 * 认的是**顶层键**（见 `topLevelValueStart`），不是"第一个键" —— `content`、
 * `old_string` 这些排在后面的字段一样能拿到。
 */
export function jsonStringField(rawArgs: string, field: string): string | undefined {
  const start = topLevelValueStart(rawArgs, field);
  if (start === undefined) return undefined;
  const decoded = decodeJsonStringPrefix(rawArgs, start);
  return decoded.text.length > 0 ? decoded.text : undefined;
}

/**
 * 一个字符串字段的增量解码器。
 *
 * `push` 接收的是**累积**的原始参数（和 provider 给的一样，只增不改），内部只解
 * 上次之后新增的那一段；找键的浅扫描也只在第一次成功时做一次。
 */
export class StringFieldStream {
  readonly #field: string;
  #start: number | undefined;
  #consumed = 0;
  #text = "";
  #complete = false;

  constructor(field: string) {
    this.#field = field;
  }

  /** 当前已解码的文本。 */
  get text(): string {
    return this.#text;
  }

  get complete(): boolean {
    return this.#complete;
  }

  push(rawArgs: string): string {
    if (this.#complete) return this.#text;
    if (this.#start === undefined) {
      const start = topLevelValueStart(rawArgs, this.#field);
      if (start === undefined) return this.#text;
      this.#start = start;
    }

    const scan = decodeJsonStringPrefix(rawArgs, this.#start + this.#consumed);
    this.#text += scan.text;
    this.#consumed = scan.consumed - this.#start;
    this.#complete = scan.complete;
    return this.#text;
  }
}
