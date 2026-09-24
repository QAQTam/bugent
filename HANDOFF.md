# bugent Handoff

> 更新时间：2026-09-24  
> 分支：`master`  
> 基线提交：`f04a60d feat: 强化会话运行时并接入 Bun sandbox SDK`
> 当前状态：Linux 原生 sandbox provider、MCP、skills、Bun fork runtime 与 buTUI 独立实验入口已完成；当前工作树待拆分提交

## 1. 当前状态

已验证：

```bash
bun test
# 514 pass / 0 fail

bun run typecheck
# clean
```

当前全局 `bun` 已替换为 Bugent Bun fork：

```text
/home/qaqtamsy/.bun/bin/bun
version 1.4.3
upstream backup: /home/qaqtamsy/.bun/bin/bun-upstream-1.4.2
project runtime: runtime/bun/bin/bugent-bun
```

真实 provider 冒烟已通过（本地 wbproxy，允许的模型）：

```bash
bun run src/index.ts \
  -p '请调用 read_file 读取 package.json，然后用一句话告诉我 package name。' \
  -m openai/deepseek-v4.1-flash \
  --mode read-only \
  --yes
# 工具调用正常，回答 "package name 是 bugent"
```

工作区有两个既有未跟踪探针，不要提交：

```text
scripts/xw-probe.ts
scripts/xw-probe2.ts
```

测试真实模型时只使用：

```text
deepseek-v4.1-flash
hy4 系列
```

其他模型视为付费，不使用。

## 2. 最近已完成

### 2.1 reasoning replay

提交：`5e82597`

reasoning 现在：

- 实时进入 TUI 思考行；
- 累积到 assistant 消息；
- 持久化到 SQLite `messages.reasoning`；
- 进入 `buildContext()`；
- 由 OpenAI Chat adapter 按配置回放。

配置：

```toml
[[providers]]
reasoning_replay = "reasoning"
# reasoning | reasoning_content | both | none
```

当前 schema 版本：

```text
SCHEMA_VERSION = 9
```

### 2.2 思考链路 UI

- 青色菊花帧：`✻ ✽ ✶ ✳ ✢`
- 80ms 帧动画
- 土金色正文
- TUI 展示仍是 O(1) 缓冲
- 在 assistant 消息边界、turn 结束、branch/runtime 切换和 `/new` 时 reset

注意：

- TUI 的 `ThinkingBuffer` 是展示态；
- `StoredMessage.reasoning` 是协议回放态；
- 两者生命周期不同，不要混用。

## 3. Phase A：ToolBatch 协议安全（已完成）

核心不变量：

```text
assistant(tool_calls=[tc1, tc2, tc3])
tool(tr1)
tool(tr2)
tool(tr3)
```

中间不能插入 user / injection / assistant / 新 tool call batch / 缺失或错序的 tool result。

实现位置：`src/core/session.ts`

规则：

- `appendAssistant(text, toolCalls)` 落库 assistant 后立即打开 batch；
- batch 打开期间，`appendUser` / `appendInjection` / 新 `appendAssistant` 直接抛错；
- `appendToolResult` 只接受当前 batch 内的 call id；
- 结果先存原始输入，flush 时才分配 msgid，保证乱序到达时 msgid 与消息顺序仍严格递增；
- `flushToolResultsInOrder()` 只 flush 已到齐的前缀；
- 所有结果到齐后 batch 自动关闭；
- `finishToolBatch()` / `abortToolBatch()` 按原 call 顺序补 synthetic error；
- `runTurn` 在发下一次 provider 请求前断言没有 open batch；
- `runTurn` 的 `finally` 补齐 abort / 异常留下的缺失结果；
- `AgentSession` 恢复历史时扫描尾部孤立 tool calls，并补：

```text
Error: tool result missing due to interrupted session
```

如果历史里的 tool result 顺序与 call 顺序不匹配，恢复会明确报错；这种形态不能靠追加修复。

## 4. Phase B：消息队列（已完成）

