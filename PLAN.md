# bugent 实施方案（快速版）

> 目标：用最少返工把 README 里的 10 个 Phase 全部落地成可运行 v1。
> 原则：**先垂直打通关键路径，再横向补能力**；能用现成的绝不自己造。

---

## 0. 环境事实（已验证）

| 项 | 值 |
| --- | --- |
| Bun | 1.4.2（`Bun.spawn` / `Bun.$` / `Bun.Terminal`(PTY) / `Bun.SQL` / `Bun.secrets` / `Bun.WebView` / `Bun.serve` 全在） |
| Node | v26.9.0（仅作兼容参考，不依赖） |
| TS 7 | `@typescript/native-preview@7.0.0-dev.20260707.2`（`tsgo`，只做类型检查） |
| 系统 | Arch Linux x86_64（沙箱走 bwrap 最顺） |
| TUI 库 | `@opentui/core@0.5.12`（Zig 原生渲染器，Bun 原生，支持 markdown/代码高亮） |

---

## 1. 技术选型（决定性结论）

| 议题 | 选择 | 理由 / 替代 |
| --- | --- | --- |
| 运行时 | **Bun 1.4.2** | 直接跑 TS、内置 SQLite/PTY/Serve，零构建 |
| 类型检查 | **tsgo（TS7 native）** | 只做 `--noEmit` 校验；Bun 运行时是**擦除类型**，所以 tsconfig 开 `erasableSyntaxOnly`，禁用 `enum`/`namespace`/参数属性，避免"本地过、Bun 挂" |
| TUI | **Bun 原生自研** | `Bun.markdown.ansi` / `Bun.wrapAnsi` / `Bun.stringWidth` / `Bun.color` 已经覆盖了内容格式化的难点，剩下的布局与渲染自研约 400 行，换来零第三方依赖。~~@opentui/core~~ 曾评估：需引入原生二进制 + Babel 转换，收益不足以抵消成本 |
| WebUI | **Bun.serve + HTML imports** | 零打包零配置，前端直接 import TS/TSX |
| 配置 | **`bugent.config.ts`** | Bun 原生 import TS，比 JSON 强（有类型、可写逻辑） |
| 持久化 | **`bun:sqlite` + WAL** | 内置、同步、够快；单写连接 |
| 沙箱 | **bubblewrap (`bwrap`)** | Linux 落地最快、审计面小；`landlock` 需 native addon，放 v2 |
| 测试 | **`bun test`** | 内置，snapshot 支持好 |

---

## 2. 目录结构

```
bugent/
├─ src/
│  ├─ index.ts                 # CLI 入口（TUI / --headless / serve 三种模式）
│  ├─ config/
│  │   ├─ schema.ts            # Config 类型 + defineConfig()
│  │   └─ load.ts              # 加载 bugent.config.ts + 环境变量覆盖
│  ├─ core/
│  │   ├─ message.ts           # StoredMessage / MsgId / ContentPart
│  │   ├─ context.ts           # 上下文构建 + 缓存前缀稳定性保证
│  │   ├─ loop.ts              # agent loop（唯一"大脑"）
│  │   └─ session.ts           # AgentSession（msgid 序列 + abort + 状态机）
│  ├─ provider/
│  │   ├─ types.ts             # ★ 归一化协议：ModelClient / ChatRequest / ChatChunk
│  │   ├─ registry.ts          # provider+endpoint -> ModelClient
│  │   └─ adapters/
│  │      ├─ mock.ts           # 测试用，无网络
│  │      ├─ openai-chat.ts
│  │      ├─ openai-responses.ts
│  │      └─ anthropic.ts
│  ├─ tools/
│  │   ├─ types.ts             # Tool 接口 + JSONSchema
│  │   ├─ bash.ts              # Phase 3（走 Bun.Terminal/PTY）
│  │   ├─ read_file.ts         # Phase 7
│  │   ├─ write_file.ts        # Phase 7
│  │   └─ edit_file.ts         # Phase 7
│  ├─ sandbox/
│  │   ├─ bwrap.ts             # Phase 6：拼 bwrap 参数、降级策略
│  │   └─ permission.ts        # allow/ask/deny 规则匹配
│  ├─ tui/
│  │   ├─ app.ts               # opentui 根组件
│  │   ├─ components/          # 输入框、消息流、权限弹窗、状态栏
│  │   └─ markdown.ts          # Phase 8：markdown + 代码高亮
│  ├─ server/
│  │   └─ index.ts             # Phase 5/9：Bun.serve + WebSocket 广播
│  ├─ store/
│  │   └─ db.ts                # Phase 10：bun:sqlite schema + DAO
│  └─ util/                    # id、abort、日志、错误
├─ tests/
├─ bugent.config.ts
├─ package.json  tsconfig.json  bunfig.toml
```

---

## 3. 核心抽象（先定死，后面全靠它省时间）

### 3.1 Provider/Endpoint 隔离（Phase 1 的灵魂）

Agent loop **只认归一化类型**，永远不 import 任何 adapter：

