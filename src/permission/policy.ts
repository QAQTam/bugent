/**
 * 权限策略 —— Phase 6。
 *
 * 三级决策：
 *   allow  直接执行
 *   ask    交给用户确认（TUI 弹窗 / CLI 询问）
 *   deny   直接拒绝，并把这个理由回给模型
 *
 * 规则**按顺序**匹配，第一条命中即生效；都不命中则用 default。
 * 默认 default 是 `ask` —— 宁可多问一句，也不要默认放行。
 */

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
}

export interface PermissionPolicyOptions {
  /** 未命中任何规则时的决策，默认 "ask"。 */
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

export class PermissionPolicy {
  #default: PermissionDecision;
  #rules: CompiledRule[];

  constructor(options: PermissionPolicyOptions) {
    this.#default = options.default ?? "ask";
    this.#rules = (options.rules ?? []).map((rule) => ({
      tool: globToRegExp(rule.tool),
      resource: rule.resource === undefined ? undefined : globToRegExp(rule.resource),
      decision: rule.decision,
    }));
  }

  evaluate(request: PermissionRequest): PermissionDecision {
    for (const rule of this.#rules) {
      if (!rule.tool.test(request.tool)) continue;
      if (rule.resource !== undefined && !rule.resource.test(request.resource)) continue;
      return rule.decision;
    }
    return this.#default;
  }

  get defaultDecision(): PermissionDecision {
    return this.#default;
  }

  get ruleCount(): number {
    return this.#rules.length;
  }
}

/** 什么都不放行，全部询问。 */
export const DEFAULT_POLICY: PermissionPolicyOptions = { default: "ask" };

/** 全部放行（对应 `--yes`）。 */
export const ALLOW_ALL_POLICY: PermissionPolicyOptions = { default: "allow" };

/** 全部拒绝。 */
export const DENY_ALL_POLICY: PermissionPolicyOptions = { default: "deny" };

/** 用户拒绝时回给模型的文本。 */
export function denialMessage(request: PermissionRequest, reason?: string): string {
  const head = reason ?? "用户拒绝执行";
  return `${head}：${request.summary}`;
}
