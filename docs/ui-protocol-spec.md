# bugent UI 协议 spec(v0 草案)

> 协议侧 spec。WebUI 具体实现(路由、组件、状态管理)由另一份 spec 负责;本文只定义**两端之间的一切**。
> 目标读者:WebUI / Electron 实现者、`src/runtime/bridge.ts`(headless runtime)实现者。

## 1. 目标与非目标

**目标**

- 定义 UI(WebUI / Electron / 未来 buTUI GUI)与 bugent headless runtime 之间的**唯一**通信契约;
- 从 `LoopHooks`(`src/core/loop.ts`)与 `PermissionGate`(`src/permission/gate.ts`)1:1 派生事件,不发明新语义;
- 权限 / 越界能力 / ask_user 的往返有明确的 request-id、超时与三态结论;
- Electron 与 WebUI 共享同一份协议,Electron 不引入额外消息类型。

**非目标**

- 不定义传输层内部实现(由 WebUI spec 决定框架);
- 不定义持久化格式(沿用 `src/store/`);
- 不覆盖 MCP context panel、branch/retry/undo(仅预留命令位,见 §4 预留表)。

## 2. 传输与认证

- 单一 WebSocket 端点:`ws://127.0.0.1:<port>/ws`,由 `Bun.serve` 承载(PLAN.md P5)。
- **一个连接承载多个 session**(对齐 WebUI spec 的标签页模型:每个标签 = 一个 session,互相独立)。信封里的 `sessionId` 决定路由;缺省 `sessionId` 的 cmd/evt 视为协议层消息,不属于任何 session。
- 服务启动时生成随机 token,UI 通过首条 `hello` 消息携带;首个非 `hello` 消息、或 token 错误 → 服务端发 `error` 后关闭(code 4401)。
- 仅绑定 127.0.0.1。Electron 主进程负责 spawn server 并把 token 交给 renderer(preload 注入)。
- 消息一律 JSON 文本帧,UTF-8,单帧单消息。不做二进制帧(v0 流量全是文本增量,不值得)。

## 3. 信封(envelope)

每个消息都有统一信封:

```jsonc
{
  "v": 1,                  // 协议版本,整数。协商失败服务端立即关闭
  "id": "m-018f...",       // 发送方生成的消息 id,ULID/uuid 均可,服务端原样回显
  "kind": "cmd" | "evt" | "reply",
  "type": "turn.send",     // 见 §4/§5 注册表
  "sessionId": "s-018f...",// 可选。session 级消息必带;evt 由服务端填写,cmd 由 UI 填写
  "payload": { ... },
  "ts": 1730000000000      // 发送方毫秒时间戳
}
```

- `cmd`(上行)→ 服务端**必须**回一条 `reply`,`reply.id === cmd.id`,`payload` 为 `{ ok: true, ... }` 或 `{ ok: false, code, message }`;
- `evt`(下行)→ 无 reply。事件流保证**同轮内有序**;
- `hello` 是唯一的握手 cmd(§4)。

## 4. 命令注册表(上行)

