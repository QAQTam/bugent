/**
 * bash 写工作区的 undo 记账 —— 原 P0「沙箱内写盘的可观测性」。
 *
 * write_file / edit_file / apply_patch 都自报 before/after，唯独 bash 的写入
 * 对 /undo 完全不可见：undo 的 all-or-nothing 语义对 bash 改过的文件要么静默
 * 漏掉、要么（与文件工具记录冲突时）整体拒绝，且用户无从知道原因。
 *
 * 方案：command-scan 已经为授权链提取了 `writeTargets`（展开后的绝对路径），
 * 这里对其中落在工作区内的普通文件目标做「执行前快照 → 执行后按字节 hash
 * 比对 → 产出 WorkspaceFileEdit」，走与文件工具完全相同的
 * `ctx.onWorkspaceChange` 链路（registry 收集 → session flush →
 * WorkspaceFileChange → /undo），不发明新机制。
 *
 * 已知限制（与扫描器"宁可漏判不误判"的哲学一致）：
 *   - 解释器写意图（`python -c "open(...,'w')"`，writeIntent 无具体目标）无法记账；
 *   - 目录 / 符号链接 / fifo 目标跳过（undo 本来也只追踪文件）；
 *   - 非 UTF-8 或超过快照上限的文件记为**不可逆**：/undo 会如实整体拒绝并给出
 *     原因，而不是静默漏掉。
 */

import { lstatSync, readFileSync } from "node:fs";
import type { CommandScan } from "../sandbox/command-scan.ts";
import { insideWorkspace } from "../sandbox/command-scan.ts";
import type { WorkspaceFileEdit } from "../core/workspace.ts";

/** 单次记账的目标数上限：扫描器可能吐出很长的目标列表，快照必须有界。 */
const MAX_TARGETS = 32;
/** 单文件内容快照上限；超过的文件只记"动过"，回滚交给用户。 */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export interface WorkspaceWriteSnapshotEntry {
  readonly path: string;
  /** 执行前是否存在（此处必为普通文件 —— 非普通文件不进快照）。 */
  readonly existed: boolean;
  /** utf8 内容（ignoreBOM 保真）；undefined = 过大或非 UTF-8。 */
  readonly content: string | undefined;
  /** 执行前字节 hash（utf8 往返不参与比较）。 */
  readonly beforeHash: string;
  readonly reversible: boolean;
  readonly irreversibleReason?: string;
}

export interface WorkspaceWriteSnapshot {
  readonly entries: readonly WorkspaceWriteSnapshotEntry[];
}

function hashBuffer(data: Buffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex").slice(0, 16);
}

/** 带 BOM 保真的严格 utf8 解码；非法序列返回 undefined（调用方记不可逆）。 */
function decodeStrict(data: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return undefined;
  }
}

function snapshotExistingFile(path: string, size: number): WorkspaceWriteSnapshotEntry {
  if (size > MAX_SNAPSHOT_BYTES) {
    return {
      path,
      existed: true,
      content: undefined,
      beforeHash: "",
      reversible: false,
      irreversibleReason: "文件超过快照上限（8MB），无法生成回滚脚本",
    };
  }
  const data = readFileSync(path);
  const content = decodeStrict(data);
  return {
    path,
    existed: true,
    content,
    beforeHash: hashBuffer(data),
    reversible: content !== undefined,
    ...(content === undefined ? { irreversibleReason: "非 UTF-8 文件" } : {}),
  };
}

/** 执行前调用：对 scan.writeTargets 里的工作区内普通文件目标做快照。 */
export function snapshotWorkspaceWrites(scan: CommandScan, workspace: string): WorkspaceWriteSnapshot {
  const entries: WorkspaceWriteSnapshotEntry[] = [];
  for (const target of scan.writeTargets) {
    if (entries.length >= MAX_TARGETS) break;
    if (!insideWorkspace(workspace, target)) continue;
    const stat = lstatSync(target, { throwIfNoEntry: false });
    // 目录 / 符号链接 / fifo 不记账：undo 只追踪文件，且符号链接可能指向
    // 工作区外，快照它反而会造成"可回滚"的错觉。
    if (stat !== undefined && !stat.isFile()) continue;
    entries.push(
      stat === undefined
        ? { path: target, existed: false, content: undefined, beforeHash: "", reversible: true }
        : snapshotExistingFile(target, stat.size),
    );
  }
  return { entries };
}

/** 执行后调用：与快照比对，产出交给 `ctx.onWorkspaceChange` 的编辑列表。 */
export function workspaceEditsFromSnapshot(
  snapshot: WorkspaceWriteSnapshot,
): WorkspaceFileEdit[] {
  const edits: WorkspaceFileEdit[] = [];
  for (const entry of snapshot.entries) {
    const stat = lstatSync(entry.path, { throwIfNoEntry: false });
    const afterData = stat !== undefined && stat.isFile() ? readFileSync(entry.path) : undefined;

    if (!entry.existed) {
      if (afterData === undefined) continue; // 没创建（或创建的只是目录）
      if (hashBuffer(afterData) === entry.beforeHash) continue;
      const oversize = afterData.length > MAX_SNAPSHOT_BYTES;
      const after = oversize ? undefined : decodeStrict(afterData);
      edits.push({
        path: entry.path,
        before: "",
        after: after ?? "",
        beforeExists: false,
        afterExists: true,
        reversible: after !== undefined,
        ...(after === undefined
          ? {
              irreversibleReason:
                oversize ? "文件超过快照上限（8MB），无法生成回滚脚本" : "非 UTF-8 文件",
            }
          : {}),
      });
      continue;
    }

    if (afterData === undefined) {
      // 被删除，或被替换成目录/链接：按"删除"记账，撤销恢复文件内容。
      edits.push({
        path: entry.path,
        before: entry.content ?? "",
        after: "",
        beforeExists: true,
        afterExists: false,
        reversible: entry.reversible,
        ...(entry.irreversibleReason !== undefined
          ? { irreversibleReason: entry.irreversibleReason }
          : {}),
      });
      continue;
    }

    // 按字节比较：utf8 往返可能不保真，不能拿解码后的字符串判等。
    if (hashBuffer(afterData) === entry.beforeHash) continue;
    const oversize = afterData.length > MAX_SNAPSHOT_BYTES;
    const after = oversize ? undefined : decodeStrict(afterData);
    const reversible = entry.reversible && after !== undefined;
    const irreversibleReason =
      !entry.reversible
        ? entry.irreversibleReason
        : after === undefined
          ? oversize
            ? "文件超过快照上限（8MB），无法生成回滚脚本"
            : "非 UTF-8 文件"
          : undefined;
    edits.push({
      path: entry.path,
      before: entry.content ?? "",
      after: after ?? "",
      beforeExists: true,
      afterExists: true,
      reversible,
      ...(irreversibleReason !== undefined ? { irreversibleReason } : {}),
    });
  }
  return edits;
}
