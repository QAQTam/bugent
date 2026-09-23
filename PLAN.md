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
| TUI | **@opentui/core** | 原生 Zig 渲染、局部 diff 更新，天然满足 O(1) 更新诉求；比自研 ANSI 省 2~3 天，比 Ink 快得多。**自研 ANSI 渲染器仅作 fallback**（约 300 行） |
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
