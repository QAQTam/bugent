# wsbox —— Agent 工作区账本沙箱（原型设计）

> 状态：设计稿 · 核心机制已在本机实测通过 · 引擎已落地为独立仓库 `/home/qaqtamsy/项目/wsbox`
> 消费者：bugent（Bun/TS）与 qaqh-backend（Rust）两个独立 agent，共用同一套引擎
> 前置：`src/sandbox/bwrap.ts`、`src/tools/bash.ts`、`src/core/workspace.ts`、`src/core/workspace-undo.ts`、`docs/subagent-sandbox.md`
> 参考：qaqh-backend `crates/qaqh-sandbox`（landlock/seccomp/能力探测）、`crates/qaqh-workspace/tests/audit_ledger.rs`
> 验证脚本：`scripts/wsbox-overlay-spike.sh`

## 1. 问题：缺口不在隔离层，在观测层

现在工作区变更的唯一来源是**进程内工具主动上报**（`src/tools/types.ts:289`）：

```ts
const workspace: WorkspaceFileEdit[] = [];
const executionCtx: ToolCtx = {
  ...ctx,
  onWorkspaceChange: (edit) => { workspace.push(edit); ... },
};
const value = await tool.run(call.args, executionCtx);
```

只有 `write_file` / `edit_file` / `apply_patch` 会调 `ctx.onWorkspaceChange`。
`bash` 工具（`src/tools/bash.ts`）从不调用它。于是：

| 事件 | 现状 |
|---|---|
| `python -c "open('a.py','w').write('')"` | tool result 的 `workspace` 字段为 `undefined` |
| session 落库（`src/core/session.ts:285`） | `createWorkspaceChange` 不触发，没有 `WorkspaceFileChange` |
| `/undo`（`src/core/workspace-undo.ts`） | 不知道有这个改动，无法回滚 |
| 分支切换 / 消息回放 | 带不回这个改动 |
| 真实工作区 | **已经被改**，旧内容不在任何地方 |

而 `src/sandbox/bwrap.ts:85` 的 `--bind cwd cwd` 只保证"工作区可写、根只读"——**不保证可观测**。

所以问题不是"模型绕过 edit/apply_patch"，而是**绕过之后没有任何一条路径能看见它**。
三档权限管的是"能不能写"；缺的是"写了什么、能不能退"。

设计目标因此不是"禁止 python 写文件"（那只会把模型推向更隐蔽的写法），而是：

> **让任何写路径都变得和 apply_patch 等价——有 diff、有账本、可撤销。**

## 2. 核心机制：会话级 overlay + 逐调用账本

```
真实工作区  ──────────────┐（作为 lower，只读）
                          ├──► overlay ──► 沙箱内看到的 /workspace
会话 upper/ ──────────────┘   （agent 的全部写入）
```

沙箱**永远不直接写真实工作区**。所有写入落到 `upper/`，退出后由宿主侧扫描 `upper/` 产出 diff。

### 2.1 已实测的关键事实

| 事实 | 实测结果 |
|---|---|
| `unshare -Ur -m` 里挂 overlay | ✅ `MOUNT-OK`（内核 7.2.6，无需特权） |
| 把文件 truncate 成 0 字节 | ✅ 真实工作区 `lower` 完好（55 bytes），`upper` 里是 0 字节 |
| 会话连续性（第二次调用看到第一次的改动） | ✅ merged 视图正确叠加 |
| 删除文件 | ✅ upper 里出现 whiteout（char device `0:0`） |
| **`bwrap` 自己挂 overlay** | ❌ `cannot mount overlay read-only` / `must be superuser` |
| **`bwrap` 嵌在 `unshare -Ur -m` 里，`--bind $MRG $WS`** | ✅ 可用（目标路径必须已存在） |

最后两条直接决定了架构：**overlay 必须在 bwrap 之外建，bwrap 只负责把 merged 目录绑到工作区路径。**

### 2.2 目录布局