| type | payload | reply | 说明 |
|---|---|---|---|
| `hello` | `{ token, client: "webui"\|"electron", protocolVersions: number[] }` | `{ ok, version }` | 必须是首条消息。服务端从支持列表里选双方都懂的最高版本 |
| `session.list` | `{}` | `{ ok, sessions: [{ sessionId, title, cwd, mode, providerId, model, activeTurn: boolean }] }` | 已恢复/运行中的 session 列表 |
| `session.new` | `{ cwd?, title? }` | `{ ok, sessionId, ...同 list 项 }` | cwd 缺省用 server 启动目录 |
| `session.attach` | `{ sessionId }` | `{ ok, messages: StoredMessage[], replay: true }` | 见 §7。此后该连接才开始收此 session 的 live 事件 |
| `session.close` | `{ sessionId }` | `{ ok }` | 关闭标签。活跃 turn 先 cancel 再释放 |
| `turn.send` | `{ text: string }` | `{ ok, turnId }` | 按 `sessionId` 路由。同 session 同时只允许一个活跃 turn,重复发送 reply `ok:false, code:"turn_busy"` |
| `turn.cancel` | `{}` | `{ ok, aborted: boolean }` | 按 `sessionId` 路由。映射 `AbortSignal`。幂等:无活跃 turn 也返回 ok |
| `permission.resolve` | `{ requestId, outcome: "approved"\|"denied" }` | `{ ok }` | 不允许回 "timeout"(超时是服务端结论,见 §6) |
| `permission.always` | `{ requestId }` | `{ ok }` | "总是允许":向该 session 的 `PermissionPolicy` 追加一条 allow 规则(见 §6.1)。**依赖 `PermissionPolicy` 增加运行时加规则的方法**(`#rules` 目前私有,需小改) |
| `ask_user.answer` | `{ requestId, answers: AskUserAnswer[] } \| { requestId, abort: true }` | `{ ok }` | `AskUserAnswer` = `src/tui/ask-user.ts` 的 `{ question, selected: number[], custom? }` |
| `extension_role.fallback` | `{ requestId, allow: boolean }` | `{ ok }` | 对应 `onExtensionRoleFallback` |

预留(未实现,收到时 reply `ok:false, code:"not_implemented"`):

| type | payload |
|---|---|
| `turn.send` 附件 | 主 spec §6 的图片/文件粘贴拖拽:bugent 尚无附件输入通道,协议预留 `turn.send.attachments`,实现前一律拒绝 |

## 5. 事件注册表(下行)

事件与 `LoopHooks` 的映射是**规范性**的 —— bridge 用 `combineHooks` 注入 adapter,不改 loop:

| type | payload(关键字段) | 来源 hook |
|---|---|---|
| `turn.started` | `{ turnId }` | `runUserTurn` 进入 |
| `user.message` | `{ message: StoredMessage }` | `onUser` |
| `text.delta` | `{ delta }` | `onText` |
| `reasoning.delta` | `{ delta }` | `onReasoning`(标注:**不落库**,UI 不得持久化) |
| `assistant.message` | `{ message: StoredMessage }` | `onAssistant` |
| `tool.call_delta` | `ToolCallDelta & { reset?: boolean }` | `onToolCallDelta`;`reset=true` 时 UI 丢弃 provisional 卡片 |
| `tool.call` | `{ call: ToolCall }` | `onToolCall` |
| `tool.progress` | `{ call, chunk, stream: "stdout"\|"stderr" }` | `onToolProgress`(仅展示) |
| `tool.result` | `{ call, result: ToolExecution, message?: StoredMessage }` | `onToolResult`;`result.presentation` 为结构化展示数据 |
| `workspace.change` | `{ edit: WorkspaceFileEdit }` | ToolCtx `onWorkspaceChange`(undo 输入,UI 只做"已修改"标记) |
| `permission.request` | `{ requestId, request: PermissionRequest }` | `PermissionGate` prompter |
| `capability.request` | `{ requestId, call, escalation: CapabilityEscalation }` | `onRequestCapability` |
| `ask_user.request` | `{ requestId, call, questions: AskUserQuestion[] }` | `onAskUser` |
| `extension_role.fallback_request` | `{ requestId, error: string }` | `onExtensionRoleFallback` |
| `usage` | `{ usage: Usage }` | `onUsage` |
| `turn.done` | `{ turnId, result: { text, toolCalls, ... } }` | `TurnResult` |
| `todo.state` | `{ todos: [{ id, content, status: "pending"\|"in_progress"\|"completed" }] }` | bridge adapter 从 `todo_write` 工具调用的入参派生(见 §11 映射);非独立 hook |
| `turn.error` | `{ turnId, message }` | loop 抛错;之后**必须**有 `turn.done` 或连接级 error,UI 以先到者为准 |
| `error` | `{ code, message, fatal?: boolean }` | 协议层错误 |

类型来源:`PermissionRequest`/`ModeRequirement` = `src/permission/{policy,mode}.ts`;`CapabilityEscalation`/`ToolExecution`/`ToolPresentation` = `src/tools/types.ts`;`AskUserQuestion`/`AskUserAnswer` = `src/tui/ask-user.ts`。**协议类型直接 re-export 这些定义**(放进 `src/protocol/types.ts`),不复制结构,避免漂移。

