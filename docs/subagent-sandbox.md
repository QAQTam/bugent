# bugent Subagent Sandbox Spec

> 状态：设计稿  
> 前置：`docs/agent-model.md`  
> 目标：定义 subagent 的文件系统、进程、网络、环境、MCP、控制面和 ACP 隔离边界。  
> 基线：现有 Linux Landlock/seccomp/Bun sandbox、MCP fail-closed sandbox、ToolRegistry/PermissionGate。

## 1. 摘要

Subagent sandbox 不是“给子代理换一个 `sandbox_mode`”。

它是一份由 supervisor 编译、在 agent 启动前冻结的能力策略：

```text
AgentIdentity
  + AgentKind
  + AgentAuthority
  + Task
  -> AgentSandboxSpec
  -> process / filesystem / network / env / MCP / IPC
```

一句话定义：

> Sandbox 决定子代理能观察和改变什么；AgentKind 只提供默认策略，最终权限永远不能超过父代理。

## 2. 核心原则

1. 权限只减不增。
2. AgentKind 不等于 authority。
3. 文件系统隔离与进程隔离是两个维度。
4. 网络永远是独立能力，不从 sandbox mode 推导。
5. reviewer/explorer 永久只读。
6. worker 默认使用隔离 workspace。
7. 共享工作区必须显式开启并使用资源锁。
8. 控制面必须在 sandbox 之外。
9. MCP 必须按 agent 单独收权。
10. 非 Linux 的可写子代理默认 fail closed。
11. 无沙箱模式只能由用户显式授权。
12. 子代理输出仍然是不可信数据。

## 3. 威胁模型

### 3.1 文件系统越界

子代理可能：

- 读取凭据、SSH key、云配置；
- 修改父工作区；
- 修改 `.git` refs；
- 覆盖其他 agent 的文件；
- 通过符号链接逃逸；
- 写系统目录。

### 3.2 并发写冲突

多个 agent 同时修改：

- 同一文件；
- 同一目录；
- git index / refs；
- package lock；
- build cache。

必须使用文件级或 workspace 级 lease。

### 3.3 网络与数据外泄

即使文件权限正确，只要网络开放，agent 仍可能：

- 上传源码；
- 泄露环境变量；
- 访问内部服务；
- 绕过 tool permission 做旁路请求。

默认：

```text
network = none
```

### 3.4 凭据泄漏

子代理进程不应自动获得：

- provider API key；
- keychain；
- SSH agent；
- AWS/GCP/GitHub token；
- 浏览器 cookie；
- daemon control token。

### 3.5 MCP 扩大攻击面

MCP server 是独立进程，可能：

- 读写 workspace；
- 访问 state；
- 联网；
- 启动子进程；
- 暴露 destructive tool。

每个 MCP server 必须绑定独立 capability grant。

### 3.6 控制面伪造

如果 agent 通过 workspace 文件发送控制消息：

- 其他 agent 可以篡改；
- sandbox 内的进程可以伪造；
- 崩溃恢复无法信任消息顺序。

控制消息必须走 supervisor 拥有的 IPC。

### 3.7 Worktree 元数据污染

Git worktree 共享 object database 和部分 metadata。子代理可写 `.git` 时可能：

- 创建/删除 refs；
- 修改 index；
- 污染 object store；
- 影响父仓库。

## 4. AgentSandboxSpec

```ts
type WorkspaceAccess = "none" | "read" | "write";

type WorkspaceIsolation =
  | "shared"
  | "worktree"
  | "overlay"
  | "snapshot";

type ProcessIsolation =
  | "none"
  | "landlock+seccomp"
  | "bwrap"
  | "container";

type NetworkMode =
  | "none"
  | "one-shot"
  | "allowlist"
  | "all";

interface AgentSandboxSpec {
  agentId: string;
  kind: AgentKind;
  authority: AgentAuthority;

  workspace: {
    access: WorkspaceAccess;
    isolation: WorkspaceIsolation;
    root: string;
    writablePaths: string[];
    readonlyPaths: string[];
    allowSymlinkEscape: false;
  };

  process: {
    isolation: ProcessIsolation;
    executablePaths: string[];
    maxProcesses: number;
    maxCpuSeconds: number;
    maxMemoryBytes: number;
    maxOpenFiles: number;
  };

  network: {
    mode: NetworkMode;
    allow: string[];
    oneShotGrantId?: string;
  };

  env: {
    allow: string[];
    extra: Record<string, string>;
    unset: string[];
  };

  capabilities: AgentCapability[];
  mcpServerIds: string[];
  maxDepth: number;
  controlChannel: "supervisor-ipc";
}
```

约束：

- 此对象在 agent 启动前冻结。
- 运行中只能进一步收紧，不能自动放宽。
- `oneShotGrantId` 只能消费一次。
- `controlChannel` 不允许改成 workspace 文件。
- 子代理不能自行修改自己的 spec。

## 5. 默认策略矩阵

