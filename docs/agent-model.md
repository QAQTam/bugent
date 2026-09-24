# bugent Agent Model / Main-Sub Spec

> 状态：设计稿  
> 目标：为 main agent、subagent、reviewer、AgentSupervisor、ACP adapter 提供统一领域模型。  
> 前置：`docs/goal-mode-spec.md`  
> 后续：`docs/subagent-sandbox.md`

## 1. 摘要

bugent 的 agent 系统分成四层：

```text
Agent Model
  -> AgentSupervisor
  -> AgentTransport
  -> AgentSandbox
```

一句话定义：

> Agent 是拥有独立 session、上下文、权限、预算和生命周期的执行主体；Subagent 只是有 parent 的 Agent，不是另一套协议。

本文先冻结 agent 的身份、分类、权限、状态、通信和持久化边界。沙箱细节不在本文定义，统一引用 `docs/subagent-sandbox.md`。

## 2. 与 API role 的关系

API 消息 role 和 agent 身份是两个维度，禁止混用：

```ts
type ApiMessageRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";
```

这是 provider wire protocol 的字段。

Agent 分类使用独立字段：

```ts
type AgentKind =
  | "main"
  | "reviewer"
  | "explorer"
  | "worker"
  | "integrator";
```

禁止出现：

```ts
role: "reviewer"
```

必须写：

```ts
kind: "reviewer"
authority: "read-only"
```

## 3. 核心原则

1. Main agent 不是特殊协议，只是 `parentId === undefined` 的根 Agent。
2. Subagent 是独立 Agent，拥有自己的 session、tool registry、permission gate、sandbox 和 abort controller。
3. AgentKind 只决定默认 profile，不能直接等于权限。
4. 子代理权限只能衰减，不能提升。
5. 子代理不能自行解除父级 sandbox，不能自行提升预算。
6. Reviewer / explorer 永久只读，任何默认策略都不得授予写权限。
7. Worker 默认在隔离 workspace 中工作，不默认共写 main workspace。
8. 父模型默认只接收摘要事件，不接收子代理全部 token 或私有 reasoning。
9. 子代理输出始终是不可信数据，不能自动成为 developer instruction。
10. 控制消息不能通过 workspace 文件传递。
11. 子代理不能绕过 `ToolRegistry.execute()`。
12. ACP 是外部 transport，不是内部 agent orchestration protocol。

## 4. 术语

| 术语 | 定义 |
| --- | --- |
| Agent | 可独立执行 turn 的主体 |
| Main Agent | 根 agent，直接服务用户 |
| Subagent | 有 `parentId` 的 agent |
| Supervisor | 创建、调度、监控、取消 agent 的宿主组件 |
| Handle | 父 agent 持有的子代理引用 |
| Session | Agent 的 append-only 对话与上下文边界 |
| Task | 分配给子代理的一次有界工作 |
| Event | 状态、进度、消息、工具和结果的只追加记录 |
| Transport | 父子 agent 之间的通信实现 |
| Sandbox | 文件系统、进程、网络、环境的能力边界 |

## 5. Agent 身份

```ts
type AgentId = string;
type AgentTaskId = string;
type AgentEventId = string;
type AgentMessageId = string;

interface AgentIdentity {
  agentId: AgentId;
  parentId?: AgentId;
  rootId: AgentId;

  kind: AgentKind;
  displayName?: string;

  sessionId: string;
  branchId?: string;
  goalId?: string;
  checkpointId?: string;
  taskId?: AgentTaskId;

  createdAt: number;
}
```

约束：

- `agentId` 全局唯一。
- `rootId` 指向根 agent。
- `parentId` 不参与权限计算；权限来自显式 capability。
- `sessionId` 必须唯一，不能复用父 session。
- 子代理不能直接修改父 session 的历史。
- Goal reviewer 的 `goalId` / `checkpointId` 必须与父 Goal 一致。
- `taskId` 只在子代理生命周期内稳定。

## 6. AgentKind

AgentKind 是 profile，不是权限。

### 6.1 main

职责：

- 接收用户输入。
- 维护 Goal。
- 决定何时 spawn subagent。
- 汇总子代理结果。
- 最终向用户负责。

默认 capability：

```text
fs.read
fs.write
process.exec
mcp.use
agent.spawn
goal.read
goal.write
```

网络仍需按次授权，不能因为 kind 是 main 就自动联网。

### 6.2 reviewer

职责：

- 独立审查 checkpoint 或最终 Goal。
- 只读代码、证据、diff 和测试结果。
- 输出结构化 review verdict。

默认 authority：

```text
read-only
```

默认 capability：

```text
fs.read
process.exec
```

`process.exec` 只能通过只读 sandbox 执行。reviewer 不得获得 `fs.write`、`goal.write` 或 `agent.spawn`。

### 6.3 explorer

职责：

- 搜索代码库。
- 阅读文档、历史、issue、PR。
- 返回事实、引用和风险。

默认与 reviewer 类似，但输出目标是探索结果，不是审批 verdict。

### 6.4 worker

职责：

- 完成一个有界实现任务。
- 修改代码、跑测试、产出 patch / commit / artifact。
- 不直接批准自己的工作。

