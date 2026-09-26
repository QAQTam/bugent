/**
 * 命令越界扫描 —— 沙箱体系的**执行前**判定。
 *
 * 为什么需要：bash 的输入是一条不透明命令串，`git status` 和 `python x.py`
 * 从字符串上看不出区别。此前的做法是"让内核挡"—— 于是 `> /home/me/x`
 * 只会得到一句 `Read-only file system`，用户**连申请授权的机会都没有**。
 * 本模块把"能不能静态判出来"这件事单独抽出来，供 bash 在**跑之前**决定
 * 要不要按次问用户。
 *
 * 三条原则：
 *   1. **纯函数。** 不碰进程、不碰 fs（`exists` 可注入），便于单测。
 *   2. **保守。** 判不出来就说判不出来（`writeIntent`），绝不默认"安全"。
 *   3. **不承担安全责任。** 漏判不等于放行 —— 内核仍然挡着（`EROFS`）。
 *      扫描只负责"少让用户白挨一次失败"，正确性由沙箱保证。
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface CommandScan {
  /** 能静态解析出的写目标（绝对路径，已去重）。 */
  writeTargets: readonly string[];
  /** 其中落在工作区之外、需要按次授权的那部分。 */
  outsidePaths: readonly string[];
  /** 识别出联网迹象（curl / git push / npm install …）。 */
  network: boolean;
  /** 有写迹象但目标解析不出来（解释器 + `open(...,'w')` 之类）。 */
  writeIntent: boolean;
  /** 三项全空 = 不必打扰用户。 */
  clean: boolean;
}

export interface ScanOptions {
  cwd: string;
  /** `~` 展开用。默认取当前用户 home。 */
  home?: string;
}

/* ------------------------------------------------------------------ */
/* 词法：把命令行切成"词"和"操作符"                                      */
/* ------------------------------------------------------------------ */

interface Lexeme {
  kind: "word" | "op";
  text: string;
  /** 词首是否是引号：注释识别用 —— bash 只把"未引用的词首 #"当注释。 */
  startedWithQuote?: boolean;
}

const TWO_CHAR_OPS = new Set([">>", "&&", "||", ">&", "&>", "<<", "|&"]);
const ONE_CHAR_OPS = new Set([";", "|", "&", "(", ")", ">", "<", "\n"]);