```
~/.bugent/wsbox/<session-id>/
  upper/            # 本会话 agent 的全部写入（含 whiteout 字符设备）
  work/             # overlay workdir
  merged/           # overlay 挂载点（每次调用现挂，退出即消失）
  cas/<sha256>      # 所有"被覆盖前"的内容 blob，内容寻址去重
  index.json        # path -> {sha, exists, type, lastCall}
  calls/<call-id>/  # 逐调用 manifest + diff + 反向 patch
  ledger.jsonl      # 追加式账本（哈希链，防篡改）
```

**关键：`lower` 直接用真实工作区，不做基线拷贝。**
理由：overlay 只在写时 copy-up，`node_modules/`、`target/` 这类大目录零成本。
代价是用户中途编辑会和 agent 打架——用 `index.json` 里的 baseline sha 在 apply 时检测冲突即可（见 §6）。

需要严格冻结基线的场景（可复现回放、评测）再提供 `--freeze`：会话开始时 `cp -a --reflink=auto` 一份快照当 lower。

### 2.3 一次 tool call 的完整生命周期

```
1. checkpoint: 扫 upper/ → manifest{path -> (type, size, sha)}
   （内容已在 CAS：首次出现的路径，其 before 从 lower 读入 CAS）
2. spawn:  unshare -Ur -m → mount overlay → bwrap 把 merged 绑到 cwd → 执行命令
3. 退出后: 再扫 upper/ → 与 checkpoint 对比
   对每个变化路径:
     - 从 CAS 取 before 内容
     - 从 upper 读 after 内容（whiteout => after 不存在）
     - after 写入 CAS，更新 index.json
     - 生成 unified diff + 反向 patch
4. 追加 ledger.jsonl（含 argv、cwd、pid tree、exit code、路径级变更）
5. 把 diff 摘要塞进 tool result 返回给模型
```

因为 `upper/` 只包含 agent 碰过的文件，第 1、3 步是 O(改动量) 而不是 O(仓库)。用 `(mtime_ns, size)` 做快路径，只在变化时算 sha256。

## 3. 一套引擎，两套适配

bugent 和 qaqh-backend 是**两个独立 agent**，不能互相 import，运行语言也不同（Bun/TS vs Rust）。
所以不是"做两套"，也不是"做一套库"，而是：

> **一个语言中立的引擎二进制 + 一份版本化协议 + 两边各一个薄客户端 + 各一个适配层。**

### 3.1 为什么不做两套实现

沙箱是**安全敏感**代码，同一段 userns / overlay / whiteout / CAS 逻辑写两遍，必然漂移：

- 一边修了 whiteout 识别，另一边没修 → 同一个删除操作在两个 agent 里语义不同。
- 一边的缩水阈值调了，另一边没有 → 用户看到的行为不一致。
- 两份 landlock 安装顺序，只有一份是对的（`qaqh-sandbox/src/linux.rs` 的注释已经强调顺序：rlimit → landlock → seccomp → execvp）。

真正**不同**的部分其实很小（审批交互、diff 呈现、档位语义），真正**相同**的部分很大（隔离、观测、账本、恢复）。
按"相同的一起做，不同的分开做"切，才不会有第二套实现。

### 3.2 分层

```
┌─────────────────────────────────────────────────────────┐
│ bugent (Bun/TS)              qaqh-backend (Rust)        │
│  ├ 档位语义 / 审批弹窗        ├ 权限级别 / 审批           │
│  ├ diff → 模型上下文          ├ diff → timeline           │
│  ├ WorkspaceFileEdit 接线     ├ audit_ledger 接线         │
│  └ src/sandbox/wsbox-client   └ qaqh-wsbox-client         │
└───────────────┬──────────────────────────┬──────────────┘
                │  版本化 JSON 协议 (stdio / unix socket)
                ▼                          ▼
┌─────────────────────────────────────────────────────────┐
│ wsbox 引擎 (Rust 单二进制，静态链接)                       │
│  能力探测 · 会话 overlay/snapshot · 沙箱执行               │
│  文件系统观测 · CAS · 账本 · apply/revert/restore          │
└─────────────────────────────────────────────────────────┘
```

### 3.3 边界：什么进 SDK，什么留在 agent