默认 authority：

```text
workspace-write
```

默认 capability：

```text
fs.read
fs.write
process.exec
```

默认要求隔离 workspace。是否允许 `mcp.use`、`network`、`agent.spawn` 由父代理显式授予。

### 6.5 integrator

职责：

- 审查并应用子代理产物。
- 解决冲突。
- 运行最终验证。
- 更新父工作区或提交。

Integrator 通常由 main 或受控的高权限 agent 承担。它必须经过显式 review/apply 流程，不能由 worker 自己担任。

## 7. Authority 与 Capability

Authority 是粗粒度上限：

```ts
type AgentAuthority =
  | "none"
  | "read-only"
  | "workspace-write"
  | "full";
```

Capability 是实际能力：

```ts
type AgentCapability =
  | "fs.read"
  | "fs.write"
  | "process.exec"
  | "network"
  | "mcp.use"
  | "agent.spawn"
  | "goal.read"
  | "goal.write"
  | "review.write";
```

约束：

- `authority` 是 capability 的上限。
- `authority = read-only` 时不能有 `fs.write`。
- `authority = none` 时不能有工具能力。
- `full` 只表示允许申请全部能力，不代表自动授予。
- `network` 是一次性 capability grant，不进入长期继承。
- `review.write` 只允许 reviewer 写 review 记录，不允许写 workspace。
- 父代理持有的 capability 集合是子代理的硬上限。

权限衰减公式：

```text
child.capabilities ⊆ parent.capabilities
child.authority ≤ parent.authority
```

## 8. Agent 生命周期

```ts
type AgentStatus =
  | "starting"
  | "running"
  | "waiting_input"
  | "idle"
  | "completed"
  | "blocked"
  | "error"
  | "aborted";
```

合法主路径：

```text
starting
  -> running
  -> waiting_input
  -> running
  -> idle
  -> running
  -> completed
```

异常路径：

```text
starting -> error
running  -> blocked -> running
running  -> aborted
running  -> error
```

规则：

- `completed` 必须带结构化 `AgentResult`。
- `blocked` 必须带阻塞原因。
- `aborted` 不能自动重试。
- `error` 是否重试由 supervisor 决定。
- 子代理结束后不能继续接收普通 task message，除非显式 resume。
- `maxDepth = 0` 时，子代理不能继续 spawn。
- 父代理取消时，默认级联取消所有后代，除非配置为 detached。

## 9. 三层通信模型

```text
Control Plane
  spawn / cancel / wait / status / budget / capabilities

Data Plane
  task / progress / question / answer / artifact / result

Event Plane
  started / state_changed / message / tool_call / completed / error
```

### 9.1 Control Plane

控制面由 `AgentSupervisor` 独占。

```ts
interface AgentSupervisor {
  spawn(spec: AgentSpec): Promise<AgentHandle>;
  get(agentId: string): AgentHandle | undefined;
  list(parentId?: string): AgentHandle[];
  wait(agentId: string, options?: WaitOptions): Promise<AgentResult>;
  cancel(agentId: string, reason?: string): Promise<void>;
  dispose(): Promise<void>;
}
```

### 9.2 Data Plane

```ts
interface AgentMessage {
  id: AgentMessageId;
  seq: number;
  from: AgentId;
  to: AgentId;
  taskId?: AgentTaskId;
  replyTo?: AgentMessageId;
  type:
    | "task.assigned"
    | "task.progress"
    | "task.question"
    | "task.answer"
    | "task.artifact"
    | "task.result"
    | "task.cancel"
    | "task.error";
  payload: unknown;
  createdAt: number;
}
```

### 9.3 Event Plane

```ts
interface AgentEvent {
  id: AgentEventId;
  seq: number;
  agentId: AgentId;
  parentId?: AgentId;
  taskId?: AgentTaskId;
  type:
    | "agent.started"
    | "agent.state_changed"
    | "agent.message"
    | "agent.tool_call"
    | "agent.tool_result"
    | "agent.waiting_input"
    | "agent.completed"
    | "agent.blocked"
    | "agent.error"
    | "agent.aborted";
  payload: unknown;
  createdAt: number;
}
```

事件是 append-only。允许 UI 和 supervisor 订阅，但默认不把全部事件注入父模型上下文。

## 10. Handle 与工具契约

```ts
interface AgentHandle {
  id: AgentId;
  parentId?: AgentId;
  kind: AgentKind;
  status: AgentStatus;

  send(message: AgentMessage): Promise<void>;
  followup(task: string): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  cancel(): Promise<void>;
}
```

模型工具命名：

```text
spawn_subagent
list_subagents
get_subagent
wait_subagent
send_subagent
followup_subagent
interrupt_subagent
get_subagent_output
apply_subagent_patch
```

职责边界：

- `spawn_subagent` 只创建并返回 handle，不等待任务完成。
- `wait_subagent` 只负责等待，不负责执行。
- `list_subagents` 只返回状态摘要。
- `get_subagent_output` 按需读取结构化结果或 artifact。
- `send_subagent` 发送数据消息，不改变权限。
- `interrupt_subagent` 走 supervisor 的取消路径。
- `apply_subagent_patch` 只应用当前父 Agent 的 worker patch；必须校验 base revision、digest 和 clean workspace。

