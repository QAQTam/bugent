# 改动总览

从 `init` 到现在的全部改动。按「做了什么 → 为什么这么做 → 踩了什么坑」组织。

## 权限授权统一（未发布）

把「同一件事、两个工具、两种结果」收成一套语义，并给所有授权入口加上时限。
完整规范：`docs/permission-authorization-spec.md`。

### 问题：bash 被排除在闸门外

`write_file` 写工作区外会弹窗；`bash` 重定向写同一个路径只会得到
`Read-only file system`。根因不是漏接线 —— `src/tools/types.ts` 明确写着
"走沙箱的工具不用声明 `requires`，内核会挡住"。**这条推理只在 `read-only` 档成立**：
那一档本来就该硬挡。但 `workspace-write` 档的档位语义是"写工作区外 → 逐次批准"，
bash 却连申请的机会都没有，唯一出路是切到 `no-sandbox`（默认批准一切，含整个 `/` 可写）。

而那正是 `src/permission/mode.ts` 明令禁止的模式：**"越界走按次授权，不走升档"**。
bash 这条路径上，"按次授权"被降级成了"永久全量授权"。

### 做了什么

- **两层边界写进规范。** 进程内工具走第一层（调用前闸门，`requires` + `writesOutside`）；
  沙箱子进程走第二层（执行前静态判定 + 内核兜底）。两条路共用同一套按次授权语义。
- **新增 `src/sandbox/command-scan.ts`：执行前越界判定。** 纯函数，识别重定向、
  写命令（`sed -i` / `tee` / `cp` / `rm` …）、输出选项（`curl -o` / `dd of=` / `--output=`）、
  解释器 + 写信号（`open(f,'w')` / `writeFile` / `shutil.` …）。**命中就弹窗，命令根本不跑。**
- **批准后本次 argv 真放开。** `ShellRunOptions.writablePaths` → `buildSandboxArgv`
  逐个 `--bind`。目标不存在时绑**最近的已存在祖先目录**（`--bind` 要求源存在），
  范围写进弹窗。`read-only` 档批准写工作区时绑工作区本身。
- **新增 `src/permission/authorization.ts`：60 秒授权窗口 + 三态。**
  `approved` / `denied` / `timeout`，超时 = 拒绝（fail closed）。
  三个入口（`ask` 规则、越界按次授权、能力授权）全部接上；`onRequestCapability`
  的返回类型从 `boolean` 改成 `AuthorizationOutcome`，贯通 loop / TUI / CLI / butui。
- **TUI 弹窗带倒计时。** 三个入口共用 `TuiApp#authorize`：标题右侧 `· 还剩 47s`，
  走既有帧调度每秒重绘，归零自动关掉弹窗（否则用户回来按"允许"时模型早就按超时走了）。
- **回传模型可区分。** `用户拒绝操作` / `授权已超时（授权窗口内未收到确认）`。
  超时文案不带秒数 —— 窗口长度由实现方决定，闸门写死一个数字迟早对不上。

### 踩的坑

- **`--bind` 的挂载顺序。** 本次可写路径必须排在 `--tmpfs /tmp` **之后**，
  否则工作区落在 `/tmp` 下时会被 tmpfs 盖掉，报 `bwrap: Can't chdir to …`（实测）。
- **`/tmp` 是私有 tmpfs，但工作区可能就在 `/tmp` 里。** 一开始把 `/tmp` 直接从
  `writeTargets` 里剔掉，于是临时 worktree（cwd 在 `/tmp` 下）的 read-only 档
  永远不弹窗、也不绑工作区，命令直接 `chdir` 失败。正确做法是：**仍记进
  `writeTargets`，只从 `outsidePaths` 里排除**。
- **全局关键词兜底扫描会误报。** 先写了一版"命令文本里出现 mkdir/open/write 就问"，
  结果 `grep -rn "mkdir" src`、`git commit -m "fix open( bug"` 都会弹窗 ——
  关键词出现在引号里是常态。改成只对**解释器**这条分支生效，且 `open()` 必须带
  写模式（`open(f)` / `open(f,'r')` 是读）。