| 进 SDK（共享） | 留在各 agent（各自） |
|---|---|
| userns / overlay / 挂载编排 | 档位概念（bugent 三档 vs qaqh `PermissionLevel`） |
| bwrap / landlock / seccomp / rlimit 施加 | 档位 → `SandboxSpec` 的编译 |
| 工作区扫描、whiteout 识别、diff 生成 | diff 怎么渲染给模型（token 预算、截断策略） |
| CAS、账本 JSONL、哈希链 | 审批交互（弹窗 / CLI / 无头） |
| apply / revert / restore / discard | 与 session / message / undo 的接线 |
| **缩水检测的判定**（阈值计算） | **缩水之后怎么办**（警告 / 拦截 / 自动回滚） |

最后两行是关键切分：**判定在 SDK（必须一致），处置在 agent（各产品不同）**。
否则阈值逻辑写两遍又会漂移。

引擎接受的是一个中性 spec，恰好两边都已经有了对应物：

- bugent：`src/sandbox/policy.ts` 的 `compileSandboxPolicy` → `NativeSandboxConfig`
- qaqh-backend：`qaqh_policy::SandboxSpec { enabled, backend, writable_roots, network, max_open_files }`

SDK 的 `SandboxSpec` 直接对齐后者，bugent 那侧做一次映射即可。

### 3.4 为什么不选纯 Bun+TS

`mount(2)` / `landlock_restrict_self(2)` / `unshare(2)` 不是 TS 能直接调的。
Bun 有 FFI，但把沙箱建立过程塞进 agent 进程有三个问题：

1. **失败模式耦合**：mount 失败或 landlock 装错，整个 agent 进程一起挂。
2. **顺序不可控**：沙箱必须在 `execve` 之前、且是子进程里完成；Bun 的 `pre_exec` 等价物不可靠。
3. **不可复用**：qaqh-backend 是 Rust，用不上。

bugent 现在走的就是这条最脆的路——`native/sandbox/provider.c` 通过 patch 过的 Bun runtime ABI 暴露：

```c
void* bun_spawn_sandbox_prepare(const char* config, size_t config_len, int* errno_out);
int   bun_spawn_sandbox_apply(void* state);
void  bun_spawn_sandbox_destroy(void* state);
```

ABI 一改就崩，且只能被 Bun 加载。**侧车二进制能直接把这个 ABI 从关键路径上摘掉。**

### 3.5 为什么不选纯 Rust

bugent 的 diff 注入、`WorkspaceFileEdit` 构造、session 落库、TUI 全在 TS（`src/tools/`、`src/core/session.ts`、`src/butui/`）。
把 agent 侧重写成 Rust 不划算，也没必要——两侧通过协议解耦即可。

### 3.6 与 qaqh-backend 现成件的关系

`crates/qaqh-sandbox` 已经有 Landlock + seccomp 实现（`src/linux.rs`）、helper 二进制（`src/bin/qaqh-sandbox-exec.rs`）、能力探测（`src/capability.rs` 的 `SandboxCapabilities`）。
`crates/qaqh-workspace/tests/audit_ledger.rs` 也已经有账本测试。

引擎最终落成了**独立仓库**（`/home/qaqtamsy/项目/wsbox`）而不是 qaqh-backend 里的一个 crate，
理由是它要被两个互不依赖的 agent 消费，挂在任一 agent 的仓库里都会让另一方产生反向依赖。

`landlock/seccomp` 目前是引擎的 TODO（阶段 3），届时按 `qaqh-sandbox/src/linux.rs` 的施加顺序
（rlimit → landlock → seccomp → execvp）实现——**顺序不能改**，那条注释是有原因的。

`SandboxCapabilities` 的字段可以直接映射到 SDK 的 `capabilities` 响应。

### 3.7 两种观测模式（必须都实现）

不是所有运行环境都能挂 overlay——qaqh-backend 的 `Dockerfile` 是 Ubuntu 26.04 的 CI/NPC 运行时，容器里 unprivileged userns 常常被 seccomp 关掉。
所以引擎必须有降级档：

| 模式 | 机制 | 真实工作区是否被直接写 | 前置条件 |
|---|---|---|---|
| `overlay` | userns + overlayfs，upper 承接全部写入 | **否** | unprivileged userns + overlayfs |
| `snapshot` | 调用前 `reflink`/`cp -a` 快照 + 调用后扫描 | 是（但有快照可回滚） | 只需文件读写 |
| `none` | 只记账不隔离 | 是 | 无 |

