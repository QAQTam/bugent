/**
 * 沙箱档位 —— 权限模型的核心。
 *
 * **档位 = 默认批准范围，不是能力边界。**
 *
 *   read-only        不用问就能读；写工作区 / 写工作区外 / 联网 → 逐次批准
 *   workspace-write  不用问就能读 + 写工作区；写工作区外 / 联网 → 逐次批准
 *   no-sandbox       不用问就能做任何事（不拦截，但仍记录审计）
 *
 * 三档**都能读工作区之外** —— 读是自由的，档位不限制读。
 *
 * 为什么档位比"每个工具问一次"好：
 *   沙箱越严，越不需要问。read-only 档下内核保证了 bash 改不了任何东西，
 *   所以 bash 可以**自动放行**，不需要每次弹窗。反过来 no-sandbox 档
 *   是用户主动选的，也就等于主动授权了。
 *
 *   这样弹窗只在**越出默认批准范围**时出现，而不是每次都打断。
 *
 * 两条容易搞错的边界：
 *
 *   1. **越界走按次授权，不走"升档"。** 批准一次只生效一次 —— 批准一次写盘
 *      就把档位永久改成 workspace-write，会让"每次写入都要提交用户审批"
 *      这句话失去意义（实测过：第一次批准之后，后续写入全都不再问）。
 *
 *   2. **沙箱恒开，不随档位变化。** no-sandbox 的语义是"默认批准一切、
 *      不再拦截"，不是"关掉隔离"。它仍然带 pid 隔离、session 隔离、
 *      环境变量白名单与 no_new_privs。
 */

export type SandboxMode = "read-only" | "workspace-write" | "no-sandbox";

/**
 * 不用问就能做的范围。超出这个范围的操作一律走**按次授权**。
 */
export type DefaultApprove = "read" | "workspace-write" | "all";

export interface ModeCapabilities {
  /** 默认批准范围。 */
  defaultApprove: DefaultApprove;
  label: string;
}

/**
 * 档位**只描述默认批准范围**。
 *
 * 网络刻意不在这里 —— 它是**按次授权**的独立能力（见 CapabilityGrant）：
 * 把"联网"绑进档位会导致"为了联网不得不丢掉文件系统隔离"，
 * 那是没必要的放大。
 */
export const MODES: Record<SandboxMode, ModeCapabilities> = {
  "read-only": {
    defaultApprove: "read",
    label: "只读 · 写工作区/写工作区外/联网需逐次批准",
  },
  "workspace-write": {
    defaultApprove: "workspace-write",
    label: "可写工作区 · 写工作区外/联网需逐次批准",
  },
  "no-sandbox": {
    defaultApprove: "all",
    label: "默认批准一切 · 沙箱仍在，只是不拦截",
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
 * 一次调用需要什么越界能力（进程内工具用）。
 *
 * 注意**没有 network 的档位含义** —— 联网不走档位，走 CapabilityGrant 的按次授权。
 * 这里列出它只是为了让"需不需要问"这件事有一个统一的判定入口。
 */
export interface ModeRequirement {
  /** 需要写工作区。 */
  write?: boolean;
  /** 需要写工作区之外。只能由**逐次**判断得出（路径参数决定），不能静态声明。 */
  writeOutside?: boolean;
}

/**
 * 当前档位的默认批准范围是否覆盖该需求。
 *
 * `false` 的含义是"需要逐次批准"，**不是"不允许"**。
 */
export function defaultApproves(mode: SandboxMode, requirement: ModeRequirement): boolean {
  const approve = MODES[mode].defaultApprove;
  if (approve === "all") return true;
  if (requirement.writeOutside === true) return false;
  if (requirement.write === true) return approve === "workspace-write";
  return true;
}

/**
 * 想满足该需求，用户至少要切到哪一档。
 *
 * 只用于**提示文案**（"切到 X 档就不用每次问了"），不用于自动改档位。
 */
export function minimumModeFor(requirement: ModeRequirement): SandboxMode {
  if (requirement.writeOutside === true) return "no-sandbox";
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
  if (requirement.writeOutside === true) parts.push("写入工作区之外");
  return parts.join(" + ") || "该操作";
}

/* ------------------------------------------------------------------ */
/* 按次能力授权                                                         */
/* ------------------------------------------------------------------ */

/**
 * 一次性能力授权，**不改变档位**。
 *
 * 联网走这条路：命令先在断网沙箱里真跑一次，失败了再拿着**真实失败原因**
 * 去问用户。而不是先拦下来问一个没有上下文的"是否允许联网" ——
 * 那样用户（尤其是新手）根本不知道自己在批准什么。
 *
 * 写工作区外走同一条路：路径参数决定这次调用越不越界，所以只能逐次判、
 * 逐次问。
 */
export interface CapabilityGrant {
  /** 允许联网。 */
  network?: boolean;
  /** 允许本次调用写工作区之外。 */
  writeOutside?: boolean;
}

export function describeCapability(grant: CapabilityGrant): string {
  const parts: string[] = [];
  if (grant.network === true) parts.push("访问网络");
  if (grant.writeOutside === true) parts.push("写入工作区之外");
  return parts.join(" + ") || "该能力";
}