实现位置：`src/core/session.ts`、`src/tui/app.ts`

### 4.1 API

```ts
type SubmitResult =
  | { status: "started"; msgid: number }
  | { status: "queued"; position: number };

class AgentSession {
  submitUser(text: string): SubmitResult;
  enqueueUser(text: string): number;
  enqueueInjection(text: string, source?: InjectionSource): void;

  dequeueUserAfterTurn(): string | undefined;
  drainInjectionsAtSafeBoundary(): StoredMessage[];

  hasOpenToolBatch(): boolean;
  finishToolBatch(missingText?: string): StoredMessage[];
  abortToolBatch(reason?: string): StoredMessage[];
}
```

### 4.2 语义

- busy 时用户输入只排队，不启动第二个 `runTurn`；
- turn 正常结束后自动 drain 队首 user message；
- abort / 错误后保留队列，不自动执行；
- 空 Enter 可继续执行 abort 后保留的队列；
- injection 只在没有 open batch 的模型步边界 flush；
- `ask_user` answer 属于当前 tool execution，不 append user；
- branch / runtime switch、`/new`、retry 清空旧队列。

TUI 状态栏显示：

```text
[已排队 N]
```

abort 且队列非空时显示：

```text
已中断；[已排队 N] 保留，按 Enter 继续
```

## 5. 真实 provider 取证

使用 wbproxy：

```text
http://127.0.0.1:8787/v1
```

### hy4-preview-f

两组异常请求都返回 200：

- 孤立 tool call；
- tool call 与 tool result 中间插 user。

说明该上游/模型当前比较宽容，但不能依赖。

### deepseek-v4.1-flash

同样两组请求都返回 400：

```text
code=11148
tool_call_sequence_broken
tool calls and tool results do not match
```

结论：

> 工具消息配对必须在 bugent 内部保证，不能靠 provider 容错。

修复后的真实工具调用链已返回 200。

## 6. Retry 语义

retry 不走消息队列。

正确语义：

```text
旧 branch:
  U1 A1 U2 A2

retry U2:
  -> 创建新 branch
  -> 截断到 U2 之前
  -> 在新 branch append 一次 U2
  -> 在新 branch run
```

规则：

- retry 使用新 branch；
- 不复用旧 queue；
- 不额外注入旧 user message；
- 新 branch 的 session 从空队列开始；
- 旧 branch 的排队消息不带入新 branch。

## 7. 测试覆盖

`tests/protocol-safety.test.ts` 已覆盖：

1. `tc1,tc2,tc3 -> tr1,tr2,tr3` 顺序；
2. batch 内提交 user，不会插到 tool call / tool result 之间；
3. batch 内 injection 在 batch 后 flush；
4. 并发 tool result 乱序到达，最终按 call 顺序 flush；
5. abort 后补齐 synthetic tool results；
6. crash recovery：resume 后修复尾部孤立 tool calls；
7. retry：旧 branch 不变，新 branch 只出现一次原 user message。

TUI PTY 冒烟覆盖了连续 10 条输入排队后自动 drain。

`tests/tool-concurrency.test.ts` 已覆盖：

1. 不同资源的工具真正并行执行；
2. 同一文件写锁让 edit 类工具串行；
3. `edit_file` 与 `python` 修改同一文件时通过 workspace 写锁串行；
4. 结果乱序完成时仍按 tool_calls 顺序落库；
5. bash 只读 / 写命令的资源分类；
6. ResourceLockManager 的同文件互斥、workspace 与具体文件冲突；
7. 等待锁时 abort 会取消排队请求。

## 8. Phase C：并发工具与资源锁（已完成）

实现位置：

- `src/core/loop.ts`：同一 assistant 消息里的多个 tool calls 并发执行；
- `src/tools/locks.ts`：读写资源锁；
- `src/tools/types.ts`：ToolRegistry 在 `tool.run` 外层持锁；
- `src/tools/files.ts`：文件工具声明具体文件资源；
- `src/tools/bash.ts`：bash 资源分类；
- `src/tools/ask_user.ts`：交互工具独占 `interaction`。