`overlay` 是强保证（内容不可能丢），`snapshot` 是弱保证（能回滚但存在窗口）。
`capabilities` 里必须如实报告拿到的是哪一种，**由各 agent 决定能不能接受降级**——这是产品策略，不是 SDK 能替它决定的。

## 4. 接口协议

引擎做成 `wsbox` 二进制 + 可选的 `wsboxd` 常驻进程，NDJSON（每行一个 JSON）双向通信，stdout 只走协议，日志走 stderr。

### 4.0 会话生命周期

```
capabilities                      -> 探测 userns / overlayfs / landlock ABI / fanotify
session.open {workspace, mode}    -> 分配 session，建 upper/ 或快照
  exec {call, argv, spec}         -> 沙箱内执行，返回 exitCode + changes[]
  exec ...
changes.diff / changes.show      -> 全会话或单次调用的 diff
apply | revert | restore | discard
session.close
```

一次调用一个 JSON 往返的 `wsbox run --request -` 是最小可用形态；
但**每个 session 一个常驻 `wsboxd`** 才是终态，因为：mount 生命周期、inotify/fanotify 监听、index 缓存、账本写入都在会话维度上，且省掉每次调用的进程启动。

### 4.1 session.open

```jsonc
{
  "protocol": 1,                   // 协议主版本；不匹配直接拒绝
  "method": "session.open",
  "params": {
    "session": "sess_7f3a",        // 会话账本 id（agent 侧生成，需全局唯一）
    "workspace": "/home/u/proj",   // 真实工作区（作为 lower）
    "mode": "overlay",             // overlay | snapshot | none | auto
    "freeze": false,               // true = 拷贝基线快照，而非直接用工作区当 lower
    "ledgerDir": "/home/u/.bugent/wsbox"
  }
}
```

返回实际生效的模式与能力，**agent 必须检查它，而不是假设自己拿到了 `overlay`**：

```jsonc
{
  "mode": "overlay",
  "capabilities": {
    "userNamespace": true,
    "overlayfs": true,
    "landlockAbi": 6,
    "fanotify": true,
    "fuse": true
  },
  "degraded": null                 // 非 null 时说明降级原因，例如 "user namespace disabled by seccomp"
}
```

### 4.2 exec

```jsonc
{
  "protocol": 1,
  "method": "exec",
  "params": {
    "call": "call_42",             // tool call id，账本用它做归因
    "cwd": "/home/u/proj",         // 沙箱内工作目录
    "argv": ["bash", "-lc", "python3 -c ..."],
    "spec": {                      // 中性 spec，对齐 qaqh_policy::SandboxSpec
      "enabled": true,
      "backend": "auto",           // auto | bubblewrap | landlock | none
      "writableRoots": ["/home/u/proj"],
      "network": "deny",           // deny | allow
      "maxOpenFiles": 1024
    },
    "timeoutMs": 120000
  }
}
```

`argv` 走请求体而不是命令行参数——qaqh-backend 的 `SandboxRequest` 注释里已经写了这个理由（避免 argv 长度限制）。

### 4.3 exec 响应

```jsonc
{
  "exitCode": 0,
  "durationMs": 812,
  "changes": [
    {
      "path": "app.py",
      "op": "modify",              // add | modify | delete | rename | chmod
      "beforeBytes": 55,
      "afterBytes": 0,
      "beforeSha": "5642e044978c",
      "afterSha": "e3b0c44298fc",
      "diff": "--- a/app.py\n+++ b/app.py\n@@ -1,4 +0,0 @@\n-...",
      "suspicious": true,
      "reason": "shrink-ratio 1.00"
    }
  ],
  "whiteouts": ["keep.txt"],
  "ledgerRef": "call_42",
  "truncatedDiff": false
}
```

### 4.4 CLI 形态

引擎同时提供一次性 CLI（给脚本、测试、无 daemon 场景）和 daemon 模式：

