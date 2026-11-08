# bugent WebUI v2 协议 spec（v0 草案）

> 协议侧 spec：定义 WebUI 前端与 bugent bridge 服务端之间的**唯一**通信契约。
> 前端实现（路由、组件、状态管理）见 `webui/`；本文只定义两端之间的一切。
>
> 与 v1 的关系：v1（`docs/ui-protocol-spec.md` + `src/protocol/types.ts` +
> `src/runtime/bridge.ts`）随 8a75ce6 一起删除。v2 恢复 v1 的全部设计原则，
> 并吸收 `docs/claude-agent-protocol-review.md`（下称"裁决文档"）B/C/D 组中
> 与传输无关的裁决。**传输已由用户裁决为 WebSocket**，覆盖裁决文档基本前提
> 里的"REST + SSE"（C5 随之改写为 WS cmd/reply，见 §13 映射表）。

## 1. 目标与非目标

**目标**

- 定义浏览器前端与 bridge 服务端之间的唯一通信契约；
- 事件从 `LoopHooks`（`src/core/loop.ts:38`）与 `PermissionGate`
  （`src/permission/gate.ts`）1:1 派生，不发明新语义；bridge 用 `combineHooks`
  （`src/core/loop.ts:162`）注入 adapter，不改 loop；
- 每事件带 session 内单调 `seq`；断线按 `lastSeq` 补发（裁决 B1–B7）；
- 权限 / 越界能力 / ask_user 的往返有明确 request-id 与三态结论；
- 前端类型不复制后端结构：`src/protocol/types.ts` 只 re-export core 类型
  + 定义信封/命令/事件联合类型，前端 `import type` 引用。

**非目标**

- 不定义持久化格式的变更（沿用 `src/store/`；事件日志 v2 在内存，见 §9）；
- 不覆盖 branch/retry/undo 操作（预留命令位，§4 预留表）；
- 不做 daemon 化（qaqh 线，用户已明确本轮不做；bridge 生命周期 = 进程生命周期）。

## 2. 传输与认证

- 单一 WebSocket 端点：`ws://127.0.0.1:<port>/ws`，由 `Bun.serve` 承载
  （`src/entry-webui.ts`）。默认端口 8787，`--webui-port` 覆盖。
- **一个连接承载多个 session**：信封 `sessionId` 决定路由；缺省视为协议层消息。
- 静态资源：生产模式同源托管 `webui/dist`（`Bun.serve` `static` 配置）；开发模式
  由 Vite dev server 承载并把 `/ws` 代理到 bridge。前端只见同源 `/ws`，无 CORS。
- 认证：bridge 启动时生成随机 token，写入 `~/.bugent/webui/<port>.token`
  （0600）并打印到 stdout；测试可用 `BUGENT_WEBUI_TOKEN` 固定。客户端首条消息
  必须是 `hello` 且携带 token；token 错误 → 服务端发 `error {code:"unauthorized"}`
  后关闭（close code 4401）。首个非 hello 消息同样处理。
- 消息一律 JSON 文本帧，UTF-8，单帧单消息。不做二进制帧（流量全是文本增量）。

## 3. 信封（envelope）

```jsonc
{
  "v": 2,                    // 协议版本（§11）
  "id": "m-018f...",         // 发送方消息 id（ULID/uuid），服务端原样回显
  "kind": "cmd" | "evt" | "reply",
  "type": "turn.send",       // 见 §4 / §5 注册表
  "sessionId": "s-018f...",  // session 级消息必带；evt 由服务端填写
  "seq": 42,                 // 仅 evt；session 内单调递增，从 1 开始（§9）
  "payload": { ... },
  "ts": 1730000000000        // 发送方毫秒时间戳
}
```

- `cmd`（上行）→ 服务端**必须**回一条 `reply`：`reply.id === cmd.id`，
  `payload` 为 `{ ok: true, ... }` 或 `{ ok: false, code, message }`；