锁模型：

```text
workspace                 整个工作区
workspace/<relative path> 单个文件
interaction               交互弹窗
```

冲突规则：

- 键相等，或一个是另一个的目录前缀时视为重叠；
- 任一侧是 write 就必须串行；
- read/read 可以并发；
- 锁按 call 顺序申请，保证同文件实际写入顺序与消息顺序一致，undo 才能按逆序正确回滚。

工具声明：

- `read_file` -> `workspace/<file>` read
- `write_file` / `edit_file` -> `workspace/<file>` write
- 只读 bash（ls / cat / rg / git status 等）-> `workspace` read
- 非只读 bash（python / sed -i / 重定向 / git apply 等）-> `workspace` write
- 未声明资源的写工具 / 沙箱工具 -> 保守地拿 `workspace` write
- `ask_user` -> `interaction` write

关键效果：

```text
edit_file(a.ts) + read_file(a.ts)      -> 串行
edit_file(a.ts) + edit_file(b.ts)      -> 并行
edit_file(a.ts) + python 修改 a.ts     -> 串行
python 修改 a.ts + python 修改 b.ts    -> 串行（无法静态判断目标，保守）
```

并发结果仍由 ToolBatch 保证按 call 顺序落库；`appendReady` 只 flush 已连续到齐的前缀，因此完成顺序不影响协议顺序。

### 8.1 弹窗布局

权限确认、能力授权、升档、`ask_user` 和消息操作菜单现在不再覆盖消息区底部，而是：

- 取代输入面板的位置，水平居中显示；
- 有完整边框（`┌─┐│└─┘`，`dialogBorder` 色）；
- 整体铺 `dialogBg` 独立底色，和输入面板 / 正文形成层级；
- 按钮使用填充方框 `▐ 同意（y） ▌`，快捷键直接合进按钮；
- 按钮语义色：普通同意绿、高危授权同意琥珀、拒绝红、取消/检查/复制中性灰蓝；
- 打开时隐藏思考区，给弹窗让空间；
- 消息区高度自动收缩，最新一条消息始终留在弹窗上方；
- 终端过小时弹窗最多占 `height - 2` 行，底部内容仍可能被裁剪。

没有采用“右侧空白区”方案：当前正文是单列全宽布局，右侧并没有稳定保留的空白区域。若以后要做右侧面板，需要先引入响应式分栏布局。

### 8.2 当前限制

- bash 非只读命令拿整个 workspace 写锁，无法做到“不同文件的 python 并行”；
- bash 只读分类是保守白名单，`echo hi` 之类也会被当作写命令；
- 交互弹窗通过 TUI 的 `#serializeInteraction` 串行，避免并发工具互相覆盖对话框；
- 权限确认在持有资源锁后发生，因此同文件工具会按 call 顺序等待用户确认，不会因弹窗耗时改变写入顺序。

## 9. Context Layout v2（死规矩）

新 session 固定：

```text
msgid0  system prompt snapshot（Markdown 文件读取）
msgid1  MCP manifest（存储 role=system，协议默认 developer）
msgid2  skills manifest（存储 role=system，协议默认 developer）
msgid3+ user / assistant / tool conversation
```

规则：

- system prompt 不再写死在源码，默认从 `src/prompts/system.md` 读取；
- 配置可用 `agent.system_prompt_file` 覆盖，支持 `~` 和相对 cwd 路径；
- 读取结果快照进 msgid0，之后文件变化不修改已有 session；
- msgid1/msgid2 存储为 system message，通过 `injectionSource=mcp/skill` 标识；
- 默认渲染为 developer role；
- 端点拒绝 developer role 时，TUI 询问是否改用 system role 重发；
- 回退只影响渲染，不改写历史消息；
- 上下文顺序由 `ContextPlan` 语义决定：system -> MCP -> skills -> conversation；
- 工具名命名空间：`mcp__<server>__<tool>` / `skill__<skill>__<tool>`。