```
wsbox capabilities                        # 探测并打印能力矩阵
wsbox run --request -                     # 一次性执行（内部 session.open + exec + close）
wsboxd --socket <path>                    # 常驻，按 NDJSON 协议服务
wsbox diff    --session <id>              # 全会话累计 diff
wsbox apply   --session <id>              # 把 upper 原子应用到真实工作区
wsbox revert  --session <id> --call <id>  # 撤销某次调用（写回 before blob）
wsbox restore --session <id> --path a.py  # 恢复单个文件
wsbox discard --session <id>              # 丢弃整个会话的改动
```

### 4.5 版本与分发

两个 agent 独立发版，所以协议必须能独立演进：

- 请求里带 `protocol: 1`（**主版本**）。主版本不匹配 → 引擎直接拒绝并返回明确错误，不猜。
- 次要能力通过 `capabilities` 协商，不用版本号堆条件判断。
- 未知字段一律忽略（forward-compatible），未知 **method** 返回 `unsupported` 而不是崩溃。

分发路径：

| 消费方 | 方式 |
|---|---|
| qaqh-backend | 直接依赖 `crates/qaqh-wsbox`（client）+ 同 workspace 的 `qaqh-wsbox-engine` crate（也可 in-process 调用引擎库） |
| bugent | 通过 `scripts/package-bugent.ts` / `runtime/bun/lib/` 打包**预编译二进制**，跟现在打包 `libbugent-sandbox.so` 是同一条路径 |

bugent 侧客户端只有 spawn + NDJSON 解析 + 类型定义，预计 200~300 行 TS，放 `src/sandbox/wsbox/client.ts`。

### 4.6 一致性测试

只要引擎是同一个，客户端很薄，但**适配层仍会漂移**。用一份共享的黄金样例集锁住语义：

```
fixtures/
  truncate-to-zero.json       # python 把 8KB 文件写空
  delete-file.json            # rm
  atomic-rename.json          # tmpfile + rename（很多工具这么写）
  same-content-rewrite.json   # 改了又改回，不应产生 diff
  binary-file.json
  add-then-delete-in-one-call.json
  user-edit-during-session.json  # apply 时必须冲突
```

两边客户端跑同一份 fixtures，断言产出相同的 `changes[]`。这是防止两套适配层语义分叉的唯一有效手段。

## 5. 破坏性写入防护（针对"改空"）

这是原始痛点的正面回应，四层：

1. **真实工作区永不被直接写** —— 最坏情况是 upper 脏了，`discard` 即可，内容不可能丢。
2. **CAS 先存后写** —— 任何被覆盖的 before 内容在产生 diff 时就进了 `cas/<sha256>`。
3. **缩水闸门** —— `before >= 1KiB && after < 20% * before`（或 `after == 0`）→ 标记 `suspicious`，**不自动 apply**，进 pending 区等审批。
4. **diff 回传** —— 无论用的是什么命令，tool result 里都带上 diff 摘要。模型能看见自己造成的破坏，才有机会自纠。

第 3 条**刻意不做硬阻断**：合法的大规模重写是存在的，一刀切会逼模型反复重试。
正确做法是"允许继续在 overlay 里写，但把破坏摆在它面前"：

```text
⚠ 本次调用使 src/foo.py 从 8123B 缩到 41B（-99.5%）
   可能是错误锚定导致的内容丢失。diff 前 40 行如下...
   如非本意，可用 /restore src/foo.py 恢复。
```

## 6. apply / undo

### apply

```
for path in upper:
  if is_whiteout(path):            # char device 0:0
      delete(workspace/path)
  else:
      verify(sha(workspace/path) == index.baseline_sha(path))   # 冲突检测
      atomic_write(workspace/path, upper/path)                  # tmp + rename
```

冲突（用户在会话期间改过同一文件）→ 整批拒绝，不做"尽力而为"的写。
与 `src/core/workspace-undo.ts` 的 `applyWorkspaceUndo` 同一套哲学：**先全量校验，再统一写。**

### 与现有 undo 复用

`bash` 调用结束后，把 §4 响应里的 changes 转成现有的 `WorkspaceFileEdit`：

```ts
{ path, before, after, beforeExists, afterExists, reversible }
```

挂到 tool result 的 `workspace` 字段上（`src/core/session.ts:285` 那条路径）。
这样 **`/undo`、分支切换、消息回放、`planWorkspaceUndo` 全部零改动**就获得了对 bash 写入的支持。
这是本设计最大的杠杆点：不新造一套撤销，而是把外部写入接进已有的那条链。

