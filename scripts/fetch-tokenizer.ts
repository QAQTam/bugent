/**
 * 下载 DeepSeek tokenizer.json —— TUI 的瞬时 tok/s 用它把字符数换成真 token 数。
 *
 * 为什么是"下载"而不是"内置进仓库"：tokenizer.json 有 7.8MB，而 bugent 的仓库
 * 不该为了一个状态栏读数背上这个体积。拿不到文件时状态栏会自动退回启发式估算
 * （并用服务端 usage 自校准），所以这个脚本是**可选加速项**。
 *
 * 用法：
 *   bun run tokenizer:fetch                  # 默认 ModelScope（国内可达）
 *   bun run tokenizer:fetch -- --source hf   # 走 HuggingFace
 *   bun run tokenizer:fetch -- --force       # 已存在也重新下
 *
 * 落盘位置：~/.bugent/tokenizers/deepseek-v3/tokenizer.json
 * （也可用环境变量 BUGENT_TOKENIZER 指到任意路径。）
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseDeepSeekTokenizer } from "../src/util/tokenizer.ts";

const SOURCES = {
  modelscope: "https://www.modelscope.cn/models/deepseek-ai/DeepSeek-V3/resolve/master/tokenizer.json",
  hf: "https://huggingface.co/deepseek-ai/DeepSeek-V3/resolve/main/tokenizer.json",
} as const;

type SourceName = keyof typeof SOURCES;

function parseArgs(argv: readonly string[]): { source: SourceName; out: string; force: boolean } {
  let source: SourceName = "modelscope";
  let out = join(homedir(), ".bugent", "tokenizers", "deepseek-v3", "tokenizer.json");
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") {
      const value = argv[i + 1];
      if (value !== "modelscope" && value !== "hf") {
        throw new Error(`--source 只能是 modelscope / hf，收到 ${String(value)}`);
      }
      source = value;
      i += 1;
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined || value.length === 0) throw new Error("--out 需要路径");
      out = value;
      i += 1;
    } else if (arg === "--force") {
      force = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { source, out, force };
}

const { source, out, force } = parseArgs(Bun.argv.slice(2));

if (!force && (await Bun.file(out).exists())) {
  console.log(`已存在，跳过下载：${out}`);
  console.log("要重新下载请加 --force");
  process.exit(0);
}

const url = SOURCES[source];
console.log(`下载 ${url}`);
const response = await fetch(url, { redirect: "follow" });
if (!response.ok) {
  throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}`);
}

const bytes = new Uint8Array(await response.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");

// 先验证再落盘：宁可不装，也不要装一个我们算不对的文件进去。
const parsed = parseDeepSeekTokenizer(JSON.parse(new TextDecoder().decode(bytes)) as unknown);

await mkdir(dirname(out), { recursive: true });
await Bun.write(out, bytes);

console.log(`已写入 ${out}`);
console.log(`  大小   ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MiB`);
console.log(`  sha256 ${digest}`);
console.log(`  词表   ${parsed.vocabSize} 条`);
console.log("TUI 下次启动即会用它计数；不设 BUGENT_TOKENIZER 时默认读这个路径。");