数据库新增 `messages.injection_source`，schema 升到 v8。

## 10. 斜杠命令 / session context

已实现：

- 输入 `/` 打开命令菜单；
- `/context` 查看当前 session 的 provider / model / client / sandbox / branch / API key 状态；
- `/context` 可进入二级配置菜单；
- `/mode <mode>` 切换当前 session 沙箱档位；
- `/provider` 从已注册 provider 中切换，新增 session 级 provider，或管理 provider profiles；
- `/model` 输入模型名，也支持 `provider/model` 一次切换两者；
- `/key` 掩码输入 API key；
- `/new`、`/exit` 保留。

关键原则：**不修改全局 config**。

- 沙箱档位按 session 保存到 `sessions.sandbox_mode`；
- provider/model 按 session 写回 `sessions.provider_id` / `sessions.model`；
- 非敏感 provider profile 按 session 保存到 `session_providers` 表；
- 一个 session 可以保存多个 provider profile，并在 TUI 中切换；
- provider profile 支持 `endpoint/baseUrl/headers/extraBody/reasoningReplay/proxy`；
- TLS 支持 `caFile/certFile/keyFile` 文件路径，adapter 在创建 client 时读取 PEM；
- provider profile 支持切换、重命名、复制、删除；active profile 不能直接删除；
- 新增版本化 `provider-profiles` 文档与 `exportProviderProfiles/importProviderProfiles` core API，未来 WebUI 可直接复用；
- 导入导出默认不含 apiKey 和内联 TLS 私钥；导入冲突策略支持 `skip/overwrite/rename`，并支持 dry-run；
- `createSessionRuntime()` 解析 effective mode：显式请求 > session 记录 > workspace-write；
- provider/model 解析：显式请求 > session 记录 > 启动时默认；
- API key 优先保存到系统 keychain（Linux `secret-tool` / macOS `security`），不可用时降级到进程内存；
- keychain 按 `sessionId + providerId` 隔离，启动时自动加载 active provider 的 key；
- `ProviderRegistry.resolve(ref, overrides)` 支持 session 级 provider 覆盖，也支持未注册 provider + 完整配置；
- 切换任何 provider/model/sandbox 都通过重建 `SessionRuntime` 完成；
- 重建时保留同一个 sessionId / branchId，消息历史从 store 恢复，不新建会话；
- 有排队消息或 turn 运行中时拒绝切换，避免配置切换与旧队列混用；
- provider 切换会清掉旧 provider 的 API key override，避免把旧 key 发给新 provider；
- provider/model/profile/api-key 变更都会写 `session_config` audit 事件，payload 不含密钥。

安全边界：

- `/key` 使用 masked input，输入和汇总都不回显明文；
- API key 不进入 transcript / audit / SQLite；
- `setProviderConfig()` 即使被错误传入 `apiKey` 也会强制剔除；
- keychain 不可用时只退化为进程内存，不会写明文文件；
- 真实 API key 仍只应使用允许的测试模型和本地 wbproxy。

尚未实现：

- TUI 里还没有 provider profile 导入/导出入口（core API 已有）；
- TLS 表单还没接进 TUI（adapter/core 已支持 *File）；
- Windows 还没有 keychain 后端。

下一步建议：WebUI 接 `provider-profiles` core API；TUI 可再加一个简单的导入/导出 JSON 命令。

## 10.1 Bun fork / runtime SDK

Bun fork：

```text
/home/qaqtamsy/项目/bun
branch: feat/spawn-sandbox-hook
commit: 675ec8c768
base revision: 6d504dd983
```

新增原生 sandbox provider ABI：

```c
void* bun_spawn_sandbox_prepare(const char* config, size_t config_len, int* errno_out);
int bun_spawn_sandbox_apply(void* state);
void bun_spawn_sandbox_destroy(void* state);
```

`Bun.spawn` 新增：

```ts
sandbox: {
  library: string;
  config?: string;
}
```