/** 引号与转义都要处理：`echo "a > b"` 里的 `>` 不是重定向。 */
function lex(command: string): Lexeme[] {
  const out: Lexeme[] = [];
  let word = "";
  let startedWithQuote = false;
  let index = 0;
  const flush = (): void => {
    if (word.length > 0) {
      out.push({
        kind: "word",
        text: word,
        ...(startedWithQuote ? { startedWithQuote: true } : {}),
      });
      word = "";
      startedWithQuote = false;
    }
  };

  while (index < command.length) {
    const char = command[index]!;

    if (char === "'") {
      if (word.length === 0) startedWithQuote = true;
      const end = command.indexOf("'", index + 1);
      const stop = end === -1 ? command.length : end;
      word += command.slice(index + 1, stop);
      index = stop + 1;
      continue;
    }
    if (char === '"') {
      if (word.length === 0) startedWithQuote = true;
      index += 1;
      while (index < command.length && command[index] !== '"') {
        if (command[index] === "\\" && index + 1 < command.length) {
          word += command[index + 1];
          index += 2;
          continue;
        }
        word += command[index];
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === "\\") {
      if (index + 1 < command.length) word += command[index + 1];
      index += 2;
      continue;
    }
    if (char === " " || char === "\t") {
      flush();
      index += 1;
      continue;
    }

    const two = command.slice(index, index + 2);
    if (TWO_CHAR_OPS.has(two)) {
      flush();
      out.push({ kind: "op", text: two });
      index += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(char)) {
      flush();
      out.push({ kind: "op", text: char });
      index += 1;
      continue;
    }

    word += char;
    index += 1;
  }

  flush();
  return out;
}

/* ------------------------------------------------------------------ */
/* 语法：按分隔符切成简单命令                                            */
/* ------------------------------------------------------------------ */

interface SimpleCommand {
  words: readonly string[];
  /** 重定向的目标（`> a b` 里的 `a`、`b`）。 */
  redirects: readonly string[];
}

const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&", "(", ")", "\n"]);
const WRITE_REDIRECTS = new Set([">", ">>", "&>"]);
const READ_REDIRECTS = new Set(["<", "<<"]);

/** `2>&1`：数字词 + `>&` + 数字词 = 复制文件描述符，不是路径。 */
function isFdDup(op: string, target: string): boolean {
  return op === ">&" && /^\d+$/.test(target);
}

function splitCommands(lexemes: readonly Lexeme[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let redirects: string[] = [];

  const flush = (): void => {
    if (words.length > 0 || redirects.length > 0) commands.push({ words, redirects });
    words = [];
    redirects = [];
  };

  for (let index = 0; index < lexemes.length; index += 1) {
    const lexeme = lexemes[index]!;

    if (lexeme.kind === "word") {
      words.push(lexeme.text);
      continue;
    }
    if (SEPARATORS.has(lexeme.text)) {
      flush();
      continue;
    }
    if (WRITE_REDIRECTS.has(lexeme.text)) {
      const target = lexemes[index + 1];
      if (target?.kind === "word" && !isFdDup(lexeme.text, target.text)) {
        redirects.push(target.text);
        index += 1;
      } else {
        // 目标不是个词（`> &1`、`>` 在行尾）—— 记成不可解析，别当"没写"。
        redirects.push("");
      }
      continue;
    }
    if (READ_REDIRECTS.has(lexeme.text)) {
      if (lexemes[index + 1]?.kind === "word") index += 1;
      continue;
    }
    if (lexeme.text === ">&") {
      const target = lexemes[index + 1];
      if (target?.kind === "word" && isFdDup(lexeme.text, target.text)) {
        // `2>&1`：整个吃掉，不是路径
        index += 1;
        continue;
      }
      if (target?.kind === "word") {
        // bash 把 `>&file` 当 `>file 2>&1` —— 是真实的写目标，必须记录。
        // 之前这里静默吃掉目标词，`echo x >& ~/.bashrc` 全程免问。
        redirects.push(target.text);
        index += 1;
        continue;
      }
      // 行尾悬空的 `>&`：记成不可解析，别当"没写"。
      redirects.push("");
      continue;
    }
  }

  flush();
  return commands;
}

/* ------------------------------------------------------------------ */
/* 语义：哪些命令写盘、哪些联网                                          */
/* ------------------------------------------------------------------ */

/** 写文件的命令。`last` 表示只有最后一个非选项参数是目标（`cp a b`）。 */
const WRITE_COMMANDS: Record<string, "all" | "last"> = {
  tee: "all",
  rm: "all",
  rmdir: "all",
  mkdir: "all",
  touch: "all",
  truncate: "all",
  chmod: "all",
  chown: "all",
  chgrp: "all",
  ln: "all",
  patch: "all",
  unzip: "all",
  cp: "last",
  mv: "last",
  install: "last",
  rsync: "last",
};

/**
 * 只在带 `-i` 时才写盘的命令。
 *
 * `sed 's/a/b/' f` 是只读的，`sed -i 's/a/b/' f` 会改文件 —— 不区分就会
 * 把最常见的只读用法变成每次都弹窗。
 */
const INPLACE_COMMANDS: Record<string, string> = { sed: "-i", perl: "-i" };

/** 解释器：命令体是代码，写目标静态判不出来。 */
const INTERPRETERS = new Set([
  "python",
  "python2",
  "python3",
  "node",
  "bun",
  "deno",
  "perl",
  "ruby",
  "php",
  "lua",
  "r",
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "osascript",
  "powershell",
  "pwsh",
]);

/**
 * 前缀包装器：真正的命令名在后面。
 */
const WRAPPERS = new Set(["sudo", "doas", "env", "time", "nohup", "command", "exec", "nice", "stdbuf"]);

/**
 * 包装器里"带值"的选项：跳过选项时必须连它的值一起跳过，否则
 * `sudo -u root tee /x` 会把 `root` 当成命令名，整条写检测全部失效。
 */
const WRAPPER_VALUE_FLAGS: Record<string, readonly string[]> = {
  sudo: ["-u", "-g", "-C", "-D", "-p", "-R", "-T", "-U", "--user", "--group", "--chdir", "--role", "--type", "--other-user", "--command"],
  doas: ["-u"],
  env: ["-u", "-S", "-C", "--unset", "--chdir", "--file", "--split-string"],
  nice: ["-n", "--adjustment"],
  stdbuf: ["-o", "-i", "-e", "--output", "--input", "--error"],
  time: ["-o", "-a", "-f", "--output", "--append", "--format"],
  command: ["-p"],
  exec: ["-a", "-c"],
  nohup: [],
};

const NETWORK_COMMANDS = new Set([
  "curl",
  "wget",
  "http",
  "httpie",
  "nc",
  "netcat",
  "ncat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "ftp",
  "ping",
  "traceroute",
  "dig",
  "nslookup",
  "host",
  "whois",
  "openssl",
]);

/**
 * "输出到文件"的长选项。含义无歧义，所以对所有命令通用。
 *
 * `--output` / `--out` / `--outfile` 后面跟的那个词就是写目标；
 * 也接受 `--output=path` 这种等号写法。
 */
const OUTPUT_LONG_FLAGS = new Set([
  "--output",
  "--output-file",
  "--output-document",
  "--out",
  "--outfile",
  "--result-file",
]);

/**
 * 短选项里表示"输出文件"的那些。
 *
 * 必须按命令区分：`curl -o f` 是写文件，但 `ssh -o X` 是"给个选项"、
 * `grep -o` 干脆不接受参数。混在一起会把最常见的只读命令变成每次都弹窗。
 */
const OUTPUT_SHORT_FLAGS: Record<string, readonly string[]> = {
  curl: ["-o"],
  wget: ["-O"],
  gcc: ["-o"],
  "g++": ["-o"],
  cc: ["-o"],
  clang: ["-o"],
  "clang++": ["-o"],
  ld: ["-o"],
  as: ["-o"],
  rustc: ["-o"],
  go: ["-o"],
  pandoc: ["-o"],
  convert: ["-o"],
  magick: ["-o"],
  openssl: ["-out"],
  pg_dump: ["-f"],
  mysqldump: ["--result-file"],
};

/**
 * `dd of=/x` 这种"选项内嵌路径"的写法。
 *
 * 通用处理：任何 `key=value` 形式的参数，只要 key 在表里就把 value 当写目标。
 */
const OUTPUT_KEY_VALUE: Record<string, readonly string[]> = {
  dd: ["of"],
  rsync: ["--write-file"],
};

/** 联网的 `git` / 包管理子命令。 */
const NETWORK_SUBCOMMANDS: Record<string, readonly string[]> = {
  git: ["clone", "fetch", "pull", "push", "remote", "submodule", "ls-remote"],
  npm: ["install", "i", "ci", "add", "update", "publish", "audit", "view", "outdated"],
  pnpm: ["install", "i", "add", "update", "publish"],
  yarn: ["install", "add", "upgrade", "publish"],
  bun: ["install", "i", "add", "update", "publish", "link"],
  pip: ["install", "download"],
  pip3: ["install", "download"],
  cargo: ["install", "add", "update", "publish", "fetch"],
  go: ["get", "install", "mod"],
  brew: ["install", "upgrade", "update", "tap"],
  apt: ["install", "update", "upgrade"],
  "apt-get": ["install", "update", "upgrade"],
  docker: ["pull", "push", "login", "build"],
  gh: ["api", "pr", "repo", "release"],
};

/**
 * 写意图信号：命令文本里出现这些字样，说明它**很可能在写文件**，
 * 而目标不是我们解析得出的那些路径。
 *
 * 只用于**解释器**这一条分支（`python3 -c …` 之类）。刻意不做"全局兜底扫描"：
 * 那会把 `grep -rn "mkdir" src` 这种纯读命令也变成每次弹窗 —— 实测过，
 * 关键词出现在引号里是常态。
 */
const WRITE_SIGNALS: readonly RegExp[] = [
  /\bwriteFile\w*/,
  /\bwrite_text\b/,
  /\bwrite_bytes\b/,
  /\bwrite\s*\(/,
  /\bmkdir\b/,
  /\bmakedirs\b/,
  /\bunlink\b/,
  /\bremove\s*\(/,
  /\brename\s*\(/,
  /\bshutil\./,
  /\bos\.system\b/,
  /\bsubprocess\./,
  /\bfopen\s*\(/,
  /\b>\s*\S/, // 代码里还有没解析掉的重定向
];

/**
 * `open(f, 'w')` 这类"打开就是为了写"的写法。
 *
 * 必须带模式才算 —— `open(f)` / `open(f, 'r')` 是读，不该打扰用户。
 */
const OPEN_FOR_WRITE = /open\s*\([^)]*['"][wax][+b]?['"]/;

function looksLikeWrite(code: string): boolean {
  return OPEN_FOR_WRITE.test(code) || WRITE_SIGNALS.some((pattern) => pattern.test(code));
}

/** 沙箱里 `/tmp` 是私有 tmpfs，写它不留下任何东西 —— 不算越界。 */
function isEphemeral(path: string): boolean {
  return path === "/tmp" || path.startsWith("/tmp/");
}

function isDevicePath(path: string): boolean {
  return (
    path === "/dev/null" ||
    path === "/dev/zero" ||
    path === "/dev/full" ||
    path === "/dev/random" ||
    path === "/dev/urandom" ||
    path === "/dev/stdout" ||
    path === "/dev/stderr" ||
    path === "/dev/stdin" ||
    path === "/dev/tty" ||
    path.startsWith("/dev/fd/") ||
    path.startsWith("/proc/self/fd/") ||
    path === "-"
  );
}

/** 目标里含变量 / 通配 / 命令替换 —— 静态判不出来。 */
function isDynamic(target: string): boolean {
  return /[$`*?]/.test(target) || target.includes("$(") || target.includes("${");
}

function expandTarget(target: string, cwd: string, home: string): string | undefined {
  if (isDynamic(target)) return undefined;
  let path = target;
  if (path === "~") path = home;
  else if (path.startsWith("~/")) path = join(home, path.slice(2));
  else if (path.startsWith("~")) {
    // `~user/...`（shell 会展开成其它用户的 home）不能按字面拼进 cwd ——
    // 那会把工作区外的目标误判成工作区内。保守按"判不出来"处理。
    return undefined;
  }
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  return absolute.length > 1 && absolute.endsWith("/") ? absolute.slice(0, -1) : absolute;
}

function insideWorkspace(cwd: string, path: string): boolean {
  if (path === cwd) return true;
  return path.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`);
}

function baseName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

/** 跳过 `-x` / `--long` 这类选项，返回非选项参数。 */
function operands(args: readonly string[]): string[] {
  return args.filter((arg) => !arg.startsWith("-") || arg === "-");
}

/** 目标优先（target-first）的选项：`cp -t DIR a b` 写的是 DIR，不是最后一个操作数。 */
const TARGET_FIRST_FLAGS: Record<string, readonly string[]> = {
  cp: ["-t", "--target-directory", "--target"],
  mv: ["-t", "--target-directory"],
  install: ["-t", "--target-directory"],
};

/**
 * 是否是"就地改文件"的选项。匹配要覆盖组合形态：`-i`、`-ib`、`-i.bak`、
 * `-pi`（perl）、`--in-place=.bak` —— 只认裸 `-i` 会把最常见的
 * `sed -i.bak s/a/b/ ~/.bashrc` 放成免问。
 */
function hasInplaceFlag(name: string, args: readonly string[]): boolean {
  const flag = INPLACE_COMMANDS[name];
  if (flag === undefined) return false;
  const letter = flag.slice(1, 2);
  return args.some(
    (word) =>
      word === flag ||
      word.startsWith("--in-place") ||
      (word.startsWith("-") && !word.startsWith("--") && word.includes(letter)),
  );
}

/** 联网命令名的保守正则：eval 主体是任意代码，按词扫一遍联网迹象。 */
const NETWORK_NAME_RE =
  /\b(curl|wget|http|httpie|nc|netcat|ncat|telnet|ssh|scp|sftp|rsync|ftp|ping|traceroute|dig|nslookup|host|whois|openssl|apt-get?|npm|pnpm|yarn|pip3?|cargo|go|brew|docker|gh)\b/;

function commandNameOf(words: readonly string[]): { name: string; args: readonly string[] } {
  let index = 0;
  while (index < words.length && WRAPPERS.has(baseName(words[index]!))) {
    const wrapper = baseName(words[index]!);
    index += 1;
    const valueFlags = WRAPPER_VALUE_FLAGS[wrapper] ?? [];
    while (index < words.length) {
      const word = words[index]!;
      if (word === "--") {
        // `--` 之后就是真命令
        index += 1;
        break;
      }
      if (/^[A-Za-z_]\w*=/.test(word)) {
        // `env FOO=1 cmd` 的赋值
        index += 1;
        continue;
      }
      if (word.startsWith("-")) {
        index += 1;
        // 带值的选项要连值一起跳过：`sudo -u root cmd` 的 root 不是命令名
        if (valueFlags.includes(word) && index < words.length) index += 1;
        continue;
      }
      break;
    }
  }
  const word = words[index];
  if (word === undefined) return { name: "", args: [] };
  return { name: baseName(word), args: words.slice(index + 1) };
}

function isNetworkCommand(name: string, args: readonly string[]): boolean {
  if (NETWORK_COMMANDS.has(name)) return true;
  const subcommands = NETWORK_SUBCOMMANDS[name];
  if (subcommands === undefined) return false;
  const first = operands(args)[0];
  return first !== undefined && subcommands.includes(first);
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 扫一条命令，回答"它会不会写到工作区之外 / 会不会联网"。
 *
 * 三个字段的含义互相独立：一条命令可以既写工作区外又联网（`curl -o /x ...`）。
 */
export function scanCommand(command: string, options: ScanOptions): CommandScan {
  const cwd = options.cwd.length > 1 && options.cwd.endsWith("/") ? options.cwd.slice(0, -1) : options.cwd;
  const home = options.home ?? homedir();

  const targets: string[] = [];
  const outside: string[] = [];
  let network = false;
  let unresolvedWrite = false;

  const record = (raw: string): void => {
    if (raw.length === 0 || isDevicePath(raw)) return;
    const expanded = expandTarget(raw, cwd, home);
    if (expanded === undefined) {
      unresolvedWrite = true;
      return;
    }
    if (!targets.includes(expanded)) targets.push(expanded);
    // `/tmp` 在沙箱里是私有 tmpfs，写它留不下任何东西 —— 不算越界。
    // 但**仍要记进 writeTargets**：工作区本身可能就落在 /tmp 下（临时 worktree、
    // 测试目录），那时 read-only 档要挡的正是这些路径。
    if (insideWorkspace(cwd, expanded) || isEphemeral(expanded)) return;
    if (!outside.includes(expanded)) outside.push(expanded);
  };

  for (const simple of splitCommands(lex(command))) {
    for (const redirect of simple.redirects) {
      // 空串 = 重定向符号后面没有可解析的目标（`> &1`、行尾的 `>`）
      if (redirect.length === 0) {
        unresolvedWrite = true;
        continue;
      }
      record(redirect);
    }

    const { name, args } = commandNameOf(simple.words);
    if (name.length === 0) continue;

    if (isNetworkCommand(name, args)) network = true;

    // eval 的主体是任意 shell 代码，写/联网都判不出来 —— 保守按"可能写"问，
    // 联网迹象按命令名在主体里扫一遍。
    if (name === "eval") {
      unresolvedWrite = true;
      if (NETWORK_NAME_RE.test(args.join(" "))) network = true;
    }

    const writeShape = WRITE_COMMANDS[name];
    if (writeShape !== undefined) {
      const values = operands(args);
      const picked = writeShape === "last" ? values.slice(-1) : values;
      for (const value of picked) record(value);

      // `cp -t DIR a b`：真正的目标是 DIR。last 形态只记最后一个操作数会
      // 把 DIR 漏掉 —— 两个都记，保守。
      const targetFlags = TARGET_FIRST_FLAGS[name];
      if (targetFlags !== undefined) {
        for (let index = 0; index < args.length; index += 1) {
          const arg = args[index]!;
          if (targetFlags.includes(arg)) {
            const next = args[index + 1];
            if (next !== undefined) record(next);
            continue;
          }
          const equals = arg.indexOf("=");
          if (equals > 0 && targetFlags.includes(arg.slice(0, equals))) {
            record(arg.slice(equals + 1));
          }
        }
      }
    }

    if (hasInplaceFlag(name, args)) {
      for (const value of operands(args).slice(1)) record(value);
    }

    // "输出到文件"的选项：`curl -o f` / `wget -O f` / `dd of=f` / `--output=f`
    const shortFlags = OUTPUT_SHORT_FLAGS[name] ?? [];
    const keyValues = OUTPUT_KEY_VALUE[name] ?? [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (OUTPUT_LONG_FLAGS.has(arg) || shortFlags.includes(arg)) {
        const next = args[index + 1];
        if (next !== undefined) record(next);
        continue;
      }
      const equals = arg.indexOf("=");
      if (equals <= 0) continue;
      const key = arg.slice(0, equals);
      if (OUTPUT_LONG_FLAGS.has(key) || keyValues.includes(key)) record(arg.slice(equals + 1));
    }

    if (INTERPRETERS.has(name) && looksLikeWrite(command)) {
      unresolvedWrite = true;
    }
  }

  return {
    writeTargets: targets,
    outsidePaths: outside,
    network,
    writeIntent: unresolvedWrite,
    clean: outside.length === 0 && !unresolvedWrite && !network,
  };
}

/**
 * 批准后要绑成可写的目录。
 *
 * bwrap 的 `--bind <src> <dst>` 要求 **src 已存在**，而 `> /home/me/new.txt`
 * 的目标往往还不存在。所以退一步绑**最近的已存在祖先目录**，并把范围
 * 如实写进弹窗 —— 这是有意的放大，换来"批准后真的能写"。
 */
export function writableAncestors(
  paths: readonly string[],
  probe: PathProbe = defaultPathProbe,
): readonly string[] {
  const out: string[] = [];
  for (const path of paths) {
    let current = path;
    for (;;) {
      if (probe(current) !== "missing") break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    // 绑到一个文件本身没有意义（它所在的目录仍然只读），所以上提一层。
    if (probe(current) === "file") current = dirname(current);
    if (!out.includes(current)) out.push(current);
  }
  return out;
}

/** 路径探测：`--bind` 只能绑目录，所以要区分文件与目录。 */
export type PathProbe = (path: string) => "file" | "dir" | "missing";

export function defaultPathProbe(path: string): "file" | "dir" | "missing" {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

export interface WriteApprovalPlan {
  /** 弹窗里展示的具体越界目标。 */
  paths: readonly string[];
  /** 批准后要绑成可写的目录（`--bind` 的源）。 */
  binds: readonly string[];
  /** 目标静态判不出来 —— 只有命令明确提到 home 时才放开 home。 */
  undecidable: boolean;
}

export interface WriteApprovalOptions {
  cwd: string;
  home: string;
  /** 当前档位下工作区是否可写。`false`（read-only）时工作区内的写也要问。 */
  workspaceWritable: boolean;
  command: string;
  probe?: PathProbe;
}

function dedupe(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) if (!out.includes(value)) out.push(value);
  return out;
}

/** 命令文本是否明确指向 home。判不出目标时，只有它能为"放开哪里"提供依据。 */
function mentionsHome(command: string, home: string): boolean {
  // 词级 + 注释感知（BUG-010）：旧的子串测试会被注释里的 "~" 误触发，把整个
  // $HOME bind 成可写。规则：
  //   - 未加引号的 `#`（词首）开启注释，到行尾为止 —— 注释里的 ~/docs 不算；
  //   - 独立词 ~/ / $HOME / home 前缀 → 命中；
  //   - 引号内的解释器体（lex 后引号已剥掉，整段是一个词）里出现 ~/ 或
  //     $HOME/ → 也算引用 —— 写意图场景里那才是真正的目标所在。
  let inComment = false;
  for (const lexeme of lex(command)) {
    if (lexeme.kind === "op") {
      if (lexeme.text === "\n") inComment = false;
      continue;
    }
    const word = lexeme.text;
    // bash 语义：词首的未引用 `#` 开启注释，到行尾为止。引号开头的词
    // （`"#..."`）不是注释。
    if (lexeme.startedWithQuote !== true && word.startsWith("#")) {
      inComment = true;
      continue;
    }
    if (inComment) continue;

    // 独立词的 ~ 家族（~, ~/x, ~user/x）与 $HOME / home 前缀
    if (word.startsWith("~") || word === "$HOME" || word.startsWith("$HOME/")) return true;
    if (word === home || word.startsWith(`${home}/`)) return true;
    // 引号内的引用（`open("~/x")` 整体是一个词）
    if (word.includes("~/") || word.includes("$HOME/") || word.includes(`${home}/`)) return true;
  }
  return false;
}

/**
 * 敏感目录：即使被解析为越界写目标，批准也**绝不**把它们 bind 成可写
 * （BUG-010）。批准后命令照跑，但写会被内核的只读挂载挡住 —— 比起
 * "一次批准，~/.ssh 从此可写"，宁可让那次写失败。目标本身仍会出现在
 * 弹窗的"目标"列表里，用户看得到模型想干什么。
 */
const SENSITIVE_BIND_RE = /(^|\/)\.(ssh|gnupg|aws|config|bugent)(\/|$)/;

/**
 * 把一次扫描翻译成"要不要问、批准后放开什么"。
 *
 * 三种情况都要问：
 *   1. 解析出了工作区外的写目标 —— 批准后精确放开它们的父目录；
 *   2. 档位是 read-only，写目标在工作区内 —— 批准后放开工作区本身；
 *   3. 有写意图但目标判不出来 —— 只有命令提到 home 时才放开 home，
 *      否则**不放开任何东西**：判不出目标就"哪里都放开"是把授权变成猜谜。
 *
 * 返回 undefined 表示这次不必打扰用户。
 */
export function planWriteApproval(
  scan: CommandScan,
  options: WriteApprovalOptions,
): WriteApprovalPlan | undefined {
  const workspaceBlocked = !options.workspaceWritable && scan.writeTargets.length > 0;
  if (scan.outsidePaths.length === 0 && !scan.writeIntent && !workspaceBlocked) return undefined;

  const binds: string[] = [];
  const paths: string[] = [...scan.outsidePaths];

  if (scan.outsidePaths.length > 0) {
    binds.push(...writableAncestors(scan.outsidePaths, options.probe ?? defaultPathProbe));
  } else if (workspaceBlocked) {
    binds.push(options.cwd);
  }

  if (scan.writeIntent && mentionsHome(options.command, options.home)) {
    binds.push(options.home);
  }

  // 敏感目录过滤（BUG-010）：writableAncestors 会爬到最近的已存在祖先，
  // `> ~/.ssh/authorized_keys` 由此得到 ~/.ssh 的可写 bind —— 必须拦下。
  const safeBinds = binds.filter((bind) => !SENSITIVE_BIND_RE.test(bind));
  return { paths, binds: dedupe(safeBinds), undecidable: scan.writeIntent };
}
