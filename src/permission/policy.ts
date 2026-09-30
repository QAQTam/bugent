/**
 * 权限策略 —— 规则层。
 *
 * 在**档位模型**里，规则是"覆盖层"，不是主判定：
 *
 *   1. 构造期显式 **deny** 命中 → 硬性禁令（运行期授权不得越过）
 *   2. 运行期规则（"总是允许"）命中 → 用它的决策
 *   3. 构造期其余规则命中（按顺序，第一条生效）→ 用规则的决策
 *   4. 都没命中 → 交给**档位**判断（见 mode.ts）
 *
 * 也就是说规则主要用来做两件事：
 *   - 加硬性禁令：`{tool:"bash", resource:"rm -rf /*", decision:"deny"}`
 *   - 对特定操作强制询问：`{tool:"bash", resource:"git push*", decision:"ask"}`
 *
 * 默认**不预置任何 allow 规则** —— 放行由档位负责，不需要在这里列白名单。
 *
 * ⚠️ bash 规则按**原始命令文本**匹配（resource = 整条命令串）。这是有意的
 * 取舍：挡不住 `env rm -rf /`、`sudo rm -rf /`、`bash -c "…"`、`${IFS}`、
 * 引号/换行/大小写变体 —— 规则匹配字面量，不解析命令语义。要把 bash 限制住，
 * 靠的是档位（read-only 档内核挡写）与按次授权；deny 适合挡"这条具体命令"。
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
 * 编译带 `s`（dotAll）标志：命令文本是多行的（`git push\n--force origin main`
 * 与 `git push --force origin main` 是同一条命令的两种书写），规则匹配必须
 * 与实际形态对齐，否则硬性禁令连换行变体都拦不住。
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
    source += escapeGlobChar(char);
  }
  return new RegExp(`${source}$`, "s");
}

function escapeGlobChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 字面量 -> RegExp（**不**解释 glob）。
 *
 * 运行时"总是允许"的对象是用户刚看到的那条具体命令；命令文本里自带的
 * `*`/`?`（如 `chmod 644 *.log`）是字面量，按 glob 编译会把授权范围放大到
 * 用户没见过的命令上。
 */
function literalToRegExp(text: string): RegExp {
  let source = "^";
  for (const char of text) source += escapeGlobChar(char);
  return new RegExp(`${source}$`, "s");
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
  /** 构造期规则（用户配置 + 工具自报），顺序即优先级。 */
  #rules: CompiledRule[];
  /** 运行期规则（"总是允许"等），独立成层 —— 见 evaluate 的判定顺序。 */
  #runtimeRules: CompiledRule[];

  constructor(options: PermissionPolicyOptions) {
    this.#default = options.default ?? "allow";
    this.#rules = [];
    this.#runtimeRules = [];
    for (const rule of options.rules ?? []) {
      this.#rules.push({
        tool: globToRegExp(rule.tool),
        resource: rule.resource === undefined ? undefined : globToRegExp(rule.resource),
        decision: rule.decision,
      });
      // `bash` → `exec` 改名的兼容别名：老配置里的 { tool: "bash" } 规则
      // 必须继续管住改名后的 exec 工具（deny/ask 规则漏配等于放行）。
      if (rule.tool === "bash") {
        this.#rules.push({
          tool: globToRegExp("exec"),
          resource: rule.resource === undefined ? undefined : globToRegExp(rule.resource),
          decision: rule.decision,
        });
      }
    }
  }

  #firstMatch(rules: readonly CompiledRule[], request: PermissionRequest): PolicyEvaluation | undefined {
    for (const rule of rules) {
      if (!rule.tool.test(request.tool)) continue;
      if (rule.resource !== undefined && !rule.resource.test(request.resource)) continue;
      return { decision: rule.decision, matched: true };
    }
    return undefined;
  }

  /**
   * 判定顺序（优先级从高到低）：
   *   1. 构造期显式 **deny** —— 用户的硬性禁令，运行期"总是允许"不得越过；
   *   2. 运行期规则 —— 用户在弹窗里点的"总是允许"必须能压过构造期的 ask
   *      规则与工具自报默认，否则永远轮不到；
   *   3. 构造期其余规则（按声明顺序，第一条命中生效）；
   *   4. 兜底 default。
   */
  evaluate(request: PermissionRequest): PolicyEvaluation {
    const fromStatic = this.#firstMatch(this.#rules, request);
    if (fromStatic !== undefined && fromStatic.decision === "deny") {
      return { decision: "deny", matched: true };
    }
    const fromRuntime = this.#firstMatch(this.#runtimeRules, request);
    if (fromRuntime !== undefined) return fromRuntime;
    if (fromStatic !== undefined) return fromStatic;
    return { decision: this.#default, matched: false };
  }

  get defaultDecision(): PermissionDecision {
    return this.#default;
  }

  /** 运行时追加规则（ui-protocol-spec §6.1 "总是允许"）。
   *  只活在当前进程内，不写盘、不跨 session。**不进构造期规则表**：
   *  运行期授权压得过 ask/兜底，压不过用户显式写的 deny（见 evaluate）。
   *  tool 与 resource 都按**字面量**匹配 —— 用户批准的是眼前那条具体命令，
   *  文本里的 `*`/`?` 不能被当成通配符放大授权范围。`bash` → `exec`
   *  别名规则同样复刻。 */
  addRule(rule: PermissionRule): void {
    const compiled = {
      tool: literalToRegExp(rule.tool),
      resource: rule.resource === undefined ? undefined : literalToRegExp(rule.resource),
      decision: rule.decision,
    };
    this.#runtimeRules.unshift(compiled);
    if (rule.tool === "bash") {
      this.#runtimeRules.splice(1, 0, {
        tool: literalToRegExp("exec"),
        resource: compiled.resource,
        decision: rule.decision,
      });
    }
  }

  get ruleCount(): number {
    return this.#rules.length + this.#runtimeRules.length;
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