- **`-o` 的含义按命令不同。** `curl -o f` 是写文件，`ssh -o X` 是"给个选项"，
  `grep -o` 不接受参数。所以短选项查表，长选项（`--output`）才通用。
- **超时文案不能写死秒数。** 一开始在闸门里写 `（60 秒内未收到确认）`，
  但窗口长度由 TUI/CLI 决定（测试会覆盖成 2 秒），写死的数字必然和真实配置对不上。
- **顺带发现并修掉的既有 bug：`read-only` 档下工作区在 `/tmp` 里就全军覆没。**
  `--tmpfs /tmp` 会把工作区遮掉，而 `read-only` 档此前完全不绑工作区 ——
  于是 `--chdir` 找不到目录，**每一条 bash 命令都失败**，连 `echo hello` 都跑不起来。
  写"验证 read-only 档批准写工作区外"的用例时才暴露出来（因为那条用例把 cwd 放在
  `mkdtemp` 的 `/tmp` 下）。修法是无条件把工作区绑回来：可写档绑可写，只读档绑**只读**，
  且必须排在按次授权的 `--bind` **之前**，否则按次授权覆盖不掉它。

### 验证

```text
bun run typecheck                    # pass
bun test                             # 1110 pass / 1 skip / 0 fail（原 1030）
```

新增/改写的用例：

```text
tests/authorization.test.ts        14 例：三态 / 倒计时 / 无终端不干等
tests/command-scan.test.ts         45 例：越界 / 联网 / 反误报 / 绑定范围
tests/bash-authorization.test.ts   17 例：执行前拦、批准后真落盘、联网批准后真连上
tests/sandbox.test.ts              挂载顺序与 read-only 档的工作区存在性
tests/mode.test.ts                 事前拦截与事后兜底两条路径
tests/tui-pty.test.ts              PTY 端到端：倒计时弹窗、bash 越界弹窗
```

## 0.2.1 发布摘要

修掉权限模型里三处「声明了但没接线」——语义在类型层写得很完整，消费端只接了一半。
三处的根因都在 `06a32bb`（三档重构）或更早，`git log -S` 可逐条回溯。

- **档位改成「默认批准范围」，不再冒充能力边界。** 三档都能**自由读工作区之外**；
  档位只决定"哪些事不用问"。`ModeCapabilities` 的 `workspaceWrite` / `sandboxed` /
  `readOutside` 换成单个 `defaultApprove: "read" | "workspace-write" | "all"`。
  其中 `readOutside` 从 `06a32bb` 引入起**就没有任何消费者**（`git grep readOutside`
  在引入它的那个提交里也只有 3 处，全在 mode.ts 自己内部），所以"三档自由读"
  从来没有生效过。
- **越界走按次授权，不再"升档"。** 原来批准一次写盘会把 `read-only` **永久**改成
  `workspace-write` —— 实测第二次写入就不再询问，于是"每次写入都要提交用户审批"
  这句话彻底失效。现在批准只对这一次调用生效；档位只有用户主动切换才会变。
  TUI 的弹窗文案同步改成「批准这一次」。
- **写工作区之外有了授权通道。** 新增 `Tool.writesOutside(input, ctx)` 做**逐次**判定
  （静态的 `requires` 表达不了"这一次写到了哪"），闸门据此按次问用户，授权经
  `ToolCtx.grant` 下发到工具，由 `resolveForWrite` 决定路径解析宽度。
  在此之前 `resolveWithin` 直接抛 `PathEscapeError`，**闸门根本看不到这次调用**。
- **`no-sandbox` 不再关掉沙箱。** 它的语义是"默认批准一切、不拦截"，不是"去掉隔离"。
  bwrap 恒开；`no-sandbox` 用 `--bind / /` 叠加可写并放开网络，仍保留 pid 隔离、
  session 隔离、环境变量白名单与 `no_new_privs`。**这是行为变化**：`/tmp` 变成 tmpfs，
  跨 bash 调用的临时文件不再共享；环境变量按白名单过滤。
