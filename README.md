一个最大化利用bun最新版API的AI AGENT.
小目标：bun最新版+ts 7+TUI+WEBUI
Phase 1. 确立以多provider 多endpoint的架构设计，第一阶段直接隔离agentloop不知道endpoint类型的设计
Phase 2. 确立loop的上下文注入由message（msgid）标记，msgid0为systemprompt,此后按照上下文注入顺序依次排序，确保缓存命中优先（做足测试）
Phase 3. 新增bash工具
Phase 4. 完成最小loop
Phase 5. 设计config布局以及TUI设计，用bun自己的terminal api实现更合适。或者引入Ink：无论如何都要确保O（1）性能优化。做足测试
Phase 6. 开始设计权限管理和沙箱，首轮应该测试Linux下沙箱设计
Phase 7. 拓展write_file read_file edit_file工具
Phase 8. tui支持渲染markdown和代码高亮
Phase 9. 支持多session并行对话，先做一个实例一个新对话，考虑并发锁问题
Phase 10. 消息落盘，进行第一轮安全审计。

---

## 快速开始

```bash
# 安装当前 checkout 的 Bugent Bun fork 到 runtime/bun/
bun run runtime:install

# 可选：备份现有 ~/.bun/bin/bun 后替换为 fork
bun run runtime:install -- --global

bun install

# 无需网络与密钥，验证链路
bun run src/index.ts --mock -p "你好"

# 接真实模型（配置在 ~/.bugent/config.toml，首次运行自动生成）
bun run src/index.ts -p "写个 hello world"

# 交互式（自动进入 TUI，需要 TTY）
bun run src/index.ts

# 纯文本 REPL（不走 TUI）
bun run src/index.ts --plain

# 权限与沙箱
bun run src/index.ts --mode read-only         # 根只读 + 工作区只读 + 断网
bun run src/index.ts --mode workspace-write   # 根只读 + 工作区可写 + 断网（默认）
bun run src/index.ts --mode no-sandbox        # 不隔离
bun run src/index.ts --yes                    # 跳过所有规则检查（危险）

# 会话
bun run src/index.ts --sessions       # 列出已保存的会话
bun run src/index.ts --resume <id>    # 恢复会话继续聊
bun run src/index.ts --no-persist     # 不落盘

# 测试与类型检查
bun test
bun run typecheck

# 编译 0.0.0 单文件二进制与发布归档
bun run package:bugent
./dist/bugent/bugent-0.0.0-linux-x64/bugent --version
```

单文件二进制内嵌 system prompt 和 `libbugent-sandbox.so`。首次启动时把原生
provider 解包到 `~/.bugent/runtime/0.0.0/lib/`，因此 MCP 沙箱不依赖发布目录
旁边存在额外动态库。

TUI 内可用 `/new` 开一个全新对话（原会话仍在库里，之后可用 `--resume` 回去）。
输入框支持多行：`Enter` 发送，`Ctrl+J` / `Alt+Enter` 换行；超过 4 行时视窗跟随光标滚动。
主消息区右侧提供可拖动 scrollback 条，拖动时 chat 区域实时同步滚动。

### 配置与数据

全部放在 `~/.bugent/`：

| 路径 | 内容 |
| --- | --- |
| `~/.bugent/config.toml` | 配置（TOML，带注释，首次运行自动生成） |
| `~/.bugent/sessions.db` | 会话与审计记录（SQLite + WAL） |
| `~/.bugent/output/<session>/` | 工具的超长输出落盘，模型按需读取 |
| `~/.bugent/handoffs/<session>/<goal>/` | Living Handoff 与不可变 Epoch snapshots |

解析顺序：`~/.bugent/config.toml` → `./bugent.config.ts` → 环境变量。

最小配置：

```toml
default_model = "openai/deepseek-v4.1-flash"

[[providers]]
id = "openai"
endpoint = "openai-chat"
base_url = "http://127.0.0.1:8787/v1"
# 开启思考链路：实测该模型必须显式打开才会返回 reasoning_content
extra_body = { reasoning_effort = "high" }
```

## MCP 与 Skills

上下文按固定前缀只追加：

```text
msgid0  system prompt
msgid1  MCP catalog（存储为 system，默认以 developer 渲染）
msgid2  skills catalog（存储为 system，默认以 developer 渲染）
msgid3+ 对话与工具消息
```