⚠ 现有限制：`WorkspaceFileEdit.before/after` 是 `string`，二进制文件无法表示。
需要扩展为 `Uint8Array`，或对二进制标记 `reversible: false` + `irreversibleReason`。

### 与 git 的关系

- 沙箱内的 `.git` 也在 overlay 视图里，agent 跑 `git diff` 能看到自己的改动（`.git/index` 写入落在 upper）。
- apply 之后用户的 git 状态自然反映改动。
- 可选增强：用 shadow git（`git write-tree` 无提交快照 + `refs/agent/ledger/<session>`）替代 CAS 存文本 blob，换取免费的 diff/回放能力；二进制仍走 CAS。

## 7. 三档权限映射

| 档位 | overlay | 账本 | diff 回传 | apply |
|---|---|---|---|---|
| `read-only` | 不挂（根 + 工作区全 ro，同现状） | 无改动，只记调用 | — | — |
| `workspace-write` | ✅ upper = 会话 | ✅ | ✅（suspicious 高亮） | 需审批 |
| `approve-all` / `no-sandbox` | ✅ 仍挂（可 `--direct` 关闭） | ✅ | ✅ | 自动 |

`no-sandbox` 的语义是"不隔离"，但**账本仍有价值**——它拦不住写入，但保证写入可见、可退。
默认在 `no-sandbox` 下也记账；用户显式 `--direct` 才彻底关掉。

qaqh-backend 侧是同一张表的另一种命名（`PermissionLevel` → `SandboxSpec`），
映射发生在它的适配层，**引擎不感知"档位"这个概念**——引擎只认 `enabled` / `writableRoots` / `network`。
这是让同一套引擎服务两个 agent 的前提：档位是产品概念，不是沙箱概念。

## 8. 安全要点

1. **账本目录必须在沙箱内不可见。**
   `--ro-bind / /` 会把 `~/.bugent/wsbox/` 一起暴露出去，agent 一条 `rm -rf ~/.bugent/wsbox` 就能毁掉账本和 CAS。
   必须在 bwrap argv 里显式遮蔽：`--tmpfs ~/.bugent/wsbox`（或绑一个空目录）。
   **这条不写进去，整个设计就白做了。**
2. **upper 只能在宿主侧被写**。沙箱通过 merged 视图间接写 upper，不能直接访问。
3. `--unshare-net` / `--unshare-pid` / `--die-with-parent` / `--new-session` 保持现状。
4. Landlock 仍然叠加（`crates/qaqh-sandbox` 的现成实现），做 defense in depth：即使 overlay 建失败，也不能退化成"能写根"。
5. 环境变量过滤（`src/sandbox/env.ts`）不变。

## 9. 性能

| 环节 | 成本 |
|---|---|
| overlay mount/unmount | 每次调用 ~1ms（退出即消失，无长期挂载） |
| upper manifest 扫描 | O(会话累计改动文件数)，通常几十个 |
| sha256 | 只在 `(mtime_ns, size)` 变化时算 |
| CAS 写入 | 只对变化文件，内容寻址去重 |
| 首次 copy-up | 每个被写文件一次（overlay 内核行为） |

大文件策略：超过阈值（如 8MiB）不进 CAS，标记 `reversible: false` 并在 apply 时要求显式确认。

## 10. 已知限制

- **同一调用内"改了又改回"不可见**：overlay 只保留终态。要全保真需要 fanotify 或 FUSE 日志文件系统（阶段 3）。
- **overlay 要求 lower/upper 在同一文件系统**：实测 lower 在 ext4/btrfs、upper 在 tmpfs 会失败（`wrong fs type`）。`~/.bugent` 与工作区不同挂载点时需要退化为"upper 放工作区同盘"或 `fuse-overlayfs`。
- **whiteout 是 char device `0:0`**：扫描和 apply 都要显式识别，否则会当成普通文件处理。
- **硬链接 / xattr / ACL / sparse file**：overlay 语义正确但 diff 与 CAS 需要额外处理。
- **并发**：单 workspace 单 writer 锁；多 agent 并行要各自 upper + 显式 merge（参见 `docs/subagent-sandbox.md`）。
- **bwrap 挂载点必须已存在**：`--bind $MRG $WS` 的目标路径要先在沙箱根里存在，否则报 `Read-only file system`。