- **恢复 `--allow-network`。** `06a32bb` 的重构把 `SandboxConfig.allowNetwork`、
  `index.ts` 里的消费行、`builtin.ts` 的传参一起删了，只留下 CLI 解析 —— 开关成了死代码。
  补齐的同时把 `ToolsSetup.sandbox.networkBlocked` 暴露出来，让"这根线接没接上"
  可以被断言。**原来的测试直接调 `buildSandboxArgv`，绕过了接线，所以线上断了测试照样全绿。**
- **修掉 bash 落盘路径读不回来。** `bash.ts` 一直告诉模型
  `[use read_file on that path when you need the details]`，而 `read_file` 被
  `resolveWithin` 锁在工作区内 —— 每次输出超长，模型都会拿到一个自己读不了的死指针，
  然后反复重试、白白烧轮次。随"三档自由读工作区外"一并解决。
- **审计补记档位与本次授权。** `GateDecision.escalatedTo` 写进结构体但从没被审计层记录；
  换成 `granted` 并连同 `mode` 一起落审计 —— 只记"允许/拒绝"回答不了"这次为什么允许"，
  同样的 `tool + resource` 在不同档位下结论可能相反。
- 删掉 `isInsideOutputRoot`（`spill.ts`）：注释写着"read_file 的只读白名单判定"，
  同样零消费者。
- 测试：新增 `tests/permission-modes.test.ts`（20 例，断言到"文件真的落盘了吗"
  "沙箱真的还在吗"这一层，而不是断言返回值形状）；`tui-pty.test.ts` 里硬编码的点击
  坐标改成用 `rowOfIn()` 按内容定位 —— 档位 label 一变就会把 transcript 顶下去，
  写死的行号会点到空白。

## 0.2.0 发布摘要

- 输入框换成制表符框：默认 1 行内容，折行或 `Ctrl+J` 按需长高（最多 5 行）；
  左键点框内任意位置定位光标。输入框没有"激活 / 未激活"状态，点框外不会吞掉后续按键。
- 启动时用 OSC 11 查询 + `COLORFGBG` 判定终端底色，markdown 行内代码的底色不再
  取决于 Bun 进程启动时读到的那个环境变量；diff 增删两色降饱和（144 / 173）。
- 鼠标命中统一到**屏幕坐标**：渲染与命中共用同一张区域表，顺序即优先级。每帧
  可选自检（`BUGENT_HIT_PROBE=1` / `strict`）把每个可点区域自己的中心喂回命中
  入口，坐标类 bug 直接点名报错，不用再人工二分。
- 消息操作菜单改到**右键**打开；左键落在正文上是空操作。
- 所有可点按钮统一成描边矩形（`┌─┐ / │ 标签 │ / └─┘`，放不下时退化成 1 行的
  `▐ 标签 ▌`）：悬停换更亮的底色、按下-抬起才生效。
- 本轮用户消息滚出可视区后，正文区顶部常驻一行副本；正文里的用户消息不挪位、
  不塌陷，提交下一轮自动让位。
- 待办面板默认折叠成 3 行（标题 + 当前在做的那一项 + 展开按钮），点开看全部，
  展开后仍受 40% 高度上限约束。
- 思考区只保留菊花与思考尾部，去掉状态文字；「回到最新消息」出现时向正文借 1 行，
  菊花不被挤掉。
- 状态栏右上角的「● 运行中 / ○ idle」换成三项实时指标：**上下文占用**（最近一次请求
  的 prompt+completion ÷ 窗口，窗口按配置 → `GET /models` 自报 → 内置表取）、
  **会话累计缓存命中率**（`Σ cached / Σ prompt_tokens`，兼容 OpenAI / DeepSeek /
  Anthropic 三种字段名）、**瞬时输出速度**（3s 滑动窗口，思考 + 工具参数 + 正文三段
  都算）。速度用 DeepSeek 真 tokenizer 计数（`bun run tokenizer:fetch` 可选下载），
  没装则退回启发式估算并用服务端 usage 自校准。