```ts
// provider/types.ts —— loop 只依赖这一个文件
export type Role = "system" | "user" | "assistant" | "tool";
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string };

export interface ChatMessage {
  role: Role;
  parts: ContentPart[];
  toolCallId?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  signal: AbortSignal;
}

export type ChatChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; argsDelta: string }
  | { type: "usage"; in: number; out: number; cached?: number }
  | { type: "done"; reason: "stop" | "tool_calls" | "length" };

export interface ModelClient {
  readonly id: string; // `${provider}/${endpoint}/${model}`
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
}
```

**endpoint 类型 = adapter 实现**：`openai-chat` / `openai-responses` / `anthropic-messages`。
`registry.ts` 按 `provider.endpoint` 选 adapter，把 config + key 注进去，返回 `ModelClient`。
→ loop 对 endpoint 类型**完全无感**，新增 provider = 新增一个 adapter 文件。

### 3.2 消息与 msgid（Phase 2）

```ts
export type MsgId = number;               // 0 起，严格递增
export interface StoredMessage {
  msgid: MsgId;
  role: Role;
  parts: ContentPart[];
  toolCallId?: string;
  origin: "system" | "user" | "tool" | "assistant" | "inject";
  createdAt: number;
}
```

铁律（保证缓存命中）：
1. **msgid0 = system prompt**，会话内不可变。
2. **只追加，不修改历史**（append-only）。任何"注入"都是新增 msgid，绝不插队、绝不改写旧消息。
3. 上下文构建 = `[msgid0] + 其余按 msgid 升序`，**确定性**输出。
4. 每轮记录 `prefixHash`（对已冻结前缀做哈希）；测试断言：**只改尾部时 prefix 序列化后字节完全一致**。

### 3.3 Tool 接口（Phase 3/6/7 共用）

```ts
export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  schema: JSONSchema;                     // 由 adapter 转各家格式
  needsSandbox?: boolean;
  run(input: I, ctx: ToolCtx): Promise<O>; // ctx 带 signal / cwd / 权限回调
}
```
权限与沙箱**包裹在 `run` 外层**（装饰器式），工具本身保持纯净 → P3 写完，P6/P7 直接复用。

### 3.4 Loop（Phase 4）

```
build context -> client.chat(stream) -> 推给 UI
  ├─ 有 tool_call：权限校验 -> 沙箱执行 -> append tool 消息 -> 回到 build context
  └─ 无 tool_call：done
```
**唯一有状态的是 AgentSession**，loop 是纯函数式推进（可单测、可用 mock adapter 跑）。

---

## 4. Phase 落地表（交付物 / 验收 / 工期）

> 工期按"人+AI 结对"估算，单位：天。

| Phase | 交付物 | 验收标准 | 工期 |
| --- | --- | --- | --- |
| **P1 架构** | `provider/types.ts` + `registry.ts` + `mock.ts` + `openai-chat.ts` | mock adapter 能跑通一次对话；loop 代码里搜不到任何 adapter 名 | 1 |
| **P2 msgid** | `core/message.ts` + `core/context.ts` + 测试 | 改尾部时前缀快照字节一致；msgid0 不可变断言通过 | 0.5 |
| **P4 最小 loop** | `core/loop.ts` + `core/session.ts` + headless CLI | `bugent -p "..."` 能多轮 tool-calling 跑通 | 1 |
| **P3 bash** | `tools/bash.ts`（PTY） | 能跑 `ls`/长命令/超时中断，输出回流到模型 | 0.5 |
| **P5 config+TUI** | `config/*` + `tui/*` + `server/index.ts` | TUI 能连续对话；WebUI 能在浏览器看同一 session | 2 |
| **P6 沙箱+权限** | `sandbox/bwrap.ts` + `permission.ts` + TUI 弹窗 | bash 被限制在 workspace，网络可关；ask 能拦住 | 1.5 |
| **P7 文件工具** | `read/write/edit_file.ts` | edit_file 精确替换；路径越界被拒 | 1 |
| **P8 渲染** | `tui/markdown.ts` | markdown + 代码高亮 + 流式不闪 | 1 |
| **P9 多 session** | `SessionRegistry` + 并发锁 | 3 个 session 并行对话互不串扰 | 1 |
| **P10 落盘+审计** | `store/db.ts` + events 表 | 重启可恢复上下文；tool 调用/权限决定可回放 | 1.5 |
| | | **合计** | **≈11 天** |

**关键路径**：`P1 → P2 → P4` ≈ **2.5 天**，这时就已经有一个能用的 agent 了。之后每个 Phase 都是独立增量，可并行。

---

## 5. 加速策略（省时间的具体手段）

1. **P1 先用 mock adapter 打通全链路** —— 不接真 API 就能测 loop，P2/P4 不被网络阻塞。
2. **垂直切片优先**：P1→P2→P4 做出"最小可跑 loop"，尽早拿到端到端反馈。
3. **TUI 用 opentui，不自研** —— 直接省 2~3 天，且性能达标。
4. **沙箱用 bwrap 子进程** —— 不写 native，不改 Bun。
5. **WebUI 用 HTML imports** —— 无打包、无 HMR 配置。
6. **工具只做 4 个**（bash/read/write/edit）—— 够验证架构，其余 v2 加。
7. **adapter 只做 3 个**（openai-chat / openai-responses / anthropic）—— 覆盖 95% 场景。
8. **测试只保底两处**：P2 的前缀稳定性、P6 的沙箱越界。其余靠手动验。