| AgentKind | Workspace access | Isolation | Process | Network | Capability |
| --- | --- | --- | --- | --- | --- |
| reviewer | read | shared/snapshot | bwrap/landlock | none | fs.read, process.exec |
| explorer | read | shared | bwrap/landlock | none | fs.read, process.exec |
| worker | write | worktree/overlay | bwrap/landlock | none | fs.read, fs.write, process.exec |
| integrator | write | shared | bwrap/landlock | one-shot only | fs.read, fs.write, process.exec |
| main | write | shared | bwrap/landlock | one-shot only | parent capability set |

`reviewer` / `explorer` 不允许：

```text
fs.write
network
mcp.write
goal.write
agent.spawn
```

## 6. Authority 衰减

权限上限：

```text
child.authority ≤ parent.authority
child.capabilities ⊆ parent.capabilities
```

Authority 顺序：

```text
none < read-only < workspace-write < full
```

规则：

- 父为 `read-only`，子不能是 `workspace-write`。
- 父没有 `network`，子不能自行联网。
- 父没有 `agent.spawn`，子不能继续 spawn。
- 父撤销 capability 后，子代理收到后必须在下一次工具调用前生效。
- 运行中的 agent 若权限被收紧，不需要重启进程，但必须由 supervisor 重新编译 policy。

## 7. Workspace 策略

### 7.1 shared-read

适合：

- reviewer
- explorer
- 只读分析

特点：

- 可读父工作区；
- 不能写；
- 不能修改 `.git`；
- 可运行只读测试；
- 测试产物写私有 `/tmp`。

### 7.2 shared-write

只在显式 opt-in 时允许。

要求：

- 使用 `ResourceLockManager`；
- 文件级锁优先；
- 无法判断目标时锁整个 workspace；
- 同一资源不能同时有多个 writer；
- 子代理不能修改父 `.git` refs。

不推荐作为 worker 默认模式。

### 7.3 worktree

默认 worker 模式：

```text
source workspace
  -> create isolated worktree
  -> subagent writes only inside worktree
  -> run tests inside worktree
  -> produce commit/patch/snapshot
  -> parent review/apply
```

要求：

- `.git` metadata 只读或由 supervisor 代理；
- 子代理不能直接删除 worktree；
- 完成后由 supervisor 执行 snapshot / remove / GC；
- 默认不自动 merge；
- merge 由 integrator 或 main 显式完成。

### 7.4 overlay

适合大仓库：

- 父 workspace 只读；
- 子代理写入 upper layer；
- 不修改父文件；
- 完成后导出 diff。

overlay 与 worktree 的区别：

- worktree 基于 git 工作树；
- overlay 基于文件系统层；
- overlay 不要求仓库必须是 git。

### 7.5 snapshot

用于只读 reviewer 或 crash resume：

- 固定父 workspace 的 revision；
- 记录文件 hash；
- 子代理只读该 snapshot；
- review 结果绑定 snapshot hash。

## 8. 进程隔离

### 8.1 Linux 首选

```text
bwrap
  + Landlock
  + seccomp
  + no_new_privs
  + rlimit
```

Bun fork runtime 负责在 exec 前应用 policy。

### 8.2 read-only profile

允许：

- read_file；
- grep；
- 只读 bash；
- 测试命令。

禁止：

- workspace write；
- network；
- ptrace；
- mount；
- namespace escape；
- 写系统路径。

### 8.3 worker profile

允许：

- worktree write；
- 在 worktree 执行构建/测试；
- 私有 `/tmp`；
- 无网络。

禁止：

- 写 main workspace；
- 写父 `.git`；
- 访问父 HOME；
- 网络；
- 继承 provider credentials。

### 8.4 非 Linux

在没有等价 provider 前：

- reviewer/explorer：路径级只读 + 工具能力裁剪；没有原生进程沙箱时，`process.exec` 默认关闭；
- worker：默认 fail closed；
- MCP：继续 fail closed；
- 不自动降级到 `no-sandbox`。

## 9. 网络策略

网络不跟 `workspace-write` 绑定。

模式：

```text
none
one-shot
allowlist
all
```

规则：

- 子代理默认 `none`。
- `one-shot` 只允许一次具体命令重试。
- `allowlist` 必须绑定域名/IP 和端口。
- `all` 需要用户显式授权。
- 子代理不能把网络 capability 再授予后代。
- reviewer/explorer 默认永久禁止网络；只有用户显式修改 session policy 才可能放开，且不属于 AgentKind 默认能力。
- 子代理失败后的联网授权必须由 supervisor 代理给用户确认。

## 10. 环境变量与凭据

默认环境：

```text
PATH
HOME -> private state dir
TMPDIR -> private tmp
LANG
LC_ALL
TERM
TZ
```

默认剔除：

```text
*_API_KEY
*_TOKEN
*_SECRET
AWS_*
GCP_*
AZURE_*
SSH_AUTH_SOCK
DATABASE_URL
HTTP_PROXY
HTTPS_PROXY
```

规则：