- 提示词分层：工具 schema 只留「这个工具做什么」（短句 + 纯英文，24 个工具从
  ~3951 tok 降到 ~2998 tok），使用纪律（编辑、todo、提问、子代理、验证、沙箱现实）
  全部搬进 `src/prompts/system.md` —— 工具描述只在模型决定调用它时才被细读，纪律
  需要每一轮都在。配套 `scripts/prompt-lab.ts` 实验台：快照冻结 + 多变体对照 +
  Wilson 区间 / Fisher 精确检验，结论见 `docs/prompt-lab.md`。
- system prompt 补 `## Reasoning` / `## Answer` 两节，把"思考"和"回答"分开管：
  思考可以发散、鼓励用 `We need to ...` 陈述每一步、发现原地打转就停下转入行动；
  回答必须是短版本，不复述推理、不加前言、不提供没被要求的后续工作。实测（三道题
  × 每组 16-52 次）`We need` 从 13% 提到 54%，而**回答字数持平或更短**
  （hard2 任务 2734 → 1980 字）。
- `buTUI` 实验入口跟进 v0.2 帧运行时（ledger transcript、patch 卡片、跟随与分页修复）。

## 0.1.0 发布摘要

- `apply_patch` 完成 Codex 兼容的解析、上下文锚点、流式增量解析、多文件事务与 undo 集成。
- TUI 在模型仍在发送工具参数时，即显示 provisional `apply_patch` 卡片与实时 `+N -M`。
- freeform 与 JSON function-argument 两种 patch 输入均受支持，不改变现有 provider 隔离。
- `write_file` 覆盖文件时保留原权限。
- 单文件发布版本统一为 `0.1.0`。

## 概览

| | |
| --- | --- |
| 提交 | 21 个（1 个 init + 20 个功能/修复） |
| 变更量 | 81 个文件，+13500 行 |
| 源码 | 48 个文件 / 8242 行 |
| 测试 | 23 个文件 / 4282 行 / **334 个用例** |
| 脚本 | 2 个 / 202 行 |
| 运行时依赖 | **1 个**（highlight.js） |
| 开发依赖 | 2 个（`@types/bun`、`typescript@next` 的 tsgo） |

---

## 一、原始 10 个 Phase 的落地

| Phase | 状态 | 实现位置 |
| --- | --- | --- |
| P1 多 provider / endpoint 架构 | ✅ | `src/provider/types.ts` 归一化协议 + `registry.ts` + adapters |
| P2 msgid 上下文与缓存前缀 | ✅ | `src/core/message.ts` / `context.ts`，含逐字节前缀稳定性测试 |
| P3 bash 工具 | ✅ | `src/tools/bash.ts` |
| P4 最小 loop | ✅ | `src/core/loop.ts` |
| P5 config + TUI | ✅ | `src/config/` + `src/tui/` |
| P6 权限与沙箱 | ✅ | `src/permission/` + `src/sandbox/` |
| P7 文件工具 | ✅ | `src/tools/files.ts` |
| P8 markdown / 高亮 | ✅ | `src/tui/markdown.ts` + `highlight.ts` |
| P9 多 session | ✅ | `src/core/registry.ts` |
| P10 落盘与审计 | ✅ | `src/store/` |

---

## 二、超出 Phase 的功能

| 功能 | 提交 | 说明 |
| --- | --- | --- |
| `todo_write` 工具 | `c4a00c6` | 待办清单，sticky 面板实时显示三态 |
| 思考链路 | `ae1704b` | `reasoning_content` → 中间行滚动显示 |
| 工具输出折叠 | `ae1704b` | bash 5 行 / read_file 3+3 / diff |
| 鼠标交互 | `a61a675` | 点击展开折叠行、滚轮滚动 |
| 三档沙箱模型 | `06a32bb` | read-only / workspace-write / no-sandbox |
| 按次联网授权 | `06a32bb` | 先跑失败 → 带真实原因要授权 |
| 4 行输入面板 | `06a32bb` | 带底色的"阴影"区块 |
| `+N -M` 变更徽标 | `47f163f` | 从工具输出反解，右侧右对齐 |
| 长条目吸顶 | `783d89d` | 滚到底也能看到工具头部 |
| 代码高亮 | `8627c6a` | 三层设计 + 懒加载 |
| `ask_user` 工具 | `3698e29` / `8f334fe` | 多页问答表单 + 鼠标点击 |