- `evt`（下行）→ 无 reply，必带 `seq`；
- 同一 session 的事件流保证 **seq 有序**（到达顺序可能乱，前端按 seq 排序去重，B1）。

## 4. 命令注册表（上行）

| type | payload | reply | 说明 |
|---|---|---|---|
| `hello` | `{ token, client: "webui", protocolVersions: number[] }` | `{ ok, version }` | 必须是首条消息；服务端取双方支持列表交集的最大版本 |
| `session.list` | `{}` | `{ ok, sessions: SessionInfo[] }` | 本进程内的 session 列表 |
| `session.new` | `{ cwd?, title? }` | `{ ok, sessionId, ...SessionInfo }` | cwd 缺省用 bridge 启动目录 |
| `session.attach` | `{ sessionId, lastSeq? }` | `{ ok, state: SessionSnapshot }` | 见 §7；`lastSeq` 触发补发（§9.2） |
| `session.close` | `{ sessionId }` | `{ ok }` | 释放 runtime；活跃 turn 先 cancel |
| `turn.send` | `{ text: string }` | `{ ok, turnId }` | 同 session 同时只允许一个活跃 turn；重复发送 reply `code:"turn_busy"`。**幂等**：相同 cmd `id` 重复到达时重放缓存的 reply（B11，§6.2） |
| `turn.cancel` | `{}` | `{ ok, aborted: boolean }` | 映射 `AbortSignal`；幂等：无活跃 turn 也 ok |
| `permission.resolve` | `{ requestId, outcome: "approved"\|"denied" }` | `{ ok }` | 已被解决 → `code:"already_resolved"`（A5，§6.1）；不允许回 "timeout"（服务端结论，§6.3） |
| `permission.always` | `{ requestId }` | `{ ok }` | 向 session 的 `PermissionPolicy` 追加 allow 规则后按 approved 继续。**仅 `permission.request` 支持**（§6.4） |
| `ask_user.answer` | `{ requestId, answers: AskUserAnswer[] } \| { requestId, abort: true }` | `{ ok }` | `AskUserAnswer` = `src/core/ask-user.ts:23` |
| `extension_role.fallback` | `{ requestId, allow: boolean }` | `{ ok }` | 对应 `onExtensionRoleFallback`（provider 拒绝 developer role 时） |
| `history.before` | `{ sessionId, beforeMsgId, limit }` | `{ ok, messages: StoredMessage[], hasMore }` | 游标分页（D2/D3）：`beforeMsgId` 为界向更旧翻页；见 §10 |

预留（收到时 reply `ok:false, code:"not_implemented"`）：

| type | 说明 |
|---|---|
| `turn.send.attachments` | 图片/文件粘贴拖拽；bugent 尚无附件输入通道 |
| `branch.*` / `undo` / `retry` | 落库机制都在（`src/core/workspace-undo.ts`、branch-service），UI 通道后补 |
| `goal.*` | Goal 面板：快照里带摘要（§7），深度操作等 GoalController 暴露事件 |

## 5. 事件注册表（下行）

与 `LoopHooks` 的映射是**规范性**的。`turnId` 由 bridge 在每次 `runUserTurn`
（`src/core/loop.ts:228`）进入时生成；`blockId` 由 bridge 在 turn 内分配
（§5.1），前端按 block 渲染（C6/C7）。

