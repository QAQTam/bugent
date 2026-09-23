/**
 * 工具产物落盘。
 *
 * 为什么需要：bash 的输出可能几十万字符，全塞给模型既浪费上下文又没意义。
 * 做法是——**给模型看截断版，完整版写到文件并告诉它去哪读**。
 *
 * 存放位置刻意放在 `~/.bugent/output/<sessionId>/` 而不是工作目录：
 * 不污染用户的仓库。代价是 read_file 需要为这个目录开一个只读白名单
 * （见 src/tools/paths.ts 的 resolveReadable）。
 */

import { mkdir, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { configDir } from "../config/toml.ts";

export const OUTPUT_DIR_NAME = "output";

export type OutputStreamName = "stdout" | "stderr";
type FileSink = ReturnType<Bun.BunFile["writer"]>;

/**
 * bash 运行期间的两路输出暂存器。
 *
 * 不把完整输出先攒在 JS 字符串里：stdout/stderr 一有 chunk 就写 FileSink，
 * 内存侧仍只保留给模型看的截断版。只有最终确认确实超长时才把两个临时
 * 文件合并成对模型可见的 `.txt`；短命令则直接删掉临时文件。
 */
export interface OutputSpool {
  write(stream: OutputStreamName, chunk: Uint8Array): void;
  /** 合并为最终 `.txt` 并返回绝对路径。每个 spool 只能 promote 一次。 */
  promote(): Promise<SpilledOutput>;
  /** 放弃这次运行的输出，删除临时文件。 */
  discard(): Promise<void>;
}

export interface SpilledOutput {
  path: string;
  /** 原始 stdout + stderr 字节数，不含合并时添加的标记。 */
  bytes: number;
}

export function outputRoot(home?: string): string {
  return `${configDir(home)}/${OUTPUT_DIR_NAME}`;
}

export function sessionOutputDir(sessionId: string, home?: string): string {
  return `${outputRoot(home)}/${sessionId}`;
}

/** 完整输出落盘，返回绝对路径。 */
export async function spillOutput(
  sessionId: string,
  callId: string,
  text: string,
  home?: string,
): Promise<string> {
  const dir = sessionOutputDir(sessionId, home);
  await mkdir(dir, { recursive: true });
  const path = `${dir}/${callId}.txt`;
  await Bun.write(path, text);
  return path;
}

function tempOutputPath(dir: string, callId: string, stream: OutputStreamName): string {
  return `${dir}/.${callId}.${stream}.tmp`;
}

async function pipeFileToSink(path: string, sink: FileSink): Promise<void> {
  const reader = Bun.file(path).stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) sink.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function createOutputSpool(
  sessionId: string,
  callId: string,
  home?: string,
): Promise<OutputSpool> {
  const dir = sessionOutputDir(sessionId, home);
  await mkdir(dir, { recursive: true });

  const finalPath = `${dir}/${callId}.txt`;
  const tempPaths: Record<OutputStreamName, string> = {
    stdout: tempOutputPath(dir, callId, "stdout"),
    stderr: tempOutputPath(dir, callId, "stderr"),
  };
  const sinks: Partial<Record<OutputStreamName, FileSink>> = {};
  let closed = false;

  const closeSinks = async (): Promise<void> => {
    for (const stream of ["stdout", "stderr"] as const) {
      const sink = sinks[stream];
      if (sink !== undefined) await sink.end();
    }
  };

  return {
    write(stream, chunk): void {
      if (closed) throw new Error("output spool 已关闭");
      let sink = sinks[stream];
      if (sink === undefined) {
        sink = Bun.file(tempPaths[stream]).writer({ highWaterMark: 64 * 1024 });
        sinks[stream] = sink;
      }
      sink.write(chunk);
    },

    async promote(): Promise<SpilledOutput> {
      if (closed) throw new Error("output spool 已关闭");
      closed = true;
      await closeSinks();

      const stdoutSize = Bun.file(tempPaths.stdout).size;
      const stderrSize = Bun.file(tempPaths.stderr).size;
      const sink = Bun.file(finalPath).writer({ highWaterMark: 64 * 1024 });

      try {
        if (stdoutSize > 0) {
          sink.write("--- stdout ---\n");
          await pipeFileToSink(tempPaths.stdout, sink);
        }
        if (stderrSize > 0) {
          if (stdoutSize > 0) sink.write("\n");
          sink.write("--- stderr ---\n");
          await pipeFileToSink(tempPaths.stderr, sink);
        }
      } finally {
        await sink.end();
        await rm(tempPaths.stdout, { force: true });
        await rm(tempPaths.stderr, { force: true });
      }

      return { path: finalPath, bytes: stdoutSize + stderrSize };
    },

    async discard(): Promise<void> {
      if (closed) return;
      closed = true;
      await closeSinks();
      await rm(tempPaths.stdout, { force: true });
      await rm(tempPaths.stderr, { force: true });
    },
  };
}

/** 路径是否落在产物目录内（read_file 的只读白名单判定）。 */
export function isInsideOutputRoot(target: string, home?: string): boolean {
  const root = resolve(outputRoot(home));
  const resolved = resolve(target);
  return resolved === root || resolved.startsWith(root + sep);
}