MCP 工具命名是 `mcp__<server>__<tool>`。stdio server 在 Linux 上由 Bun
fork 的 `Bun.spawn({ sandbox })` + `libbugent-sandbox.so` 启动，默认工作区
只读、私有 state 可写、断网，且没有无沙箱降级路径。

Skills 使用标准目录结构：

```text
skills/review/
└── SKILL.md
```

`SKILL.md` 必须有 YAML frontmatter：

```markdown
---
name: review
description: Review code changes for correctness and regressions.
---

# Review

Read the diff, inspect tests, and report concrete findings.
```

msgid2 只包含 `name + description + skill__<name>__load`，正文只在模型匹配任务后
通过 load 工具进入 tool result。默认发现 `~/.bugent/skills`、`~/.agents/skills`
以及项目内同名目录；项目 skill 覆盖用户 skill。

```toml
[skills]
# paths = ["~/.config/my-skills"]
# disable_defaults = false
# disabled = ["legacy-skill"]

# [[mcp.servers]]
# id = "filesystem"
# cmd = ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."]
# workspace_read = true
# workspace_write = false
# network = "none"
```

MCP / skills catalog 变化不会改写旧 msgid，只在安全消息边界追加 developer delta。

## Goal Mode

高级 Goal Mode 的可落地方案见 [`docs/goal-mode-spec.md`](docs/goal-mode-spec.md)。

核心边界：

```text
Goal       最终目标与生命周期
Checkpoint 可验证的阶段结果
Plan       策略与阶段划分
Todo       当前 checkpoint 的执行清单
Evidence   完成依据
Review     独立验证
Handoff    上下文压缩
Epoch      刷新后的新上下文边界
```

Goal 完成必须经过最终审计，不能由最后一个 todo checkbox 直接决定。

P1 已接线：

```text
/goal <目标>     显式启动 Goal Contract 初始化
/goal status     查看状态，并可暂停 / 恢复
/goal pause      暂停
/goal resume     恢复
```

只有 `/goal` 会授予一次性的 `create_goal` 权限；普通对话不能自行创建 Goal。
创建后的 contract 作为 developer context 在 tool batch 结束后的安全边界注入。

P2 已接线：

- `update_plan` 原子创建 Plan revision + Checkpoint DAG，校验依赖无环。
- `todo_write` 在 Goal 模式下必须关联当前 Checkpoint。
- Goal Todo 标记 completed 必须提供 `completionEvidence`。
- Plan / Checkpoint / Todo 变化只追加 developer delta，不改写旧 msgid。

P3 已接线：

- `submit_checkpoint` 先跑确定性 verifier，再进入独立 review。
- Reviewer 使用全新 AgentSession 和只读工具集，不能写工作区。
- `approve` 仍须所有 acceptance criteria proven，且没有 high/critical finding。
- `changes_requested` 会把 Checkpoint 退回 active 进入 remediation。

P4 已接线：

- Living Handoff 的事实章节从 SQLite 重建，模型只能 patch 叙事章节。
- 每次成功 patch 产生新 revision，旧 revision 与 Epoch snapshot 不可变。
- `/goal continue` 在安全边界创建新 branch，并注入 goal/plan/todo/handoff seed。
- `get_handoff` 可读取 canonical 或指定 epoch 的 snapshot。

P5 已接线（实验性，默认 `auto_continue = false`）：

- 每个 Goal turn 记录 input/output/cached token 与 active time。
- 用户消息、排队消息和 `waiting_user` 始终优先于 continuation。
- 达到 token budget / provider usage limit 时停止自动推进。
- 连续 3 个 Goal turn 没有权威状态变化时进入 `blocked`。
- `max_consecutive_turns` 防止 continuation 无限循环。

## 当前进度