---

## 三、三次架构级决策

### 1. 弃用 OpenTUI，贴着 Bun 原生能力自研 TUI（`f346bee`）

**触发点**：实测发现 `Bun.markdown.ansi` 自带 markdown→ANSI 与 ts/js 高亮，
`wrapAnsi`/`stringWidth` 解决折行与 CJK 宽度。

**结论**：OpenTUI 换来的只剩布局与组件，却要引入原生二进制 + 一层 Babel 转换。
**代价**：自研约 600 行（Screen 差分渲染 / KeyDecoder / Term）。
**收益**：运行时依赖长期保持为 0（直到代码高亮才引入第一个）。

后来进一步明确：OpenTUI 属于 anomalyco，而 opencode 是他们主推的竞品 ——
贴着它做等于把 TUI 层的演进节奏交给对手。

### 2. 不解析命令，让内核挡（`06a32bb`）

**问题**：read-only 档位下，`sed -i` / `python -c "open(...,'w')"` / `>` 重定向
怎么防？

**答案**：不防命令 —— 把工作区挂成只读，内核自然挡住一切写法。
`read-only` 与 `workspace-write` 在 bwrap argv 上只差一行 `--bind <cwd> <cwd>`。

**实测断言**（不是设计说明）：重定向 / `sed -i` / `python` / `tee` 四种写法
在 read-only 档下文件内容一个字节没变。

### 3. 档位即授权，弹窗只在越档时出现（`06a32bb`）

沙箱越严越不需要问：read-only 档下内核保证 bash 改不了任何东西，
所以 bash **自动放行**；`no-sandbox` 是用户主动选的，等于主动授权。

规则引擎降级为覆盖层，只用来加硬性禁令（`rm -rf /*`）或强制询问（`git push*`）。

**联网刻意不绑档位** —— 否则会为了联网丢掉文件系统隔离。它是按次授权：
命令先在断网沙箱里真跑一次，失败后带着**真实命令与报错**去问用户。

---

## 四、发现并修复的问题

### A. 只有真跑 PTY 才能发现的（3 个）

| 问题 | 根因 |
| --- | --- |
| TUI 只画一行 | PTY 里 `process.stdout.columns` 返回 **`0` 而非 `undefined`**，`?? 80` 兜不住 |
| 模型完全读不到用户输入 | TUI 直接调 `runTurn`，漏了 `appendUser` → 新增 `runUserTurn()` 让错误不可表达 |
| 两步 assistant 输出挤成一行 | 一次 `runTurn` 会产生多条 assistant 消息，共用了一个显示块 → 抽出 `Transcript` |

### B. 只有多进程才能发现的（1 个）

**4 个进程并发建库全部 `database is locked`**（`29daeea`）

两个叠加的根因：
1. `PRAGMA busy_timeout` 设在了 `journal_mode = WAL` **之后**，而切 WAL 本身要抢锁
2. Bun 的 `DatabaseOptions` **没有 `timeout` 字段**，传了会被静默忽略

修法：`busy_timeout` 提到最前 + 同步重试 + **真起 3 个进程做回归测试**。

### C. 类型系统抓到的（`6235119`）

`tsgo` 当场抓出 **16 个 Bun 跑得通但类型是错的**错误 —— 例如 `JSONSchema.type`
写死成 `"object"` 导致嵌套 schema 全挂。这是为什么 `bun test` 之外必须单独跑类型检查。

