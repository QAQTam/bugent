/**
 * 代码高亮。
 *
 * 三层设计，按需付费：
 *
 *   1. **ts/js/jsx/tsx 走 Bun 原生** —— Zig tokenizer，0.01ms 级，
 *      连 highlight.js 都不加载
 *   2. **其他语言懒加载 highlight.js** —— 首次遇到某语言才 import 它的模块，
 *      启动成本保持 O(1)
 *   3. **结果按 (语言, 代码) 缓存** —— 流式输出下每帧只有最后一块在变，
 *      缓存把每帧成本从 4.4ms 压到 0.07ms
 *
 * 为什么要缓存：实测 60 个代码块全量重算要 4.42ms/帧，逼近 60fps 的
 * 16.7ms 预算；而只重算变化的那一块是 0.071ms，基本免费。
 */

/** Bun 原生就支持的语言 —— 不加载 highlight.js。 */
const NATIVE_LANGUAGES = new Set(["js", "javascript", "ts", "typescript", "jsx", "tsx"]);

/** 语言别名 -> highlight.js 的模块名。 */
const ALIASES: Record<string, string> = {
  py: "python",
  python3: "python",
  rs: "rust",
  golang: "go",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  jsonc: "json",
  "c++": "cpp",
  cc: "cpp",
  h: "c",
  hpp: "cpp",
  rb: "ruby",
  html: "xml",
  htm: "xml",
  vue: "xml",
  svg: "xml",
  md: "markdown",
  dockerfile: "dockerfile",
  make: "makefile",
  ps1: "powershell",
  pwsh: "powershell",
};

/**
 * 按需加载的语言表。
 *
 * 每个都是 `() => import(...)` —— 只有真的渲染到该语言才会触发网络/磁盘读取。
 * 刻意不写 `import hljs from "highlight.js"`（那是全量 190+ 语言的入口）。
 */