## 6. 往返语义(request-id 流程)

`permission.request` / `capability.request` / `ask_user.request` / `extension_role.fallback_request` 都遵循同一模式:

1. 服务端生成 `requestId`,发事件,挂起对应的 Promise;
2. UI 回对应 `*.resolve` / `*.answer` cmd,携带同一 `requestId`;
3. 服务端 resolve 挂起的 Promise,发 reply。

**超时**:v0 服务端**不主动超时**(TUI 里授权等待也是无界的);UI 侧可自行提示,但没有"服务端强制 timeout"路径。若后续加超时,超时结论必须是 `timeout`(`AuthorizationOutcome` 三态:`approved | denied | timeout`,且模型端文案契约 `AUTHORIZATION_DENIED` / `AUTHORIZATION_TIMED_OUT` 不可改)。因此 v0 协议里 UI 只能回 approved/denied。

**连接断开**:活跃 turn 继续跑完(结果落库);挂起的 permission/ask_user Promise 以 `denied` 处理(与用户拒绝同文案),这是比"永久挂起"安全的默认。

### 6.1 "总是允许"(always)

- UI 回 `permission.always { requestId }` → 服务端把该 request 的 `tool`(+ `resource`,若 request 里有)以 glob 形式追加为 session 级 allow 规则,然后按 `approved` 继续本次调用;
- 规则只活在当前 session 进程内,不写盘、不跨 session;
- 需要 `PermissionPolicy` 暴露运行时加规则入口(现有 `#rules` 私有且只在构造时编译)。实现时补一个 `addRule(rule: PermissionRule)` + 内部 `globToRegExp`,并补测试;
- `capability.request` / `ask_user.request` **不支持** always —— 越界能力和提问按次授权是有意设计(见 `permission/mode.ts` 注释),UI 不得为它们渲染"总是允许"按钮。

## 7. 附加与回放(session.attach)

- attach 成功的 reply 里带 `messages: StoredMessage[]` 全量历史,每条附 `"replay": true` 标记(信封外,payload 内字段),UI 据此区分回放消息与 live 事件,**回放消息不触发动画/音效**;
- attach 之后服务端才开始向该连接发此 session 的 live 事件;每个 session 同时只允许一个连接 attach(第二个 attach reply `ok:false, code:"session_taken"`);多连接同看一个 session 留 v1。
- `tool.result` 的 `presentation`(bash segments / file diff)在历史里已落库于 StoredMessage,回放时 UI 从 message 里取,不靠事件。

## 8. 取消语义

- `turn.cancel` → bridge 持有的 `AbortController.abort()`,透传到 `RunTurnOptions.signal` 与所有 ToolCtx;
- 之后 loop 可能仍吐出尾部事件(已在管道里的),UI 必须容忍 `turn.cancel` 之后到 `turn.done` 之间的残余事件;
- Esc 中止 ask_user 用 `ask_user.answer` 的 `{ abort: true }` 形式,不复用 `turn.cancel`。

## 9. 版本化

- `v` 只做**破坏性**变更递增;新增事件/命令类型不递增(未知 type:cmd → reply `code:"unknown_command"`,evt → **静默丢弃**。这让新旧 UI/服务端可各自加字段);
- `hello` 协商:取双方 `protocolVersions` 交集的最大值;空交集 → 关闭。

## 10. 验收(协议侧)

1. `src/protocol/types.ts` 编译通过,且只 re-export 现有 core/permission/tools/tui 类型 + 信封/命令/事件联合类型;
2. bridge adapter:对每个 `LoopHooks` 钩子写一条映射测试(mock session 触发 hook → 断言发出的 evt 信封);
3. headless echo client(`scripts/protocol-smoke.ts`):连 ws → hello → session.new → turn.send(mock provider)→ 按序收到 §5 事件 → turn.done;cancel 路径与 permission denied 路径各一条;多 session 并行两条 turn 事件不串流;
4. 超时/断连行为有测试覆盖(§6)。