| Phase | 状态 | 说明 |
| --- | --- | --- |
| P1 多 provider / endpoint 架构 | ✅ | `src/provider/types.ts` 归一化协议；loop 层零 provider 依赖（有验收 grep） |
| P2 msgid 上下文与缓存前缀 | ✅ | msgid0 不可变、只追加、前缀指纹 + 逐字节稳定性测试 |
| P3 bash 工具 | ✅ | 管道执行（非 PTY），超时/中断/输出截断；执行层抽象为 `ShellRunner`，P6 沙箱直接替换 |
| P4 最小 loop | ✅ | `src/core/loop.ts`，含工具往返、maxSteps 防死循环 |
| P5 config + TUI | ✅ | config 可用；TUI 基于 **Bun 原生能力**自研（差分渲染 + raw mode，零第三方依赖） |
| P6 权限与沙箱 | ✅ | allow/ask/deny 三级策略；bwrap 沙箱（只读根 / 可写 cwd / 默认断网）；TUI 弹窗确认 |
| P7 文件工具 | ✅ | read_file / write_file / edit_file；路径约束挡住 `../` 与符号链接逃逸；写入是原子的 |
| P8 markdown / 高亮 | ✅ | `Bun.markdown.ansi` + `Bun.wrapAnsi` + `Bun.stringWidth`（代码高亮限 ts/js） |
| P9 多 session | ✅ | `SessionRegistry` + 并发锁：不同会话真并行，同一会话重复进入抛 `SessionBusyError`；TUI `/new` 开新对话；多进程共写同一库已回归测试 |
| P10 落盘与审计 | ✅ | bun:sqlite + WAL；消息即时落盘、`--resume` 恢复；审计流水含工具调用与权限决策 |

已实现：`openai-chat` adapter（覆盖 OpenAI 及所有兼容端点）、`mock` adapter、MCP stdio、Skills、Linux 原生 sandbox provider。
待实现：`openai-responses`、`anthropic-messages`。

## 权限模型：档位即授权

三档递进，**档位本身就是预先授权范围**：

| 档位 | 根 | 工作区 | 网络 | 进程隔离 |
| --- | --- | --- | --- | --- |
| `read-only` | 只读 | **只读** | 断 | bwrap |
| `workspace-write` | 只读 | 可写 | 断 | bwrap |
| `no-sandbox` | — | 可写 | 通 | 无 |

### 为什么 read-only 能挡住 `sed -i` 和 `python` 写文件

**因为不去解析命令 —— 让内核挡。** 把工作区挂成只读之后，`sed -i`、
`python -c "open(...,'w')"`、`>` 重定向、`tee` 全部撞上
`Read-only file system`。你没法枚举所有能写文件的程序，但内核只需要一条规则。

实测（`tests/mode.test.ts` 里是断言，不是说明）：

```
read-only 档：重定向写 / sed -i / python 写 / tee  → 文件内容一个字节没变
workspace-write 档：同样四种写法全部成功，但写工作区外仍被挡
```

### 弹窗只在"越档"时出现

**沙箱越严，越不需要问。** read-only 档下内核保证 bash 改不了任何东西，
所以 bash **自动放行**，不打断你；workspace-write 档下工作区就是声明的边界。
反过来 `no-sandbox` 是你主动选的，也就等于主动授权了。

`permissions.rules` 退居为**覆盖层**，用来加硬性禁令或强制询问：

```toml
[permissions]
[[permissions.rules]]
tool = "bash"
resource = "rm -rf /*"
decision = "deny"

[[permissions.rules]]
tool = "bash"
resource = "git push*"
decision = "ask"
```

### 联网：先跑、失败、带着原因要授权

网络**不绑在档位上**（否则会为了联网不得不丢掉文件系统隔离）。默认断网，
流程是：

```
模型调用 bash("npm install")
  ↓ 先在断网沙箱里真跑一次
失败：Could not connect to server
  ↓ 检测到是网络受限
弹窗：「这条命令因为沙箱断网失败了。允许联网后重跑吗？
       命令：npm install
       报错：curl: (7) Could not connect to server」
  ↓ 批准 → 保持沙箱，只放开这一次的网络，重跑同一条命令
  ↓ 拒绝 → 原始失败结果原样返回给模型
```

刻意**不做先行拦截**：那样用户看到的是一句没有上下文的"是否允许联网"，
根本不知道自己在批准什么。

### 输入面板

输入区是 4 行的带底色面板（第一行放内容，其余留白），不再是单薄的 `› ___`。

### 对话框

权限确认、能力授权、升档询问共用同一个对话框组件，按钮支持键盘与鼠标点击
（`src/tui/app.ts` 的 `#openDialog`）—— 将来加 `ask_user` 工具时，
只需要把自由文本输入接进同一个渲染路径，不用再动布局。

## 工具集