| type | payload（关键字段） | 来源 |
|---|---|---|
| `turn.started` | `{ turnId }` | `runUserTurn` 进入 |
| `user.message` | `{ message: StoredMessage }` | `onUser`（落库后，含 msgid） |
| `text.delta` | `{ turnId, blockId, delta }` | `onText` |
| `reasoning.delta` | `{ turnId, blockId, delta }` | `onReasoning`。**不落库**：UI 不得持久化、刷新即失 |
| `assistant.message` | `{ message: StoredMessage }` | `onAssistant` |
| `tool.call_delta` | `{ turnId, blockId, call: {id,name}, argsDelta, rawArgs, args, reset? }` | `onToolCallDelta`；`reset=true` 表示 provider 重试，UI 丢弃 provisional 卡片 |
| `tool.call` | `{ turnId, blockId, call: ToolCall }` | `onToolCall` |
| `tool.progress` | `{ turnId, blockId, call: {id}, chunk, stream: "stdout"\|"stderr" }` | `onToolProgress`（仅展示；bridge 合并到 ~40ms/帧，C9） |
| `tool.result` | `{ turnId, blockId, call: ToolCall, result: ToolExecution, message? }` | `onToolResult`；`result.presentation` 为结构化展示（bash segments / diff） |
| `workspace.change` | `{ edit: WorkspaceFileEdit }` | ToolCtx `onWorkspaceChange`（含 bash 写盘记账；UI 只做"已修改"标记） |
| `permission.request` | `{ requestId, request: PermissionRequest }` | `PermissionGate` prompter（`src/core/runtime.ts:93` SessionInteraction） |
| `capability.request` | `{ requestId, call, escalation: CapabilityEscalation }` | `onRequestCapability`（loop.ts:76） |
| `ask_user.request` | `{ requestId, call, questions: AskUserQuestion[] }` | `onAskUser`（loop.ts:78） |
| `interaction.resolved` | `{ requestId, kind, outcome }` | bridge 广播：permission/capability/ask_user/extension_role 任一被解决（含断连默认 denied）后，所有观察者据此关卡片（A5） |
| `extension_role.fallback_request` | `{ requestId, error: string }` | `onExtensionRoleFallback`（loop.ts:87） |
| `usage` | `{ usage: Usage }` | `onUsage` |
| `session.state` | `{ mode, turnActive, goal? }` | bridge 在 turn 开始/结束、档位变化时发；`goal` 为摘要 `{ status, tokensUsed, tokenBudget }`（Goal 深度事件预留） |
| `todo.state` | `{ todos: [{ id, content, status }] }` | bridge 从 `todo_write` 调用入参派生（非独立 hook，v1 同款） |
| `turn.done` | `{ turnId, result: { text, toolCalls, steps, reason, usage } }` | `TurnResult`（loop.ts:104） |
| `turn.error` | `{ turnId, message }` | loop 抛错；之后**必须**有 `turn.done` 或连接级 error，UI 以先到者为准 |
| `error` | `{ code, message, fatal? }` | 协议层错误 |

类型来源（**协议类型只 re-export，不复制**）：`StoredMessage` = `src/core/message.ts:35`；
`ToolCallDelta`/`TurnResult` = `src/core/loop.ts`；`ToolExecution`/`CapabilityEscalation`
= `src/tools/types.ts:168/:31`；`ToolPresentation` = `src/core/presentation.ts`；
`AskUserQuestion`/`AskUserAnswer` = `src/core/ask-user.ts:14/:23`；`PermissionRequest`
= `src/permission/policy.ts:40`；`AuthorizationOutcome` = `src/permission/authorization.ts`；
`WorkspaceFileEdit` = `src/core/workspace.ts`。

### 5.1 消息归属与 block 模型（C6/C7）

v1 的教训：`text.delta` 等流内事件只带 turnId，前端只能"归属到当前 assistant
消息"，多轮工具交错时顺序错位。v2 规范：

- bridge 为每个 turn 维护块计数器；**新块**在以下时机开启：turn 开始后的第一段
  reasoning/text、每次 `onToolCall`（或首个 `tool.call_delta`）、`onAssistant`
  落库后的新一段文本。`blockId = "<turnId>#<n>"`，turn 内稳定；
- 同一块的所有增量事件携带同一 `blockId`；`assistant.message` 到达时，前端把
  对应 text 块定格为落库内容（以 `StoredMessage.msgid` 为准）；
- 一个 turn 内的渲染单位是有序块序列：`文本块 → 工具块 → 文本块…`，顺序 =
  事件到达顺序（seq 已保证）；
- `reasoning` 块是独立块类型，折叠展示，不落库。

## 6. 往返语义（request-id 流程）

`permission.request` / `capability.request` / `ask_user.request` /
`extension_role.fallback_request` 遵循同一模式：