- `prepare` 在 Bun 父进程调用；
- `apply` 在 fork/vfork 子进程、`execve` 前调用，必须 async-signal-safe；
- `destroy` 在 spawn 返回后调用；
- Linux 下 hook 位于 `posix_spawn_bun` 的 child setup 内；
- macOS 有 sandbox hook 时强制走 Bun 的 fork/posix_spawn 路径；
- Windows 当前明确报错，不静默忽略。

已验证：

- debug 和 release 二进制均成功构建；
- release 二进制：`build/release/bun`，约 78MB；
- release 版本：`1.4.3`，revision `6d504dd983`；
- 真实 provider 测试通过：允许路径返回 0，provider 返回 `EACCES` 时 spawn 正确失败；
- bugent 测试：493 pass / 0 fail；
- bugent typecheck 通过。

安装当前 checkout 的 fork：

```bash
bun run runtime:install
bun run runtime:install -- --global
```

`--global` 会保留 `~/.bun/bin/bun-upstream-<version>`，再原子替换
`~/.bun/bin/bun`，并创建 `bugent-bun` alias。runtime 校验同时接受路径相同或
字节内容相同的二进制，因此全局副本与 `runtime/bun/bin/bugent-bun` 都被认可。

bugent runtime SDK：

```text
runtime/bun/
```

提供：

- `@bugent/bun-runtime` 包结构；
- `spawnSandboxed()` / `spawnMcpServer()` helper；
- `include/bun_spawn_sandbox.h`；
- `types/bun-spawn-sandbox.d.ts`；
- `scripts/package.ts` 打包脚本。

打包命令：

```bash
cd /home/qaqtamsy/项目/bugent
bun run package:bun-runtime
```

当前 artifact：

```text
dist/bun-runtime/bugent-bun-runtime-1.4.3-bugent.3-linux-x64.tar.gz
sha256: 12590fd2efbfdd9d9ab69cf09663fd248e49fd23dcd79a98c3b61953b463473c
```

包内运行时：

```text
bugent-bun-runtime/bin/bugent-bun
bugent-bun-runtime/lib/libbugent-sandbox.so
bugent-bun-runtime/include/bun_spawn_sandbox.h
bugent-bun-runtime/src/index.ts
bugent-bun-runtime/types/bun-spawn-sandbox.d.ts
bugent-bun-runtime/runtime.json
```

### 10.1.1 bugent 0.0.0 standalone binary

打包命令：

```bash
bun run package:bugent
```

实现：

- 使用 `runtime/bun/bin/bugent-bun` 执行 `bun build --compile`；
- 将 `src/prompts/system.md` 和 `libbugent-sandbox.so` 作为 `--asset` 嵌入；
- 单文件首次启动时把 `.so` 原子解包到
  `~/.bugent/runtime/0.0.0/lib/libbugent-sandbox.so`；
- standalone 模式通过嵌入 asset 识别，不再要求 `process.execPath` 等于
  `runtime/bun/bin/bugent-bun`；
- 打包脚本会启动一个真实 stdio MCP probe，验证编译后二进制的 fork sandbox
  hook、原生 provider、JSON-RPC 和 mock 对话链路。

当前产物：

```text
dist/bugent/bugent-0.0.0-linux-x64/bugent
sha256: d355dc91674209c598a73e7e948044f8d3b59b10c9735835ffba1afc12f3b3f1

dist/bugent/bugent-0.0.0-linux-x64.tar.gz
sha256: dc6484fa61c67fd8300a1138e1513ddb1b79de09e65d71030230bbe3d1eaabc6
```

构建工具链注意：

- Bun main 要求 LLVM 23.1.x；
- 本机使用缓存工具链 `/home/qaqtamsy/.cache/bugent-llvm/llvm-23.1.1`；
- LLVM release binary 依赖 ICU 70，缓存于 `/home/qaqtamsy/.cache/bugent-llvm/icu70`；
- `nasm` 缓存在 `/home/qaqtamsy/.cache/bugent-tools/nasm-3.02`；
- WebKit prebuilt 使用 gh-proxy 镜像下载到 Bun build cache。