const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  python: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
  go: () => import("highlight.js/lib/languages/go"),
  bash: () => import("highlight.js/lib/languages/bash"),
  json: () => import("highlight.js/lib/languages/json"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  sql: () => import("highlight.js/lib/languages/sql"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  java: () => import("highlight.js/lib/languages/java"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  swift: () => import("highlight.js/lib/languages/swift"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  php: () => import("highlight.js/lib/languages/php"),
  lua: () => import("highlight.js/lib/languages/lua"),
  perl: () => import("highlight.js/lib/languages/perl"),
  r: () => import("highlight.js/lib/languages/r"),
  scala: () => import("highlight.js/lib/languages/scala"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  elixir: () => import("highlight.js/lib/languages/elixir"),
  erlang: () => import("highlight.js/lib/languages/erlang"),
  clojure: () => import("highlight.js/lib/languages/clojure"),
  toml: () => import("highlight.js/lib/languages/ini"),
  ini: () => import("highlight.js/lib/languages/ini"),
  xml: () => import("highlight.js/lib/languages/xml"),
  css: () => import("highlight.js/lib/languages/css"),
  scss: () => import("highlight.js/lib/languages/scss"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  plaintext: () => import("highlight.js/lib/languages/plaintext"),
};

/** 语言名归一化：小写、去空白、查别名。 */
export function normalizeLanguage(language: string | undefined): string {
  if (language === undefined) return "";
  const raw = language.trim().toLowerCase();
  if (raw.length === 0) return "";
  return ALIASES[raw] ?? raw;
}

export function isNativeLanguage(language: string | undefined): boolean {
  return NATIVE_LANGUAGES.has(normalizeLanguage(language));
}

/* ------------------------------------------------------------------ */
/* 缓存                                                                */
/* ------------------------------------------------------------------ */

/** 缓存上限：防止长会话里无限增长。 */
const MAX_CACHE_ENTRIES = 400;

const cache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  // LRU：命中后挪到末尾
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: string): void {
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearHighlightCache(): void {
  cache.clear();
}

/* ------------------------------------------------------------------ */
/* 加载                                                                */
/* ------------------------------------------------------------------ */

type HighlightModule = {
  highlight: (code: string, options: { language: string }) => { value: string };
};

const loaded = new Map<string, HighlightModule>();
const loading = new Set<string>();

/** 语言模块加载完成后通知外部重绘。 */
let onReady: (() => void) | undefined;

export function setHighlightReadyHandler(handler: (() => void) | undefined): void {
  onReady = handler;
}

/** 该语言是否已经可以同步高亮。 */
export function isLanguageReady(language: string): boolean {
  const lang = normalizeLanguage(language);
  return isNativeLanguage(lang) || loaded.has(lang) || !(lang in LOADERS);
}

function ensureLoaded(language: string): void {
  const lang = normalizeLanguage(language);
  if (loaded.has(lang) || loading.has(lang)) return;

  const loader = LOADERS[lang];
  if (loader === undefined) return; // 不认识的语言，保持纯文本

  loading.add(lang);
  void loader()
    .then(async (mod) => {
      const { default: hljs } = await import("highlight.js/lib/core");
      const core = hljs as unknown as {
        registerLanguage: (name: string, def: unknown) => void;
        highlight: (code: string, options: { language: string }) => { value: string };
      };
      core.registerLanguage(lang, mod.default);
      loaded.set(lang, { highlight: (code, options) => core.highlight(code, options) });
      onReady?.();
    })
    .catch(() => {
      // 加载失败就当纯文本处理，绝不因为高亮挂掉整个渲染
    })
    .finally(() => {
      loading.delete(lang);
    });
}

/* ------------------------------------------------------------------ */
/* 高亮                                                                */
/* ------------------------------------------------------------------ */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 把 highlight.js 产出的 `<span class="hljs-keyword">` 转成 ANSI。 */
function htmlToAnsi(html: string): string {
  // 每种 token 一种颜色。用 256 色，兼容性比 truecolor 好。
  const COLORS: Record<string, string> = {
    keyword: "38;5;170",
    built_in: "38;5;81",
    type: "38;5;80",
    literal: "38;5;173",
    number: "38;5;173",
    string: "38;5;150",
    regexp: "38;5;150",
    comment: "38;5;244",
    doctag: "38;5;244",
    meta: "38;5;244",
    title: "38;5;180",
    "function": "38;5;180",
    attr: "38;5;180",
    variable: "38;5;222",
    "template-variable": "38;5;222",
    params: "38;5;222",
    symbol: "38;5;173",
    selector: "38;5;170",
    "selector-class": "38;5;180",
    tag: "38;5;170",
    name: "38;5;170",
    attribute: "38;5;180",
    section: "38;5;180",
    bullet: "38;5;170",
    emphasis: "3",
    strong: "1",
    addition: "38;5;150",
    deletion: "38;5;174",
  };

  return (
    html
      // highlight.js 会输出 class 列表，如 `hljs-title function_` ——
      // 只取第一个 hljs-* 作为主类型，后面的修饰类忽略
      .replace(/<span class="hljs-([a-z-]+)[^"]*">/g, (_match, cls: string) => {
        const color = COLORS[cls] ?? "0";
        return `\x1b[${color}m`;
      })
      .replace(/<\/span>/g, "\x1b[0m")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
  );
}

/**
 * 高亮一段代码，返回 ANSI 文本（不含代码框）。
 *
 * 同步接口：语言模块还没加载好时先返回纯文本，并触发异步加载；
 * 加载完成后通过 onReady 回调通知调用方重绘。这样渲染路径不用变成 async。
 */
export function highlightCode(code: string, language: string | undefined): string {
  const lang = normalizeLanguage(language);

  // Bun 原生支持的语言交给上层用原生路径处理，这里不碰
  if (lang.length === 0 || isNativeLanguage(lang)) return code;

  const key = `${lang}\u0000${code}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const module = loaded.get(lang);
  if (module === undefined) {
    ensureLoaded(lang);
    return code; // 先给纯文本，加载完会重绘
  }

  let result: string;
  try {
    result = htmlToAnsi(module.highlight(code, { language: lang }).value);
  } catch {
    result = code;
  }

  cacheSet(key, result);
  return result;
}