1. bridge 生成 `requestId`，向**所有** attach 了该 session 的连接广播事件，挂起 Promise；
2. 任一连接回对应 resolve cmd，携带同一 `requestId`；
3. **first-wins**（A5）：第一个到达的结论生效；其余连接收到 reply
   `{ ok:false, code:"already_resolved" }` 并收到 `permission.resolved` 事件，
   前端据此自动关闭卡片。

### 6.1 多观察者（A4）

同一 session 允许多个连接 attach（v1 的 `session_taken` 限制废除）。所有连接收
同一事件流（各自有独立游标，§9.2）；写操作（resolve/answer/turn.send）任意连接
可发，按 §6 first-wins。前端不必区分"观察者/控制者"角色。

### 6.2 命令幂等（B11）

`turn.send` 以 cmd 信封 `id` 为幂等键：bridge 在 session 内维护最近 128 个
`(cmdId → reply)` 缓存；相同 `id` 重复到达时**重放缓存的 reply**，不再触发新
turn。其余命令天然幂等或无害（cancel 幂等；resolve 有 already_resolved）。

### 6.3 超时与断连

- v2 服务端**不主动超时**（TUI 的授权等待也是无界的；`AuthorizationOutcome`
  三态中 `timeout` 是服务端结论，UI 不允许回）；
- 连接断开：活跃 turn 继续跑完（结果落库）；挂起的 permission/ask_user Promise
  在**该 session 的所有连接都断开**时以 `denied` 处理（与用户拒绝同文案）——
  只要还有观察者在线就继续等（对 A1 的 WS 化）；
- 事件日志在内存环形窗口内（§9），断连不丢 seq。

### 6.4 "总是允许"（always）

- `permission.always { requestId }` → bridge 把该 request 的 `tool`(+`resource`)
  以 glob 形式追加为 session 级 allow 规则（需要 `PermissionPolicy` 暴露运行时
  `addRule` 入口，现有 `#rules` 私有），然后按 `approved` 继续；
- 规则只活在当前 session 进程内，不写盘、不跨 session；
- `capability.request` / `ask_user.request` **不支持** always —— 越界能力和提问
  按次授权是有意设计；UI 不得为它们渲染"总是允许"按钮。

## 7. 附加与快照（session.attach）

attach reply 的 `state: SessionSnapshot`：

```jsonc
{
  "sessionId": "s-...",
  "info": { "title": "...", "cwd": "...", "mode": "workspace-write", "model": "...", "providerId": "..." },
  "goal": { "status": "active", "tokensUsed": 12345, "tokenBudget": 100000 } | null,
  "messages": StoredMessage[],       // 尾部窗口：默认最近 200 条（D1 首屏只加载最新一段）
  "hasMoreHistory": true,            // 更旧的历史走 history.before（§10）
  "turnActive": true,
  "draft": {                         // 仅 turnActive 时（B7 续看）
    "turnId": "t-...",
    "text": "已累积的 assistant 文本",
    "reasoning": "已累积的 reasoning（不落库，快照内明文）",
    "tools": [{ "blockId": "t-...#2", "call": {...}, "argsSoFar": "..." }]
  },
  "lastSeq": 42                      // 快照对应的 seq；后续事件从 lastSeq+1 开始
}
```

- 快照整体带 `replay: true` 标记（payload 内字段），前端据此区分回放与 live，
  回放不触发动画/音效（v1 规则保留）；
- `tool.result` 的 `presentation` 已落库在 StoredMessage，回放时从 message 取，
  不靠事件（v1 规则保留）；
- **快照与增量无缝衔接**（B6/B7）：快照构造与事件推送在同一把 session 锁内完成
  ——先取快照、记下 `lastSeq`，再开始补发/直播；前端按 seq 去重，draft 文本与
  后续 `text.delta` 不缺字、不重复。