## 10.2 Native sandbox + MCP（本次实现）

新增文件：

```text
native/sandbox/provider.c
native/sandbox/Makefile
native/sandbox/README.md
scripts/build-sandbox.ts
src/sandbox/policy.ts
src/mcp/stdio.ts
src/mcp/tools.ts
src/mcp/manager.ts
```

Linux provider 在 `apply()` 中只使用 syscall：

- `PR_SET_NO_NEW_PRIVS`；
- Landlock filesystem allowlist（deny by default）；
- `network=none` 时安装 seccomp filter，禁止 socket/socketpair/connect/bind/listen/accept/io_uring；
- 可选 `prlimit64` CPU / address-space / file-size / open-files / process limits；
- `close_range(3, ~0, CLOSE_RANGE_UNSHARE)`，只保留 stdin/stdout/stderr。

安全语义：

- MCP stdio 没有“无沙箱降级”路径；必须运行在 Bugent Bun fork 上，否则 fail closed；
- 默认工作区只读、私有 state 目录可写、断网、环境变量白名单；
- `workspaceWrite` 默认 false，可传 `true` 或显式路径数组；
- 读路径、写路径、执行路径均为显式能力；Landlock execute 以目录规则实现；
- Bun/JSC 启动需要读 `/proc`，因此默认 runtime read roots 含 `/proc`；这是有意的只读权衡；
- seccomp 不允许创建新 socket，但允许已有 fd 上的 stdio `recvfrom`/`sendmsg`，否则 Bun stdin 会收到 `EPERM`。

MCP 接线：

- `McpStdioClient` 实现 JSON-RPC stdio、initialize、tools/list、tools/call、超时/关闭和 stderr 诊断；
- `createMcpTool()` 把工具注册成 `mcp__<server>__<tool>`，所有调用仍必须经过 `ToolRegistry.execute()`；
- `McpManager` 负责 server 生命周期和工具快照 reload，并可同时挂接到多个 session runtime；
- `startConfiguredMcp()` 从 `[[mcp.servers]]` 启动 server，生成稳定 manifest；
- `createSessionRuntime()` 自动 attach/detach MCP registry；恢复旧 session 时保留 msgid1，不重写历史，只把变化的完整目录作为 developer delta 注入；
- `McpManager.onToolsChanged` 已接到 CLI：工具目录变化时按安全边界 enqueue developer delta；
- `/context` 会显示每个 MCP server 的工具数量、启用/停用状态，非 Linux 显示关闭原因；
- `/context` 二级菜单支持重载 MCP 工具、启停当前 session 的 MCP server；
- session 级启停持久化在 `session_mcp` 表（schema v9）；缺省视为启用；
- runtime 重建时 MCP client 复用，不重启 server；TUI 切换 runtime 会释放旧 registry attachment；
- `[[mcp.servers]]` 字段：`id/cmd/cwd/env/workspace_read/workspace_write/read/write/exec/network/state_dir/limits`；
- 非 Linux 平台配置 MCP 时明确返回“MCP 已关闭”，不会以无沙箱方式启动。

当前验证：

```text
bun test
# 514 pass / 0 fail

bun run typecheck
# clean
```

后续：

- 增加 session 级 capability grant 覆盖；MCP 进程必须按 grant fingerprint 分池，不能共享成权限并集；
- 在 `/context` 里增加 MCP server 的新增/删除入口；
- HTTP MCP 只做 endpoint allowlist、credential 隔离和 audit，不伪装成 OS 沙箱；
- 用同一 policy compiler 给 bash 增加 strict profile；bwrap 先保留兼容；
- Windows/macOS provider 暂未实现，当前 MCP 在这些平台明确关闭。

## 10.3 Skills

实现位置：

- `src/skills/loader.ts`：发现并解析 `SKILL.md`；
- `src/skills/tools.ts`：`skill__<name>__load` 工具适配；
- `src/skills/manager.ts`：catalog、registry attachment、reload、manifest/delta；
- `src/skills/runtime.ts`：从 `[skills]` 配置启动发现；
- `src/core/runtime.ts`：attach/detach、msgid2 快照与安全边界 delta。

