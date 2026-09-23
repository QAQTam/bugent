/**
 * 沙箱档位 —— 权限模型的核心。
 *
 * 三档递进，**档位本身就是预先授权范围**：
 *
 *   read-only        根只读 + 工作区只读 + 断网
 *   workspace-write  根只读 + 工作区可写 + 断网
 *   no-sandbox       不隔离，可读写任意位置、可联网
 *
 * 为什么档位比"每个工具问一次"好：
 *   沙箱越严，越不需要问。read-only 档下内核保证了 bash 改不了任何东西，
 *   所以 bash 可以**自动放行**，不需要每次弹窗。反过来 no-sandbox 档
 *   是用户主动选的，也就等于主动授权了。
 *
 *   这样弹窗只在**越档**时出现（想写、想联网），而不是每次都打断。
 */

export type SandboxMode = "read-only" | "workspace-write" | "no-sandbox";

export interface ModeCapabilities {
  /** 工作区是否可写。同时约束 bash 沙箱与进程内的文件工具。 */
  workspaceWrite: boolean;
  /** 是否用 bwrap 隔离。 */
  sandboxed: boolean;
  /** 是否允许读工作区之外（目前只有 read_file 用得到）。 */
  readOutside: boolean;
  label: string;
}

/**
 * 三档**只描述文件系统与进程隔离**。
 *
 * 网络刻意不在这里 —— 它是**按次授权**的独立能力（见 CapabilityGrant）：
 * 把"联网"绑进档位会导致"为了联网不得不丢掉文件系统隔离"，
 * 那是没必要的放大。
 */
export const MODES: Record<SandboxMode, ModeCapabilities> = {
  "read-only": {
    workspaceWrite: false,
    sandboxed: true,
    readOutside: false,
    label: "只读 · 工作区不可写 · 断网",
  },
  "workspace-write": {
    workspaceWrite: true,
    sandboxed: true,
    readOutside: false,
    label: "可写工作区 · 根只读 · 断网",
  },
  "no-sandbox": {
    workspaceWrite: true,
    sandboxed: false,
    readOutside: true,
    label: "无沙箱 · 可读写任意位置 · 网络不受限",
  },
};

export const MODE_ORDER: readonly SandboxMode[] = ["read-only", "workspace-write", "no-sandbox"];

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && (MODE_ORDER as readonly string[]).includes(value);
}

export function capabilitiesOf(mode: SandboxMode): ModeCapabilities {
  return MODES[mode];
}

/**
 * 需要档位提供的能力（进程内工具用）。
 *
 * 注意**没有 network** —— 联网不走档位，走 CapabilityGrant 的按次授权。
 */
export interface ModeRequirement {
  /** 需要写工作区。 */
  write?: boolean;
}

/** 当前档位是否已覆盖该需求。 */
export function modeSatisfies(mode: SandboxMode, requirement: ModeRequirement): boolean {
  const caps = MODES[mode];
  if (requirement.write === true && !caps.workspaceWrite) return false;
  return true;
}

/** 满足需求的最低档位（用于提示用户"需要升到哪一档"）。 */
export function minimumModeFor(requirement: ModeRequirement): SandboxMode {
  return requirement.write === true ? "workspace-write" : "read-only";
}

/** 在档位序列里向前推进 n 档。 */
export function escalate(mode: SandboxMode, steps = 1): SandboxMode {
  const index = MODE_ORDER.indexOf(mode);
  const next = Math.min(MODE_ORDER.length - 1, index + steps);
  return MODE_ORDER[next]!;
}

export function describeRequirement(requirement: ModeRequirement): string {
  const parts: string[] = [];
  if (requirement.write === true) parts.push("写入工作区");
  return parts.join(" + ") || "该操作";
}

/* ------------------------------------------------------------------ */
/* 按次能力授权（网络）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 一次性能力授权，**不改变档位**。
 *
 * 联网走这条路：命令先在断网沙箱里真跑一次，失败了再拿着**真实失败原因**
 * 去问用户。而不是先拦下来问一个没有上下文的"是否允许联网" ——
 * 那样用户（尤其是新手）根本不知道自己在批准什么。
 */
export interface CapabilityGrant {
  /** 允许联网。 */
  network?: boolean;
}

export function describeCapability(grant: CapabilityGrant): string {
  const parts: string[] = [];
  if (grant.network === true) parts.push("访问网络");
  return parts.join(" + ") || "该能力";
}