| 工具 | 说明 | 沙箱 |
| --- | --- | --- |
| `bash` | 执行 shell 命令，支持超时/中断/输出截断 | bwrap（只读根 / 可写 cwd / 默认断网） |
| `read_file` | 读文件，带行号，支持 `offset`/`limit` | 路径约束 |
| `write_file` | 原子写（临时文件 + rename），自动建父目录 | 路径约束 |
| `edit_file` | 精确字符串替换，不唯一时报错而非猜测 | 路径约束 |
| `todo_write` | 带 summary/id/completion 的待办清单，sticky 面板实时显示，进行中项带 shimmer | 无副作用，默认放行 |
| `ask_user` | 分页问答表单（最多 5 题，选项 A~D + 自由回答） | 无副作用，默认放行 |
| `skill__<name>__load` | 按需加载一个已发现 skill 的 `SKILL.md` 正文 | 固定只读 skill 文件，默认放行 |
| `mcp__<server>__<tool>` | 调用 MCP server 暴露的工具 | 独立进程，由原生 sandbox capability grant 约束 |

### 输出折叠

工具输出可能极长，屏幕只给固定几行，超出的部分折叠成「已忽略 N 行」：

| 工具 | 展示 |
| --- | --- |
| `bash` | 头 2 行 + `… 已忽略 N 行 …（点击展开）` + 尾 2 行（共 5 行）；运行中显示最新 6 行进度 |
| `read_file` | 头 3 行 + `… 已忽略 N 行 …` + 尾 3 行 |
| `write_file` / `edit_file` | diff（`+`/`-` 着色），**右侧右对齐 `+N -M` 统计徽标** |

`+N -M` 是从工具输出里**反解**出来的，不是额外字段：

```
⏺ edit_file demo.ts                                    +2 -3
已编辑 demo.ts（替换 1 处）
   line1
   line2
  -line3
  -line4
  -line5
  +新的一行
  +又一行
```

之所以能反解：`compactDiff` 只裁**未变更**的上下文行，`+`/`-` 一行都不少，
所以数出来就是真实增删数；而且不用维护"UI 看到的"和"模型看到的"两份数据。

> diff 的折叠**从开头截断**而不是头尾都留 —— 改动通常在中段，
> 头尾折叠会把最该看的东西藏起来。

**鼠标交互**：左键点折叠行展开/收起，滚轮滚动历史；权限、能力授权与升档弹窗的按钮也可直接点击。

> ⚠️ 开启鼠标追踪后，终端里的**拖拽选择文本会被接管**。需要复制文字时，
> 大多数终端按住 `Shift` 拖拽即可绕过（iTerm2 / Windows Terminal / GNOME Terminal 均支持）。

### 回传给模型的截断

| 工具 | 上限 | 超出时 |
| --- | --- | --- |
| `bash` | 3000 字符（头 7 : 尾 3） | 完整输出写入 `~/.bugent/output/<session>/<call>.txt`，结果里给出路径引导模型读取 |
| `read_file` | 500 行 **或** 9000 字符（谁先到算谁） | 提示用 `offset` 继续读；单行超长时截断该行本身 |

## ask_user：让模型会提问

模型遇到歧义时可以停下来问清楚，而不是猜。

```
┌────────────────────────────────────────────────────────────┐
│ 问题 1/3 · 单选 ──────────────────────────────────────────  │
│                                                             │
│ 你希望代码风格偏哪种？                                       │
│                                                             │
│ ▸ (●) A. 简洁直接                                           │
│   ( ) B. 详细注释                                           │
│   ( ) C. 函数式                                             │
│                                                             │
│ ↑↓ 选择  Enter 下一题  e 自定义  ←→ 翻页  鼠标点击可选择     │
└────────────────────────────────────────────────────────────┘
```

| 操作 | 键 |
| --- | --- |
| 选择 / 移动 | `↑` `↓`（单选直接生效） |
| 勾选（多选） | `Space`，或**鼠标点击** |
| 快捷选择 | `A`~`D` |
| 自定义回答 | `e` 进入输入态，`Enter` 确认 |
| 翻页 | `←` `→` |
| 提交 | 汇总页 `Enter`；汇总页点某题可跳回去改 |
| 中止 | `Esc` 两次（3 秒窗口内），返回 abort 给模型 |

- 默认**单选**；只有显式 `multiple: true` 才是多选
- 最多 5 题、每题最多 4 个选项 —— 超了说明模型该先自己调研
- 非 TUI 路径不提供问答界面，工具会明确告知模型"请自行判断"而不是静默失败

## 思考链路

模型返回的 `reasoning_content`（思考过程）会：

- 实时推给 TUI；
- 随 assistant 消息持久化；
- 进入下一轮上下文，供需要 reasoning replay 的 provider 回放；
- 不混入普通正文。

这是 provider 兼容性要求，例如 WorkBuddy 的 `hy4-preview-f` 在带
`tools + reasoning_effort` 时，会要求历史 assistant 消息携带 `reasoning`，
否则可能返回 400 `11155 reasoning_content_missing`。

