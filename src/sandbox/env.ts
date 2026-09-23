/**
 * 沙箱环境变量过滤。
 *
 * 为什么必须做：子进程默认继承整个 `process.env`，也就是说
 * **`OPENAI_API_KEY` 对沙箱内的任意命令都是可读的** —— 一条
 * `curl $OPENAI_API_KEY` 就能把 key 带出去。文件系统隔离得再好，
 * 环境变量这条通道不堵等于白做。
 *
 * 为什么用**白名单**而不是黑名单：黑名单永远列不全 ——
 * `AWS_SECRET_ACCESS_KEY`、`GITHUB_TOKEN`、`NPM_TOKEN`、
 * `DATABASE_URL`、自定义的 `MY_SERVICE_PWD`…… 而且用户随时可能
 * 新增一个我们没见过的名字。白名单则相反：默认不给，要什么显式加。
 */

/** 沙箱内默认保留的环境变量。 */
const ALLOWLIST: readonly RegExp[] = [
  /^PATH$/, // 没有它什么都跑不起来
  /^HOME$/, // 很多工具会读；沙箱里它是只读的
  /^USER$/,
  /^LOGNAME$/,
  /^SHELL$/,
  /^PWD$/,
  /^OLDPWD$/,
  /^TERM$/, // 决定要不要输出颜色
  /^TZ$/,
  /^LANG$/, // locale 影响输出编码，不能省
  /^LC_.*$/,
  /^TMPDIR$/,
  /^HOSTNAME$/,
];

export interface SanitizeEnvOptions {
  /** 额外放行的变量名（精确匹配）。来自配置里的 `sandbox.pass_env`。 */
  allow?: readonly string[];
  /** 覆盖/追加的值（优先级最高）。 */
  extra?: Record<string, string | undefined>;
}

export interface SanitizedEnv {
  env: Record<string, string>;
  /** 被剔除的变量名，用于如实告知用户。 */
  stripped: string[];
}

/**
 * 过滤出沙箱可用的环境变量。
 *
 * 注意 `extra` 里的键**总是**放行 —— 那是调用方显式指定的。
 */
export function sanitizeEnv(
  source: Record<string, string | undefined>,
  options: SanitizeEnvOptions = {},
): SanitizedEnv {
  const explicit = new Set(options.allow ?? []);
  const extraKeys = new Set(Object.keys(options.extra ?? {}));
  const env: Record<string, string> = {};
  const stripped: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (extraKeys.has(key)) continue; // 交给下面的 extra 覆盖

    if (ALLOWLIST.some((pattern) => pattern.test(key)) || explicit.has(key)) {
      env[key] = value;
    } else {
      stripped.push(key);
    }
  }

  for (const [key, value] of Object.entries(options.extra ?? {})) {
    if (value !== undefined) env[key] = value;
  }

  return { env, stripped: stripped.sort() };
}
