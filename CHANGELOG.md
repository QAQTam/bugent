# 改动总览

从 `init` 到现在的全部改动。按「做了什么 → 为什么这么做 → 踩了什么坑」组织。

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