OpenAI Chat adapter 默认回放 `reasoning`，可通过 provider 配置选择：

```toml
[[providers]]
reasoning_replay = "reasoning" # reasoning | reasoning_content | both | none
```

TUI 展示仍保持 O(1) 内存：只保留当前思考行，输入框上方固定预留 3 行，
思考占中间一行，超宽时横向滚动，右侧永远是最新字符。

```
✻ 思考 The riddle: "一个农夫有17只羊…        ← 菊花动画，超宽时滚动
```

菊花同时代表 agent 活动状态，而不只是 reasoning：

```text
✻ 等待模型 · 连接模型
✻ 思考 · reasoning 尾部
✻ 生成回复
✻ 执行工具 · bash
✻ 重试 · 重新请求
✖ 已断开 · 真实错误
■ 已中止 · 用户中断
○ idle
```

因此 bash、MCP 或 skill 长时间执行时，即使没有 reasoning，菊花仍会持续动画；
断线后会停止并保留红色错误状态，不会伪装成 idle。

遇到 `\n` 就销毁当前行重新开始。持久化的 reasoning 用于协议回放，不用于展开思考全文。

> `deepseek-v4.1-flash` 需要显式设置 `extra_body = { reasoning_effort = "high" }`
> 才会返回 `reasoning_content`；`glm-5.3-flash` 默认就有。

## 性能

SSE 解析（`bun run scripts/bench-sse.ts`）：

| 场景 | 结果 | 相对 300 tok/s 的余量 |
| --- | --- | --- |
| 突发 20 万条 | 878,675 tok/s | **2929×** |
| 节流 300 tok/s | 326 tok/s，无积压 | 1.1× |
| 超大 delta | 333 MB/s | — |

`tests/sse-perf.test.ts` 用低得多的门槛（30×）做回归，目的是发现数量级退化，
而不是卡 CI 的毫秒数。

`todo_write` 的三态用**纯 ASCII 等宽标记**渲染，避免花体字符在不同终端里宽度不一致。
清单支持计划级 `summary`、稳定 `id` 和完成项 `completion`：

```
待办 · 重构 todo 状态模型                          2/4 · 进行中 1
  [x] 读 src/core/loop.ts — 已确认 loop 边界
  [x] 重构 Transcript — 338 tests pass
  [>] 正在补单测
  [ ] 跑 typecheck
```

`in_progress` 使用独立颜色，并在当前 turn 内叠加一道从左向右流动的 shimmer；
turn 结束后即使模型忘了收尾，动画也会停止，只保留静态的进行中状态。

全部完成后，清单会保留到当前 turn 结束；下一次真实用户消息出现时自动隐藏。
如果新 turn 里再次调用 `todo_write`，则显示新的清单。

## 加一个新工具要改什么

普通工具（无状态、无需自定义外观）：**1 个新文件 + `builtin.ts` 加 1 行**。

core / provider / TUI / 权限 / 存储 / 沙箱全都不用动 —— 可以用
`grep -rn '"bash"' src/` 验证：工具名在 `src/` 里零硬编码。

工具可以自报两件事，避免去改公共模块：

| 声明 | 作用 |
| --- | --- |
| `describe(input)` | **必填**。告诉权限系统这次动的是什么资源（bash 报命令、文件工具报路径），否则用户的 `{tool, resource}` 规则永远匹配不上 |
| `needsSandbox` | 标记需要沙箱；组装时会检查并明确告知"哪些工具在裸奔" |
| `defaultPermission` | 自报默认权限（如 `todo_write` 无副作用 → `allow`）；**用户显式规则优先级更高** |

需要自定义外观的工具（像 `todo_write`）额外在 `src/tui/renderers-builtin.ts`
注册一个 renderer；TUI 核心依然不认识任何工具名。

> ⚠️ 组装权限策略时记得带上工具自报的规则，否则"无副作用工具自动放行"会失效：
> ```ts
> new PermissionPolicy(composePolicy(config.permissions, setup.defaultPermissionRules))
> ```

## 开发辅助

```bash
# 把 TUI 输出流还原成"最终整屏"，调试差分渲染用
# （差分渲染只重写变化的行，直接看输出是一堆碎片，看不出屏幕最终长什么样）
bun run scripts/replay-ansi.ts <捕获文件> [行数] [列数]
```

完整方案见 [PLAN.md](./PLAN.md)。