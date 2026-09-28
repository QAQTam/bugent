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

/** 沙箱内默认保留的环境变量（跨平台）。 */
const BASE_ALLOWLIST: readonly RegExp[] = [
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

/**
 * Windows 上额外保留的环境变量。
 *
 * 为什么不能只留 PATH：Windows 补全命令名靠的是**按 PATHEXT 列出的扩展名**去
 * 试，而不是"从 PATH 里找一个同名文件"。PATHEXT 不在子进程环境里时，
 * PowerShell 会把它退化成一个只有 `.CPL` 的兜底值，于是 `git` / `node` /
 * `bun` 这类不带扩展名的命令名**全部**解析失败 —— 连写全路径的
 * `C:\Windows\System32\reg.exe` 都会被当成"文档"拒绝执行。报错看着像沙箱把
 * 命令拦了，其实是环境变量被过滤掉了。
 *
 * 其余几个是 Windows 自己的地基：缺 SystemRoot/ComSpec 的程序行为会飘，
 * 缺 TEMP/TMP 的工具找不到临时目录，缺 PSModulePath 的 pwsh 加载不了模块。
 * 这些全是**系统路径**、不含凭据，放行不破坏"默认不给"的初衷。
 */
const WINDOWS_ALLOWLIST: readonly RegExp[] = [
  /^PATHEXT$/,
  /^COMSPEC$/,
  /^SYSTEMROOT$/,
  /^WINDIR$/,
  /^SYSTEMDRIVE$/,
  /^USERPROFILE$/,
  /^APPDATA$/,
  /^LOCALAPPDATA$/,
  /^PROGRAMDATA$/,
  /^PROGRAMFILES$/,
  /^PROGRAMFILES\(X86\)$/,
  /^TEMP$/,
  /^TMP$/,
  /^PSMODULEPATH$/,
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
 *
 * `platform` 可注入，便于在 Linux 上单测 Windows 那一支的行为。
 */
export function sanitizeEnv(
  source: Record<string, string | undefined>,
  options: SanitizeEnvOptions = {},
  platform: NodeJS.Platform = process.platform,
): SanitizedEnv {
  const windows = platform === "win32";
  const allowlist = windows ? [...BASE_ALLOWLIST, ...WINDOWS_ALLOWLIST] : BASE_ALLOWLIST;
  // Windows 的环境变量名大小写不敏感（`Path` 与 `PATH` 是同一个东西），
  // 白名单和 `pass_env` 都得按这个语义比对。
  const normalize = (name: string): string => (windows ? name.toUpperCase() : name);
  const explicit = new Set((options.allow ?? []).map(normalize));
  const extraKeys = new Set(Object.keys(options.extra ?? {}).map(normalize));
  const env: Record<string, string> = {};
  const stripped: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = normalize(key);
    if (extraKeys.has(name)) continue; // 交给下面的 extra 覆盖

    if (allowlist.some((pattern) => pattern.test(name)) || explicit.has(name)) {
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