- **重连时的 draft 规则**：带 `lastSeq` 且补发窗口能覆盖当前 turn 全部事件时，
  快照 `draft` 为 `null`（前端用补发事件重建，不缺字不重复）；首次 attach 或
  `resync: true` 时才带 draft。

## 8. 断线重连与心跳

- **心跳**（B10）：服务端每 30s 向每条已认证连接发一帧应用层心跳
  `{kind:"evt", type:"heartbeat"}`（不带 seq、不入日志；未知 evt type 静默丢弃
  的规则保证旧客户端兼容）。前端对 `open` 状态超过 70s 无任何帧主动断开重连；
  服务端死连接由发送失败 + Bun idleTimeout 兜底。
- **自动重连**（B9）：指数退避（0.5s 起，×2，上限 15s）+ 随机抖动；重连成功后
  自动 `hello` → 对每个已 attach 的 session `session.attach { lastSeq }` 补发
  （§9.2）。UI 在重连期间显示明确的连接状态（connecting / offline / live）。
- **慢消费者**（A7）：每连接发送队列有界（默认 1MB 或 4096 帧）；超限 → 关闭
  （close code 1013 try-again-later）。**绝不因单个订阅者阻塞 agent loop**：
  bridge 向 WS 写入前先过每连接队列，队列由 WS 背压驱动；agent 侧永远只入队。
- 关闭码约定：4401 未认证；4409 session 冲突（保留位）；1013 慢消费者；
  其余 1000/1006 按 WS 语义。

## 9. 序号与事件日志

### 9.1 分配规则（B1/B2）

- 每 session 一个单调 `seq`，从 1 开始；bridge 在把事件写入该 session 的
  **内存事件日志之后**才向订阅者推送 —— 推出去的一定已入日志（B2）；
- 日志是环形窗口，默认保留最近 4096 条/ session；`session.close` 时释放；
- 进程重启日志即失（B8 持久化是 P1 后续：jsonl per session，重启后 lastSeq
  过旧自然落入 §9.3 降级路径）。重启后活跃 turn 不再存在（bridge 与进程同生共
  死），session 仍可 attach 看落库历史。

### 9.2 补发（B3/B4）

`session.attach { lastSeq }`：bridge 从日志取 `(lastSeq, now]` 的事件按序补发，
再切实时。B4 的"多 session lastSeq 映射"在 v2 下天然消解——前端对每个 session
各发一条 attach，无需单条汇总流的原生 Last-Event-ID。

### 9.3 降级（B5）

`lastSeq` 比日志最旧还旧（进程重启 / 窗口滑过）→ attach reply 改为
`{ ok: true, state, resync: true }`：快照即真相，前端丢弃本地未定格的 draft，
从快照重建（快照自带 `lastSeq`，衔接规则同 §7）。

## 10. 历史分页（D 组）

- `history.before { sessionId, beforeMsgId, limit }`：按 `StoredMessage.msgid`
  游标向更旧翻页（msgid 单调，天然游标；D2/D3）；reply 带页内消息（msgid 有序）
  与 `hasMore`。limit 上限 200；
- 首屏（attach）只给尾部窗口（§7），旧历史在滚动接近顶部时懒加载（D4/D5 前端
  责任：锚点保持不跳动）；
- 大内容（超长工具输出）：`ToolExecution.output` 已是服务端截断后的文本；结构化
  `presentation` 内含 diff/segments；D6 的按需展开接口预留（`block.content`，
  not_implemented）。

## 11. 版本化

- 信封 `v = 2`。**只做破坏性变更递增**；新增事件/命令类型不递增；
- 未知 type：cmd → reply `code:"unknown_command"`；evt → **静默丢弃**（前后端
  可各自加字段）；
- `hello` 协商：取双方 `protocolVersions` 交集的最大值；空交集 → 发
  `error {code:"version_mismatch"}` 后关闭。

## 12. 验收（协议侧）

1. `src/protocol/types.ts` 编译通过，且只 re-export 现有 core/permission/tools
   类型 + 信封/命令/事件联合类型（grep 检查无结构复制）；
