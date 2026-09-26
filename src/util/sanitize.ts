/**
 * 外部可控文本进终端前的转义清洗（BUG-027）。
 *
 * MCP server 的 stderr、JSON-RPC error、provider 的 HTTP 错误体都会被拼进
 * 错误文案并原样打到终端 / 写进 transcript —— 恶意端点可以用 ANSI/C1 转义
 * 清屏、移动光标、伪造提示行。这里做"进错误文案前"的保守清洗：
 * CSI / OSC 序列与游离的 ESC / C1 控制 / BEL 一律删除，换行与正文字符保留。
 */

const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
const STRAY_RE = /[\x1b\x9b\x07]/g;

export function stripAnsi(text: string): string {
  return text.replace(OSC_RE, "").replace(CSI_RE, "").replace(STRAY_RE, "");
}