### D. 实测截图发现的界面问题（`6750175`）

| 问题 | 根因 |
| --- | --- |
| 回答提前换行 | `Bun.markdown.ansi()` 默认按 **80 列**折行，且参数名是 **`columns` 不是 `width`**（传 width 被静默忽略） |
| 输入框与底色分离 | `RESET` 会**连背景色一起清掉**，`▌` 后面的 RESET 把整行底色抹了 |
| 正文贴边 | 缺左侧留白 |
| 思考区 5 行太高 | 改成 3 行 |

### E. 实测边界发现的（`a686c75`）

`read_file` 对大文件**一刀切拒绝**，连 `offset=1&limit=10` 都不给。
判据是"文件大小"而不是"要读多少" → 改成流式读够就停。

33MB 文件：修复前拒绝，修复后 **1.1ms 读出前 276 行**。

### F. 代码高亮时顺带发现的（`8627c6a`）

**`Bun.wrapAnsi` 默认 `trim: true`，会剥掉行首空白。**
对散文无所谓，对代码是灾难 —— Python 的缩进就是语法。
而且影响面很大：`renderPlain` 走同一条路径，所以 bash 输出、read_file、diff
的缩进一直在被削掉。全项目只有一个调用点，一处修复覆盖所有渲染路径。

### G. 安全（`d93a91a`）

**API key 对沙箱内任意命令可读** —— `curl $OPENAI_API_KEY` 就能带出去。
文件系统隔离做得再好，这条通道不堵等于白做。

修法：环境变量**白名单制**（黑名单永远列不全）。

---

## 五、当前能力清单

### 工具（6 个）

| 工具 | 说明 |
| --- | --- |
| `bash` | 管道执行，超时/中断/输出截断，沙箱内运行 |
| `read_file` | 流式读取，行号 + offset/limit，二进制/目录检测 |
| `write_file` | 原子写（临时文件 + rename），出 diff |
| `edit_file` | 精确替换，不唯一时报错而非猜测 |
| `todo_write` | 待办清单，sticky 面板 |
| `ask_user` | 多页问答（≤5 题，选项 A~D + 自由回答） |

### 界面

- **TUI**：差分渲染（只重写变化的行）、思考链路滚动行、sticky 待办面板、
  4 行输入面板、工具输出折叠 + 吸顶、`+N -M` 徽标、鼠标点击/滚轮
- **CLI**：`--mode` / `--resume` / `--sessions` / `--mock` / `--yes` 等
- **WebUI**：未做

### 配置与数据

全部在 `~/.bugent/`：`config.toml`（TOML，带注释）、`sessions.db`（SQLite + WAL）、
`output/<session>/`（工具超长输出落盘）。

---

## 六、还没做的

| 优先级 | 项 | 说明 |
| --- | --- | --- |
| 🟡 | `openai-responses` / `anthropic-messages` adapter | 现在接不了 Anthropic 原生 API |
| 🟡 | WebUI | 原始小目标里有 |
| 🟡 | TUI 会话切换 | 只有 `/new`，回不去旧会话 |
| 🟢 | `sessions.title` | 列存在但从没写过 |
| 🟢 | `/help`、配置热重载 | |
| 🟢 | diff 一键收起全局配置 | |
| 🟢 | 权限弹窗支持鼠标 | `ask_user` 已支持，弹窗还是纯按键 |
| 🟢 | bash 输出流式截断 | 现在是读满 64KB 再截断 |

---

## 七、贯穿始终的两条经验

**1. 纯逻辑与 I/O 必须分开。**
`Screen` / `KeyDecoder` / `Transcript` / `AskUserFlow` / `PermissionPolicy` / `sliceViewport`
都是纯的，所以能单测。TUI 的 bug 全部是靠"把逻辑抽出来"才锁住的。

**2. PTY 冒烟不可省。**
上面 A 类问题（3 个）只有真起伪终端才暴露；B 类只有真起多进程才暴露。
单测直接调用内部函数是**绕过路由**的，永远测不出集成层的错误。