**极速版（≈6~7 天）**：砍 P5 的 WebUI、P8 高亮、P10 审计回放，先跑通 TUI + 沙箱 + 持久化。

---

## 6. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 各家 tool-call 流式格式差异大 | adapter 返工 | 归一化 `ChatChunk` 先定死，mock 覆盖三种流式形态 |
| `erasableSyntaxOnly` 约束写法 | 编译期报错 | tsconfig 开启，CI 加 `tsgo --noEmit` |
| bwrap 在部分内核/容器受限 | 沙箱不可用 | 启动探测，不可用则降级为"权限确认 + cwd 限制"并警告 |
| opentui 学习成本 | P5 卡壳 | 先做 headless CLI（P4 已可用），TUI 不阻塞主流程 |
| 多 session 写 SQLite 竞争 | 数据错乱 | WAL + 单写连接 + 每 session 独立事务 |

---

## 7. 建议执行顺序

```
P1 ──► P2 ──► P4 ──┬─► P3 ──► P6 ──► P7
                    └─► P5 ──► P8
                              └─► P9 ──► P10
```
即：**先搭骨架（P1/P2）→ 跑通最小 loop（P4）→ 再并行铺工具链（P3/P5）→ 补安全与体验（P6~P8）→ 收口并发与持久化（P9/P10）**。

---

## 8. 实施复盘（10 个 Phase 落地后回填）

### 与原计划的三处偏离

| 原计划 | 实际做法 | 原因 |
| --- | --- | --- |
| TUI 用 `@opentui/core` | **Bun 原生自研** | 实测 `Bun.markdown.ansi` 已自带 markdown→ANSI 与 ts/js 高亮，`wrapAnsi`/`stringWidth` 解决折行与 CJK 宽度。OpenTUI 换来的只剩布局与组件，却要引入原生二进制 + 一层 Babel 转换，性价比不成立。最终**运行时依赖为零** |
| bash 工具走 `Bun.Terminal` PTY | **管道（非 PTY）** | 工具输出最终喂给模型，PTY 会掺入 `\r\n`、ANSI 转义、stdout/stderr 交织，对 LLM 全是噪声。交互式命令本就不是 agent 工具的职责。执行层抽成 `ShellRunner`，将来要 PTY 直接换 |
| 先 P9 后 P10 | **先 P10 后 P9** | session 注册表天然要建立在存储之上；先有 store 再有多会话更顺 |

### 真实踩到的坑（都是"只跑单测发现不了"的类型）

1. **PTY 里 `process.stdout.columns/rows` 返回 `0` 而非 `undefined`**
   `?? 80` 兜不住，屏幕被压成 1×1，TUI 只画一行。必须用 `||`。
   —— 只有真起 PTY 跑才会暴露。

2. **TUI 从来没把用户消息写进 session**
   直接调 `runTurn` 漏了 `appendUser`，模型完全读不到用户输入。
   修法不是补一行，而是新增 `runUserTurn()` 把这一步收进 API，让错误不可表达。

3. **一次 runTurn 的多条 assistant 消息被拼进同一个显示块**
   "我来看看目录。命令执行完毕。" 挤在一行。
   修法：抽出纯逻辑的 `Transcript`，`onAssistant` 负责断开流式块，并加单测。

4. **多进程并发建库必然 `database is locked`**
   两个叠加的根因：`busy_timeout` 设在了 `journal_mode = WAL` 之后（而切 WAL 本身要抢锁）；
   且 Bun 的 `DatabaseOptions` **没有 `timeout` 字段**，传了会被静默忽略。
   修法：`busy_timeout` 提到最前 + 同步重试 + 真起多进程做回归测试。

5. **`Bun.wrapAnsi` 默认只按空格断行**
   中文没有空格 → 完全不折行。必须传 `{ hard: true }`。

6. **SIGKILL 后 Bun 只给 `exit code: 137`，`signalCode` 是 null**
   不自己记录 `timedOut` / `aborted`，模型就分不清"命令自己退出"还是"被我们杀了"。

### 经验

- **纯逻辑与 I/O 必须分开**：`Screen` / `KeyDecoder` / `Transcript` / `PermissionPolicy` 都是纯的，所以能单测；TUI 的 bug 全部是通过"把逻辑抽出来"才锁住的。
- **PTY 冒烟不可省**：三个 TUI bug 里有两个只有真起伪终端才会暴露。
- **`bun test` 通过 ≠ 类型正确**：`tsgo` 当场抓出 16 个 Bun 跑得通但类型错的错误（例如 `JSONSchema.type` 写死成 `"object"`）。
- **验收标准要可执行**：P1 的"loop 层零 provider 依赖"是用 `grep` 验的，不是嘴上说的。