2. hub 测试（`tests/webui-hub.test.ts`）：hello 认证（对/错 token）、seq 单调、
   lastSeq 补发、窗口滑过降级 resync、慢消费者关闭、turn.send 幂等重放、
   未知 cmd reply；
3. session-host 映射测试（`tests/webui-session-host.test.ts`）：对每个 LoopHooks
   钩子一条映射（mock session 触发 hook → 断言 evt 信封与 blockId 分配）；
4. 端到端 smoke（`tests/webui-e2e.test.ts`）：连 ws → hello → session.new →
   attach → turn.send(mock provider) → 按序收 §5 事件 → turn.done；cancel 路径、
   permission denied 路径、断线重连续看路径各一条；两 session 并行不串流；
5. 前端：`webui/` typecheck + build 通过；mock transport 与真实协议事件序列等价。

## 13. 与裁决文档的逐条映射

| 裁决 | 优先级 | v2 处理 |
|---|---|---|
| A1 断开后 turn 跑完 | P0 | §6.3：连接断开不 abort，结果落库 |
| A2 daemon 独立存活 | P0 | **不适用（用户裁决）**：bridge 与进程同生命周期；daemon 化归 qaqh 线 |
| A4 多前端同看不干扰 | P0 | §6.1：多连接 attach，独立游标 |
| A5 抢占 first-wins | P0 | §6：first-wins + `permission.resolved` 广播 + `already_resolved` |
| A6 待审批在快照可见 | P0 | §7 快照 `pending`（permission/ask_user 待决列表，attach 时可见） |
| A7 慢前端不拖垮后端 | P0 | §8：有界队列，超限 1013 断开重连 |
| A8 本机鉴权 | P1 | §2：token 文件 0600 + hello 携带 |
| A9 前端无密钥 | P0 | API key 只在 bridge 进程；协议无密钥字段 |
| A10 多 session 隔离 | P0 | 每 session 独立 runtime（`createSessionRuntime` 本就隔离）、独立 seq/日志 |
| B1–B7 seq/补发/续看 | P0 | §3/§7/§9 |
| B8 日志持久化 | P1 | §9.1 后续（jsonl per session） |
| B9/B10 重连/心跳 | P1 | §8 |
| B11 幂等 | P1 | §6.2 |
| C1 单流不分叉 | P0 | 单一 /ws，type 区分 |
| C2 历史不是流 | P0 | §7 快照 + §10 分页 |
| C3 统一信封 | P0 | §3 |
| C4 连接数与 session 数无关 | P0 | 一连接多 session，信封路由 |
| C5 操作走 REST | P1 | **被用户裁决覆盖**：WS cmd/reply 承担操作通道 |
| C6/C7 block 关联 | P0 | §5.1 blockId |
| C8 后端归一化 provider | P0 | loop/adapter 已做，协议只见归一化事件 |
| C9 delta 合并 | P2 | §5 `tool.progress` ~40ms 合并（对齐 TUI 节流）；text delta v2 不合并（首字延迟优先） |
| C10 版本号 | P1 | §11 |
| C11 两后端共用协议 | P1 | Rust 侧无；本文档即唯一 schema 准则 |
| D1–D5 首屏/分页/锚点 | P0/P1 | §7/§10（D5 前端责任） |
| D6 按需展开 | P1 | 预留 `block.content` |
| D7 虚拟化 | P1 | 前端：TanStack Virtual，v2 UI 接入 |
| D10 压缩可见 | P1 | 预留 `context.compacted` 事件（上下文压缩落地时加，非破坏性） |

## 14. 开放问题（留给实现）

- token 到达浏览器的开发体验：stdout 打印已定，是否加 `?token=` 一次性握手
  query（避免手抄）——倾向不做，token 文件 + 手动粘贴足够；
- `tool.progress` 合并是否扩展到 `text.delta`：等真实长会话观测渲染压力；
- 快照 `pending` 的结构细节（permission 与 ask_user 的统一形状）在实现
  session-host 时定，倾向 `{ kind, requestId, summary }[]`。