语义：

- `SKILL.md` 必须有 YAML frontmatter 的 `name` / `description`；
- 正文只在模型调用 `skill__<name>__load` 时进入 tool result；
- 默认 roots：`~/.bugent/skills`、`~/.agents/skills`、项目内同名目录；
- roots 从低到高，项目覆盖用户；`disabled` 最后过滤；
- msgid2 只包含 tool 名和 description，不包含正文、绝对路径或环境值；
- `SkillManager.reload()` 原子替换 attached registry，并返回 added/removed 供 developer delta；
- skill loader 仍走 `ToolRegistry.execute()`，因此权限、并发锁、abort 和 ToolBatch 顺序一致。

配置：

```toml
[skills]
paths = ["~/.config/my-skills"]
disable_defaults = false
disabled = ["legacy-skill"]
```

## 10.4 旧 TUI 输入法光标与多行输入

旧 TUI 原先隐藏硬件光标，只用反显单元格模拟输入光标。IME 候选窗锚定的是
终端真实光标，因此候选窗会停留在上一帧末尾。

修复：

- 主输入框每帧通过 `Terminal.setCursor(row, column)` 把真实光标移动到逻辑插入点；
- 光标列由 `src/tui/input-view.ts` 统一计算，覆盖 CJK/emoji 宽字符和折行；
- 输入行不再绘制反显块，真实光标直接覆盖当前字符/空白；
- 弹窗打开时隐藏真实光标；
- `ask_user` 的自由文本输入也暴露逻辑光标位置，由同一套 dialog 坐标换算定位。

多行输入：

- `Ctrl+J`、`Alt+Enter` 插入换行；增强键盘协议下的 Shift+Enter 也映射为换行；
- 普通 `Enter` 仍然提交；
- 输入框固定 4 行视窗，按终端宽度自动折行，超过 4 行时跟随光标滚动；
- `Up/Down` 在多行/折行内容中移动视觉行，单行时仍保留历史滚动；
- bracketed paste 保留内部换行，不再折叠成空格；
- `Home/End` 按当前视觉行移动。

回归测试：

- `tests/input-view.test.ts` 覆盖多行、折行、CJK 宽字符和行列映射；
- `tests/tui.test.ts` 覆盖 Ctrl+J / Alt+Enter / 增强键盘协议；
- `tests/tui-pty.test.ts` 验证真实 PTY 中多行输入与一次提交；
- `tests/ask-user.test.ts` 验证输入态暴露硬件光标位置。

## 10.5 旧 TUI scrollback 拖动

主消息区最右列现在是滚动条：

- 轨道只覆盖主消息视口，不覆盖状态栏、输入框或历史抽屉；
- thumb 高度按 `viewportHeight / (viewportHeight + maxOffset)` 计算；
- `scrollOffset=0` 时 thumb 贴底并继续 follow tail，最大 offset 时贴顶；
- 点击轨道会把 thumb 中心移动到点击位置；
- 拖动 thumb 时保存 `grabOffset`，后续鼠标 motion 只按绝对 `y` 映射，不要求指针仍在轨道内；
- 拖动和滚轮、PageUp/PageDown 都最终走 `scrollMainView()`，不会出现条和 chat 状态分叉；
- 主区最大回看仍受三屏限制，更早内容继续通过历史抽屉查看。

实现：

```text
src/tui/scrollbar.ts      几何、命中、拖动映射、轨道合成
src/tui/app.ts            mouse capture / drag lifecycle / 同一 scrollOffset
tests/scrollbar.test.ts   纯数学与渲染回归
tests/tui-pty.test.ts     真实 SGR 拖动后 chat 到达“查看更多消息”
```

## 10.6 Agent activity spinner

菊花不再只代表 reasoning，而是代表 agent 是否仍在工作：