- provider credentials 不进入工具进程。
- 模型调用与工具执行使用不同的 credential context。
- 子代理需要外部认证时，由 supervisor 提供最小代理。
- 环境变量名必须显式 allowlist。
- `extraEnv` 不允许覆盖 sandbox policy 自身。

## 11. MCP 策略

每个子代理拥有独立 MCP allowlist：

```ts
interface AgentMcpGrant {
  serverId: string;
  workspaceRead: boolean;
  workspaceWrite: boolean | string[];
  network: "none" | "allowlist" | "all";
  tools: string[];
  stateDir: string;
}
```

默认：

- reviewer/explorer：只允许 read-only MCP。
- worker：只允许任务相关 MCP。
- integrator：按父权限显式授权。
- 子代理不能访问父 MCP state。
- MCP server 不能继承父环境变量。
- MCP 启动失败必须 fail closed。

## 12. 控制面隔离

控制面由 `AgentSupervisor` 持有，必须位于 sandbox 之外。

允许：

```text
pipe
unix socket
in-memory channel
supervisor-owned RPC
```

禁止：

```text
workspace 文件
.git 目录
环境变量中的控制 token
MCP server 转发
```

消息必须带：

```text
from
to
taskId
messageId
seq
type
payload
```

Supervisor 负责：

- 身份校验；
- 顺序校验；
- 消息持久化；
- 事件广播；
- 父模型通知；
- 取消和超时。

## 13. Permission 中介

子代理不能直接向用户弹权限窗口。

流程：

```text
subagent tool request
  -> child PermissionGate
  -> AgentSupervisor
  -> parent PermissionPolicy
  -> user interaction if needed
  -> one-shot grant
  -> child execution
```

规则：

- 子代理只能请求父代理已经允许申请的能力。
- 不允许永久升级子代理权限。
- 用户批准只作用于当前 command / resource。
- reviewer/explorer 不能申请 `fs.write`。
- 子代理不能自行批准自己的请求。
- 权限拒绝必须返回结构化 reason。

## 14. ACP 集成

ACP 作为 transport 时：

```text
Supervisor = ACP Client
Subagent   = ACP Agent
```

ACP 可提供：

- `session/new`
- `session/prompt`
- `session/update`
- `requestPermission`
- `fs/read_text_file`
- `fs/write_text_file`
- terminal methods

但 ACP 不提供：

- sandbox policy；
- parent-child tree；
- budget inheritance；
- worktree lease；
- agent cancellation cascade。

因此：

- ACP subagent process 仍必须由 supervisor 套 sandbox。
- 文件系统优先走 ACP fs proxy。
- 终端能力走 supervisor 的 terminal policy。
- permission 请求回到 supervisor。
- ACP 不决定 AgentKind / Authority。

## 15. 资源预算与 Lease

每个 agent 必须有独立预算：

```ts
interface AgentBudget {
  maxTokens?: number;
  maxActiveSeconds?: number;
  maxToolCalls?: number;
  maxProcesses?: number;
  maxArtifactBytes?: number;
}
```

Lease：

```ts
interface AgentLease {
  agentId: string;
  resourceKey: string;
  access: "read" | "write";
  expiresAt: number;
}
```

规则：

- writer lease 独占；
- reader lease 可并发；
- lease 过期由 supervisor 回收；
- worktree 由单个 agent 独占；
- parent cancel 必须释放全部 lease。

## 16. Crash / Resume

恢复流程：

```text
load agent_instances
  -> verify session/branch exists
  -> verify sandbox spec hash
  -> reacquire leases
  -> rehydrate worktree/overlay if needed
  -> resume from last safe boundary
```

不能自动恢复：

- 权限已过期；
- sandbox spec hash 不匹配；
- workspace snapshot 丢失；
- 父 agent 已终止且策略为 detached=false；
- worktree 不可信。

## 17. 实施顺序

```text
P7-A  AgentSandboxSpec 类型与编译器
P7-B  reviewer / explorer read-only sandbox
P7-C  AgentSupervisor control channel
P8-A  worktree lease 与 snapshot
P8-B  worker sandbox
P8-C  MCP per-agent grants
P9    ACP fs/terminal/permission proxy
P10   non-Linux backend
```

第一阶段验收：

1. reviewer 无法写 workspace。
2. reviewer 无法联网。
3. reviewer 无法访问 provider credentials。
4. explorer 无法 spawn。
5. worker 无法直接写 main workspace。
6. 所有 subagent tool 调用仍经过 ToolRegistry。
7. cancel 能级联终止后代。
8. 子代理输出不会被当成高优先级 instruction。

## 18. 非目标

- 不把 sandbox mode 当作 AgentKind。
- 不让子代理自行扩权。
- 不让 reviewer/explorer 变成 writer。
- 不默认共享可写工作区。
- 不让 ACP 替代 sandbox。
- 不在非 Linux 平台无沙箱运行可写 worker。
- 不把控制消息放进 workspace。
- 不把父私有 reasoning 注入子代理。