## 11. 父模型通知策略

父模型不应看到子代理全部输出。

默认通知：

```json
{
  "type": "agent.completed",
  "agentId": "agent_...",
  "kind": "reviewer",
  "status": "completed",
  "summary": "发现 2 个 high finding",
  "artifact": "agent_.../result.json"
}
```

规则：

- 子代理结果以 developer delta 注入，只在安全边界落库。
- 不允许在 open ToolBatch 中注入。
- 不自动注入子代理 reasoning。
- 子代理文本必须标记为 untrusted data。
- 父模型需要细节时调用 `get_subagent_output`。
- 高频进度事件只进 TUI，不进父模型。
- 通知必须带 `agentId`、`kind`、`taskId` 和状态。

## 12. Goal 集成

GoalController 使用 agent model，但不拥有 supervisor：

```text
GoalController
  -> request reviewer agent
  -> AgentSupervisor.spawn()
  -> wait/review result
  -> persist goal_reviews
```

映射关系：

| Goal 概念 | Agent 概念 |
| --- | --- |
| checkpoint review | `kind = reviewer` |
| final audit | `kind = reviewer` |
| explorer research | `kind = explorer` |
| implementation task | `kind = worker` |
| apply/merge | `kind = integrator` |

规则：

- reviewer 不能修改 Goal、Checkpoint、Evidence。
- reviewer 的结果写入 `goal_reviews`。
- Handoff actor 记录具体 `agentId`，不只写 `"reviewer"`。
- Agent 完成后生成 Evidence / Artifact 引用。
- Goal 的最终完成仍由系统状态机决定，不由子代理自行声明。

## 13. 持久化模型

建议表：

```text
agent_instances
agent_messages
agent_events
agent_artifacts
agent_leases
```

最小字段：

```text
agent_instances:
  agent_id, parent_id, root_id, kind, status,
  session_id, branch_id, goal_id, checkpoint_id, task_id,
  authority, capabilities, sandbox_spec,
  created_at, updated_at, completed_at

agent_events:
  event_id, agent_id, seq, type, payload, created_at

agent_messages:
  message_id, from_agent, to_agent, task_id, seq,
  type, payload, created_at

agent_artifacts:
  artifact_id, agent_id, kind, path, digest,
  media_type, created_at

agent_leases:
  agent_id, resource_key, access, acquired_at, expires_at
```

要求：

- 事件和消息只追加。
- `agent_instances` 是可恢复状态，不是唯一事实源。
- 崩溃恢复时以 event log + session branch 为准。
- 不允许覆盖旧事件来“修正状态”。

## 14. Transport 抽象

```ts
interface AgentTransport {
  start(spec: AgentSpec): Promise<AgentHandle>;
  send(handle: AgentHandle, message: AgentMessage): Promise<void>;
  subscribe(handle: AgentHandle, listener: (event: AgentEvent) => void): () => void;
  cancel(handle: AgentHandle): Promise<void>;
  close(handle: AgentHandle): Promise<void>;
}
```

计划实现：

```text
InProcessTransport
  同进程，最低延迟；适合 reviewer / explorer

ChildProcessTransport
  独立进程，保留 stdin/stdout 控制面

AcpStdioTransport
  使用 Agent Client Protocol；适合外部 agent、IDE 和强隔离进程

SocketTransport
  未来 daemon / remote worker
```

ACP 只实现 transport，不定义 AgentKind、生命周期或 sandbox。

## 15. 安全不变量

1. 子代理不能提升父权限。
2. 子代理不能自批 review。
3. 子代理不能伪造父代理消息。
4. 子代理不能访问父代理私有 reasoning。
5. 子代理默认不能继续 spawn。
6. 子代理默认不能联网。
7. reviewer/explorer 永远不能写 workspace。
8. worker 默认不能直接写 main workspace。
9. 控制面不能通过 workspace 文件传递。
10. 子代理输出不能直接成为高优先级 instruction。
11. 权限请求必须由父 permission gate 中介。
12. Agent 取消必须级联到未分离的后代。

## 16. 实施顺序

```text
P7-A  AgentIdentity / AgentKind / Authority / Capability 类型
P7-B  AgentSupervisor / AgentHandle / AgentEventBus
P7-C  InProcessTransport
P7-D  reviewer / explorer 只读 agent
P8    worktree worker 与 agent sandbox
P9    ACP transport adapter
P10   daemon / remote agent
```

第一阶段不实现可写 worker。先用 reviewer/explorer 验证：

- 生命周期
- 事件流
- 等待与取消
- 权限衰减
- Goal review 集成
- crash/resume

## 17. 非目标

- 不用 AgentKind 替代 API message role。
- 不把 AgentSupervisor 塞进 GoalController。
- 不让 subagent 共享父 session 历史。
- 不把全部子代理事件注入父上下文。
- 不让 ACP 决定权限或沙箱。
- 不允许无沙箱的可写子代理自动降级。