## 11. 分阶段落地

顺序原则：**先把引擎和协议做对，再接第一个 agent，最后接第二个。**
两个 agent 同时开工会让协议在还没定型时就被两边需求拉扯。

### 阶段 0 —— 引擎骨架（✅ 已完成，独立仓库）

引擎已落地在 `/home/qaqtamsy/项目/wsbox`（Rust，独立 git 仓库）：

- `capabilities`（真实探测 userns / overlayfs / landlock ABI / bwrap）
- `session.open`（overlay / snapshot / auto，如实报告降级）
- `exec`（userns + overlay + bwrap，逐调用 diff）
- `changes` / `apply` / `restore` / `discard` / `ledger.verify`
- CAS + 哈希链账本 + 冲突检测
- 协议冻结为 `protocol: 1`（`docs/protocol.md`）
- 25 个测试（10 单元 + 15 端到端）

关键实测结论（写进了 README 的 Security notes）：

- bwrap 自己挂不了 overlay，必须外层 `unshare -Ur -m`
- fork 出的子进程只能走裸 syscall —— 多线程父进程里 `format!` 会死锁
- 账本目录必须在 overlay bind **之后**遮蔽
- workspace 在 `/tmp` 下时不能 `--tmpfs /tmp`，否则 workspace 不可达

产出：`wsbox exec` 能跑通 §12 的前 8 条验收。

### 阶段 1 —— 接 bugent（反馈最快，先接它）

- `src/sandbox/wsbox/client.ts`：TS client（spawn + NDJSON）
- `src/sandbox/wsbox/adapter.ts`：`WsboxChange[]` → `WorkspaceFileEdit[]`
- `src/tools/bash.ts`：走 `wsbox exec`，把 changes 挂到 tool result
- 缩水告警注入 tool result
- 沙箱内遮蔽 `~/.bugent/wsbox`

产出：**bash 改的文件立刻有 diff、能 `/undo`、改空会被点名。**

### 阶段 2 —— 接 qaqh-backend

- `qaqh-workspace` 的 tool 执行路径改走 `qaqh-wsbox` client
- `PermissionLevel` → `SandboxSpec` 映射
- diff 接进 `audit_ledger` / timeline
- 跑同一份 fixtures，断言与 bugent 产出相同

### 阶段 3 —— 加固

- `snapshot` 降级模式（容器 / 无 userns 环境）
- `apply/revert/restore/discard` + 两边各自的审批 UI
- fanotify / FUSE 全保真写入日志（中间态、syscall 边界拒绝破坏性 truncate）
- 退役 `native/sandbox/provider.c` 的 Bun ABI 路径
- 多 agent 并行：per-agent upper + merge

## 12. 验收标准

引擎侧（两边共用，跑同一份 fixtures）：

1. `python -c "open('a.py','w').write('')"` 后，真实工作区 `a.py` 不变，响应里出现该文件的完整 diff。
2. 删除文件在 `changes[]` 里是 `op: "delete"`，不是"文件消失"。
3. `tmpfile + rename` 的原子写被正确识别为一次 modify。
4. 改了又改回同内容 → 不产生 diff。
5. 缩水超过阈值 → `suspicious: true` + `reason`，且 apply 被拦下。
6. 会话期间用户改了同一文件 → apply 报冲突，整批拒绝。
7. 未改动的文件不产生 CAS 条目、不产生 diff。
8. `node_modules/` 规模的目录不引入可测量开销（验证 copy-up 而非全量拷贝）。

bugent 侧：

9. 该次调用产生的 `WorkspaceFileChange` 能被 `/undo` 正确回滚。
10. 沙箱内 `rm -rf ~/.bugent/wsbox` 无效（路径被遮蔽）。

qaqh-backend 侧：

11. 容器内无 userns 时如实报告 `mode: "snapshot"` 且 `degraded` 非空，不静默降级。
12. 同一 fixtures 在 bugent 与 qaqh-backend 产出的 `changes[]` 逐字节相同。