```text
idle          ○ idle（状态栏），思考区为空
waiting       ✻ 等待模型 · 连接模型 / 读取工具结果
thinking      ✻ 思考 · reasoning 尾部
responding    ✻ 生成回复
tool          ✻ 执行工具 · bash / mcp__... / skill__...
retrying      ✻ 重试 · 手动 retry / developer role 兼容性重发
disconnected  ✖ 已断开 · 真实错误文本
aborted       ■ 已中止 · 用户中断
```

状态来源：

- `#runTurn` 开始时进入 `waiting`；
- `onReasoning` / `onText` 切换 `thinking` / `responding`；
- `onAssistant` 清 reasoning buffer，但不清 agent activity；
- `onToolCall` 进入 `tool`，`onToolResult` 回到 `waiting`；
- 手动 retry 和 developer role 兼容性回退进入 `retrying`；
- catch / `reason=error` 进入 `disconnected`，abort 进入 `aborted`；
- turn 正常结束进入 `idle`。

因此 bash、MCP、skill load 等长时间工具执行期间，即使没有 reasoning，菊花仍持续动画；断线后菊花停止并保留红色 `✖ 已断开`，不会伪装成 idle。

## 10.7 buTUI experimental entry

已引入独立实验入口，现有 `src/tui` 仍为默认 UI，两套 UI 并行维护：

```bash
bun run butui
bun run butui:typecheck
```

目录：

```text
src/butui/
├── bunfig.toml
├── tsconfig.json
├── preload.ts
├── jsx-runtime.ts
├── main.tsx
└── README.md
```

约束：

- `src/butui` 已从 bugent 根 `tsconfig.json` exclude；
- 必须使用 `--conditions=browser`；
- 必须 preload `@butui/solid/plugin`；
- `jsxImportSource = "@butui/solid"`；
- 通过 sibling `/home/qaqtamsy/项目/buTUI` 的源码路径解析 `@butui/*`，不复制 buTUI 源码；
- `src/butui/vendor/solid-js` 只用于锁定 browser runtime，避免 Bun 错解析到 `solid-js` 的 server 构建；
- 最小工作状态已接入真实 `AgentSession`、`runUserTurn`、真实 `ToolRegistry`、权限/升档/联网授权、流式文本和工具事件；
- `bun run butui -- --mock` 可做无 key 冒烟；`Esc` abort 当前 turn；`Ctrl+C` 恢复终端。

下一步接入顺序：

1. `src/butui/bridge.ts` 继续扩展 branch / retry / undo；
2. 工具 diff 和 artifact；
3. MCP/session context 面板；
4. 命令面板和多页 ask_user。

buTUI 当前基线：

```text
bun --conditions=browser test
# 611 pass / 0 fail

bun --conditions=browser x tsc --noEmit
# clean
```

2026-09-24 修复了 `measureStreamNode` 的 committed/render cache 污染：tail 行定稿时不再丢结尾字符，也不会残留旧 tail 形成重复行。

## 11. 不要做的事

- 不要把所有消息塞进一个普通 FIFO。
- 不要依赖 hy4-preview-f 的宽容行为。
- 不要在 tool batch 中间注入 user / MCP / skill。
- 不要让 retry 通过队列额外注入 user message。
- 不要把 TUI `ThinkingBuffer` 当成协议 reasoning 存储。
- 不要绕过 `ToolRegistry.execute` 直接调 `tool.run`，否则会跳过资源锁与权限。
- 不要让新的写工具漏声明 resources；未声明时只会退化为整个 workspace 写锁。
- 不要提交 `scripts/xw-probe.ts` / `scripts/xw-probe2.ts`。

## 12. 常用命令

```bash
cd /home/qaqtamsy/项目/bugent

bun test
bun run typecheck

# 真实测试（只使用允许的模型）
bun run src/index.ts \
  -p '请调用 read_file 读取 package.json，然后用一句话告诉我 package name。' \
  -m openai/deepseek-v4.1-flash \
  --mode read-only \
  --yes
```

wbproxy：

```text
http://127.0.0.1:8787/v1
```