## 11. 与 WebUI spec §9 的映射(规范性)

WebUI spec(`docs/webui/agent-webui-spec.md` §9)定义了前端数据层 `AgentEvent` / `AgentTransport`。前端**保持自己的接口不变**,真实适配器(`transport/` 下的 `ProtocolTransport`)按下表翻译;冲突处**以本 spec 为准**,并已回改 WebUI 侧理解:

| WebUI `AgentEvent` | 本协议来源 | 翻译规则 |
|---|---|---|
| `message_start { messageId }` | `user.message` / `assistant.message` | 每条 StoredMessage 产生一个;`messageId = message.id` |
| `text_delta { messageId, text }` | `text.delta` | 协议事件不带 messageId(见下"消息归属");适配器归属到当前 turn 的 assistant 消息 id |
| `thinking_delta { messageId, text }` | `reasoning.delta` | 同上;不落库、不得持久化(两份 spec 一致) |
| `tool_call_start { toolId, name, input }` | `tool.call` | `toolId = call.id`;`input = call.arguments` |
| `tool_call_end { toolId, status, output, durationMs }` | `tool.result` | `status = result.ok ? "success" : "error"`;`output = result.output`;`durationMs` 由 bridge 在 loop 外计时补进事件(`ToolExecution` 无耗时字段) |
| —(WebUI 无此事件) | `tool.progress` / `tool.call_delta` | 供前端做"运行中输出预览";WebUI spec 未要求,适配器保留,前端可先忽略 |
| `tool_permission_request { toolId, description }` | `permission.request` / `capability.request` | 两者都映射为权限卡;`request.summary` 即 description。"总是允许"按钮只对 `permission.request` 显示(§6.1) |
| `todo_update { todos }` | `todo.state` | `content → text`,`completed → done`;`id` 原样 |
| `message_end { messageId }` | `assistant.message` | 落库消息到达即视为该流结束 |
| `error { message }` | `turn.error` / `error` | 会话级错误必须带 `sessionId`,路由到对应标签 |

**消息归属**:协议的 `text.delta` / `reasoning.delta` / `tool.*` 事件只带 `turnId` 不带 `messageId`。规范:适配器为每个 turn 维护"当前 assistant 消息 id",`assistant.message` 到达时更新,`turn.done` 后清空。若 bridge 后续能暴露流内 draft message id,协议再加可选 `messageId` 字段(非破坏性)。

**AgentTransport 翻译**:`send(sessionId, text)` → 未 attach 时先 `session.attach` 再 `turn.send`;`stop(sessionId)` → `turn.cancel`;`approveTool(toolId, decision)` → `permission.resolve` / `'always'` → `permission.always`;`onEvent(handler)` 订阅全部 evt,按 `envelope.sessionId` 分发 —— 与 WebUI 的 per-tab 状态模型一一对应。

**与 WebUI spec 的已裁决冲突**(WebUI 实现按此执行):

1. WebUI §9 "WebSocket 或 SSE" → 定为 **WebSocket**(SSE 无上行通道,permission 往返需要双向);
2. `approveTool` 的 `'always'` → 仅 `permission.request` 支持;`capability` / `ask_user` 的权限卡不渲染"总是允许"(§6.1);
3. `send(..., attachments)` → 附件通道不存在(`not_implemented`),适配器忽略并在开发模式警告;
4. `MockTransport` 仍按 `AgentEvent` 接口实现,不必实现协议本身;验收时 mock 脚本须覆盖 §5 的事件顺序,保证 mock ↔ 真实协议序列等价。

## 12. 开放问题(留给实现)

- token 如何到达浏览器(dev 时 stdout 打印 vs 文件);
- `tool.progress` 的背压:v0 不做合并(与 TUI 现状一致),浏览器端渲染吃紧时由 WebUI spec 的 rAF 批处理兜底;
- 多窗口(Electron 开两个 BrowserWindow)是否共享 server:按"每窗口一条连接"处理,`session_taken` 会阻止跨窗口同看一个标签;要打破此限制留 v1。

