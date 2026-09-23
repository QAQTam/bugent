/**
 * 权限策略 —— 规则层。
 *
 * 在**档位模型**里，规则是"覆盖层"，不是主判定：
 *
 *   1. 显式规则命中（按顺序，第一条生效）→ 用规则的决策
 *   2. 没命中 → 交给**档位**判断（见 mode.ts）
 *
 * 也就是说规则主要用来做两件事：
 *   - 加硬性禁令：`{tool:"bash", resource:"rm -rf /*", decision:"deny"}`
 *   - 对特定操作强制询问：`{tool:"bash", resource:"git push*", decision:"ask"}`
 *
 * 默认**不预置任何 allow 规则** —— 放行由档位负责，不需要在这里列白名单。
 */

import type { ModeRequirement } from "./mode.ts";

export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionRule {
  /** 工具名，`*` 表示任意工具。 */
  tool: string;
  /**
   * 资源匹配（glob）。语义因工具而异：
   *   bash        -> 整条命令
   *   read_file   -> 文件路径
   * 省略表示匹配该工具的任意调用。
   */
  resource?: string;
  decision: PermissionDecision;
}

export interface PermissionRequest {
  tool: string;
  resource: string;
  /** 给用户看的一句话描述。 */
  summary: string;
  /**
   * 这件事需要档位提供什么能力（写工作区 / 联网）。
   *
   * 只有**进程内**工具需要声明：走沙箱的工具（bash）由内核兜底，
   * 不需要额外声明 —— read-only 档下它想写也写不动。
   */
  requires?: ModeRequirement;
}

export interface PermissionPolicyOptions {
  /**
   * 规则都不命中时的兜底决策。
   *
   * 默认 **"allow"** —— 放行与否交给**档位**判断（档位已经声明了边界）。
   * 想回到"每次都问"就显式设成 "ask"。
   */
  default?: PermissionDecision;
  rules?: readonly PermissionRule[];
}

/**
 * 极简 glob -> RegExp。
 *   `*` 匹配任意字符（含 `/`），`?` 匹配单个字符，其余按字面量。
 *
 * 注意：`*` 是"贪婪任意"，所以 `{tool:"bash", resource:"ls*", decision:"allow"}`
 * 会连 `ls; rm -rf /` 一起放行。给 bash 配 allow 规则要非常小心，
 * 默认策略里因此**不预置任何 bash 白名单**。
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      source += ".*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

interface CompiledRule {
  tool: RegExp;
  resource: RegExp | undefined;
  decision: PermissionDecision;
}

export interface PolicyEvaluation {
  decision: PermissionDecision;
  /** 是否有规则真的命中了（用于区分"规则说的"和"兜底的"）。 */
  matched: boolean;
}

export class PermissionPolicy {
  #default: PermissionDecision;
  #rules: CompiledRule[];

  constructor(options: PermissionPolicyOptions) {
    this.#default = options.default ?? "allow";
    this.#rules = (options.rules ?? []).map((rule) => ({
      tool: globToRegExp(rule.tool),
      resource: rule.resource === undefined ? undefined : globToRegExp(rule.resource),
      decision: rule.decision,
    }));
  }

  evaluate(request: PermissionRequest): PolicyEvaluation {
    for (const rule of this.#rules) {
      if (!rule.tool.test(request.tool)) continue;
      if (rule.resource !== undefined && !rule.resource.test(request.resource)) continue;
      return { decision: rule.decision, matched: true };
    }
    return { decision: this.#default, matched: false };
  }

  get defaultDecision(): PermissionDecision {
    return this.#default;
  }

  get ruleCount(): number {
    return this.#rules.length;
  }
}

/**
 * 默认策略：**不预置任何规则**。
 *
 * 放行交给**档位**判断 —— read-only 档下内核保证 bash 改不动东西，
 * 没必要在这里列白名单；workspace-write 档下工作区就是声明的边界。
 *
 * 规则留给用户做两类事：硬性禁令（`rm -rf /*`）、对特定操作强制询问（`git push*`）。
 */
export const DEFAULT_POLICY: PermissionPolicyOptions = {};

/** 全部放行。 */
export const ALLOW_ALL_POLICY: PermissionPolicyOptions = { default: "allow" };

/** 全部拒绝。 */
export const DENY_ALL_POLICY: PermissionPolicyOptions = { default: "deny" };

/**
 * 组装最终策略：**用户显式规则优先，工具自报的默认规则兜底**。
 *
 * 顺序即优先级 —— 策略按顺序匹配，第一条命中生效。
 * 所以用户配了 `{tool:"todo_write", decision:"deny"}` 就能推翻工具自报的 allow。
 */
export function composePolicy(
  user: PermissionPolicyOptions | undefined,
  toolDefaults: readonly PermissionRule[] = [],
): PermissionPolicyOptions {
  return {
    // 不设 default 时由 PermissionPolicy 自己兜底为 "allow"（交给档位判断）。
    // 这里刻意不写死 "ask" —— 那会把"档位即授权"整个推翻。
    ...(user?.default !== undefined ? { default: user.default } : {}),
    rules: [...(user?.rules ?? []), ...toolDefaults],
  };
}

/** 用户拒绝时回给模型的文本。 */
export function denialMessage(request: PermissionRequest, reason?: string): string {
  const head = reason ?? "用户拒绝执行";
  return `${head}：${request.summary}`;
}
