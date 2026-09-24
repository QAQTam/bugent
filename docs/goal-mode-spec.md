# bugent Goal Mode 2.0 Spec

> 状态：P0～P6 已落地（P5 auto_continue 默认关闭）
> 目标版本：bugent `0.1.0`
> 基线：bugent `0.0.0` / schema v9
> 参考：Codex thread goal、continuation、budget accounting、blocked audit，以及 bugent 现有 session / tool batch / branch / todo / ask_user。

## 1. 摘要

Goal Mode 不是“持久化 todo”，也不是“自动多跑几轮”。

它是一套跨 turn 的目标运行时：

```text
Goal
  -> Checkpoint
  -> Plan
  -> Todo
  -> Evidence
  -> Review
  -> Handoff
  -> Context Epoch
  -> Continuation
  -> Final Audit
```

一句话定义：

> Goal 管最终目标；Checkpoint 管阶段结果；Plan 管策略；Todo 管当前动作；Evidence 管完成依据；Review 负责独立验证；Handoff 管上下文压缩；Context Epoch 负责安全刷新上下文。

## 2. 核心原则

1. Goal 不能从普通任务自动推断，只能由用户或系统显式创建。
2. Goal 是持久状态，不能等于“最后一份 todo_write”。
3. Todo 完成不等于 Checkpoint 完成。
4. Checkpoint 完成不等于 Goal 完成。
5. Goal 完成必须经过最终完成审计，而不是最后一个 checkbox。
6. 实现者不能独自批准自己的 Checkpoint。
7. Context refresh 不是删除历史，而是创建新的 Context Epoch。
8. 不改写旧 msgid；动态内容只在安全边界追加。
9. 不把完整 todo 列表每轮自动注入；只注入当前快照和必要 delta。
10. 所有工具调用仍必须经过 `ToolRegistry.execute()`。

## 3. 当前代码基线

### 3.1 已有能力

- `AgentSession`：msgid、append-only、ToolBatch 协议、消息队列。
- `SessionStore`：SQLite、WAL、分支、消息、事件审计。
- `BranchService`：fork / undo / retry。
- `runTurn()`：单轮模型-工具循环。
- `ask_user`：TUI 多页问答。
- `todo_write`：整写覆盖的 todo，当前状态从消息历史派生。
- MCP / skills manifest：固定前缀与安全边界 delta。
- Activity spinner：idle / waiting / thinking / responding / tool / retrying / disconnected / aborted。
- 单文件二进制与 Bun fork runtime。

### 3.2 当前缺口

- 没有 Goal 持久状态。
- 没有 Plan 工具。
- 没有 Checkpoint。
- 没有 Evidence。
- 没有 Handoff。
- 没有 Context Epoch。
- 没有自动 continuation。
- 没有 token/time budget。
- 没有独立 reviewer。
- `todo_write` 无 checkpoint 关联，completed 也不强制证据。
- `InjectionSource` 没有 `goal` / `handoff` / `plan`。
- TUI 没有 Goal 状态与检查点面板。

## 4. 领域模型

### 4.1 Goal

```ts
type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

type GoalPhase =
  | "draft"
  | "inspecting"
  | "clarifying"
  | "planning"
  | "ready"
  | "executing"
  | "checkpoint_audit"
  | "handoff"
  | "epoch_switch"
  | "final_audit";
```

`status` 是生命周期，`phase` 是当前执行阶段。两者不能混成一个枚举。

Goal 字段：

```ts
interface Goal {
  id: string;
  sessionId: string;
  rawIntent: string;
  objective: string;
  successCriteria: Criterion[];
  constraints: string[];
  nonGoals: string[];
  riskPolicy: RiskPolicy;
  status: GoalStatus;
  phase: GoalPhase;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  continuationCount: number;
  blockedStreak: number;
  activeCheckpointId?: string;
  activeEpochId?: string;
  createdAt: number;
  updatedAt: number;
}
```

### 4.2 Checkpoint

Checkpoint 由模型设计，但由系统校验结构并持久化。

```ts
type CheckpointStatus =
  | "pending"
  | "active"
  | "verifying"
  | "reviewing"
  | "completed"
  | "blocked";

interface Checkpoint {
  id: string;
  goalId: string;
  order: number;
  title: string;
  deliverable: string;
  acceptanceCriteria: string[];
  evidenceRequired: string[];
  dependsOn: string[];
  status: CheckpointStatus;
  createdAt: number;
  completedAt?: number;
}
```

约束：

- 每个 Goal 建议 3～7 个 Checkpoint。
- 每个 Checkpoint 至少一条验收条件和一种证据。
- 禁止把“运行一次测试”“改一行代码”这种微步骤作为 Checkpoint。
- Checkpoint 的完成必须经过 verify + review。

### 4.3 Plan

Plan 是策略层，不是 Todo。

```ts
interface PlanRevision {
  id: string;
  goalId: string;
  revision: number;
  phases: PlanPhase[];
  assumptions: string[];
  createdAt: number;
}
```

Plan 变化产生新 revision，不改写旧 revision。

### 4.4 Todo

Todo 是当前 Checkpoint 的执行清单。

```ts
interface Todo {
  id: string;
  checkpointId: string;
  content: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  completionEvidence?: string[];
}
```

规则：

- 每次 `todo_write` 仍是整写覆盖。
- Goal 模式下 `completed` 必须有 `completionEvidence`。
- Todo 只能属于一个 Checkpoint。
- 不一次生成整个 Goal 的所有 Todo，只生成当前 Checkpoint。
- Checkpoint 完成后，为下一个 Checkpoint 重新生成 Todo。

### 4.5 Evidence

```ts
interface Evidence {
  id: string;
  goalId: string;
  checkpointId?: string;
  kind: "test" | "command" | "file" | "diff" | "runtime" | "review" | "user";
  summary: string;
  reference: string;
  digest?: string;
  command?: string;
  exitCode?: number;
  createdAt: number;
}
```

Evidence 必须指向当前状态：

- 测试：命令、退出码、输出摘要。
- 文件：路径和 hash。
- diff：base/head revision 或 diff hash。
- runtime：执行命令与可观察结果。
- user：明确的人工确认。

模型口头声明不是 Evidence。

### 4.6 Handoff

Handoff 不是“每轮生成一次的 LLM 总结”，而是每个 Goal 一份持续演进的权威工作文档。

```ts
interface Handoff {
  id: string;
  goalId: string;
  revision: number;
  status: "active" | "frozen" | "archived";
  updatedBy: "system" | "worker" | "reviewer" | "user";
  currentState: string;
  markdownPath: string;
  snapshotHash?: string;
  supersedesRevision?: number;
  createdAt: number;
  updatedAt: number;
}
```

规则：

- 默认只有一个 canonical handoff：`HANDOFF.md`。
- 每轮结束只更新必要章节，不重新生成整份文档。
- 事实章节由系统维护；模型只能通过结构化 patch 补写、订正和追加。
- 每个 Context Epoch 使用一个不可变 snapshot；canonical handoff 继续演进。
- 删除事实不是允许的操作；订正通过 `supersedes` / `corrects` 表达。

### 4.7 Context Epoch

```ts
interface ContextEpoch {
  id: string;
  goalId: string;
  branchId: string;
  parentEpochId?: string;
  checkpointId?: string;
  handoffId: string;
  reason: "checkpoint" | "context_limit" | "resume" | "blocked" | "manual";
  createdAt: number;
}
```

Epoch 是新的模型可见上下文边界。旧上下文保留在旧 branch。

## 5. 状态机

### 5.1 Goal

```text
draft
  -> inspecting
  -> clarifying
  -> planning
  -> ready
  -> executing
  -> checkpoint_audit
  -> handoff
  -> epoch_switch
  -> executing
  -> final_audit
  -> complete
```

异常分支：

```text
clarifying / executing
  -> paused
  -> active

executing
  -> blocked
  -> active

executing
  -> usage_limited
  -> active

executing
  -> budget_limited
  -> active（仅由用户提升预算后）

final_audit
  -> executing（审计失败）
  -> complete（审计通过）
```

### 5.2 Checkpoint

```text
pending
  -> active
  -> verifying
  -> reviewing
  -> completed
```

异常：

```text
verifying / reviewing
  -> active（需要 remediation）
  -> blocked（达到阻塞阈值）
```

### 5.3 Review

```text
requested
  -> running
  -> approved
  -> changes_requested
  -> blocked
```

## 6. 初始化协议

入口：

```text
/goal <raw intent>
```

### 6.1 Inspect

先检查，不立即提问：

- 最近对话指代；
- session title / preview；
- git status / diff / branch / recent commits；
- 失败测试；
- PR / issue；
- TODO / FIXME；
- 已有 plan / todo。

### 6.2 ask_user

只问无法从上下文得到的关键信息：

- 最终状态；
- 验收标准；
- 范围与非目标；
- 风险策略；
- 阻塞策略；
- token/time budget。

如果信息已明确，不重复提问。

### 6.3 Goal Compilation

生成 Goal Contract：

```text
objective
success_criteria
constraints
non_goals
risk_policy
```

如果 `success_criteria` 为空或无法形成证据计划，Goal 不能进入 `active`。

### 6.4 Plan

模型提出阶段计划：

```text
阶段
依赖
风险
验证方式
```

### 6.5 Checkpoint

模型根据 Plan 设计 Checkpoint。系统校验：

- 数量合理；
- 每项有交付物；
- 每项有验收条件；
- 每项有证据要求；
- 依赖无环；
- 不得把实现步骤伪装成阶段结果。

### 6.6 Todo

只为第一个 Checkpoint 生成 Todo。

### 6.7 Ready

满足以下条件后进入 `active`：

```text
objective 清楚
success criteria 可验证
constraints 明确
checkpoints 合法
todo 已建立
open questions 为空
```

高风险 Goal 在 active 前增加用户确认 gate。

## 7. 执行协议

### 7.1 普通 turn

Worker 按当前 Checkpoint 的 Todo 执行。

- 工具执行保持现有 ToolBatch 协议。
- Todo 变化通过 `todo_write` 整写。
- Goal/Plan/Checkpoint 变化产生新 revision 或新状态，不改写旧消息。

### 7.2 Todo 完成

一个 Todo 标为 completed 时必须带证据：

```json
{
  "id": "t3",
  "status": "completed",
  "completionEvidence": [
    "新增 tests/auth-refresh.test.ts",
    "bun test tests/auth-refresh.test.ts 通过"
  ]
}
```

没有证据：

- 工具返回错误；
- Todo 保持 in_progress；
- 系统注入 developer reminder。

### 7.3 Checkpoint Submit

所有 Todo 完成后，模型调用：

```text
submit_checkpoint
```

参数：

```text
checkpoint_id
summary
evidence[]
remaining_risk[]
```

状态：

```text
active -> verifying
```

### 7.4 确定性验证

系统执行：

- 验收条件映射检查；
- 测试/构建/类型检查；
- 文件和产物存在性；
- diff / commit / hash 校验；
- 安全规则检查。

### 7.5 独立 Review

Reviewer 在冻结快照上工作：

```text
base revision
head revision
diff hash
evidence
acceptance criteria
handoff
```

Reviewer 不能写文件、不能改 Goal、不能提交 checkpoint。

Review 输出：

```ts
interface ReviewResult {
  verdict: "approve" | "changes_requested" | "blocked";
  criteriaCoverage: Array<{
    criterion: string;
    status: "proven" | "partial" | "missing";
    evidence: string[];
  }>;
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    title: string;
    evidence: string;
    requestedChange?: string;
  }>;
  unresolvedQuestions: string[];
}
```

Checkpoint 通过条件：

```text
所有 criteria = proven
无 critical / high findings
确定性验证通过
无 unresolved questions
```

### 7.6 Review 失败

```text
changes_requested
  -> 生成 remediation todo
  -> checkpoint 回到 active
  -> 修复
  -> 新 review round
```

最多 2～3 轮；超过后：

- 请求用户决定；
- 或标记 Checkpoint blocked。

### 7.7 Checkpoint 完成

通过后：

```text
checkpoint.completed
  -> 记录 Evidence
  -> 写 Handoff
  -> 决定是否创建新 Context Epoch
  -> 激活下一个 Checkpoint
```

## 8. Living Handoff 与 Context Epoch

### 8.1 Handoff 模型

Handoff 不是“每轮重新生成的 LLM 总结”，而是一个 Goal 一份持续演进的权威工作文档：

```text
canonical HANDOFF.md
  -> 持续补登、订正、更新状态
  -> 每个 Context Epoch 从它生成不可变 snapshot
```

三个层次必须分开：

| 层次 | 内容 | 可变性 |
| --- | --- | --- |
| 系统事实 | Goal、Checkpoint、Evidence、Todo、usage、git、test | 系统维护，不靠模型记忆 |
| 模型叙事 | 判断、决策、原因、下一步、风险解释 | 模型通过 patch 更新 |
| Epoch snapshot | 某个时间点的完整 Handoff | 不可变，供恢复和审计 |

禁止：

- 每轮把旧 Handoff 交给 LLM 重新总结；
- 用一段自由文本覆盖完整事实；
- 删除旧事实；
- 让模型重写系统生成的证据和计数。

### 8.2 更新触发

不是每轮都创建 Handoff，而是只在有意义的事件更新：

- Goal 初始化完成；
- Checkpoint 开始；
- 完成一个 Todo 并增加 Evidence；
- 重要决策；
- 新 blocker / open question；
- Review 完成；
- Checkpoint 完成；
- Context 使用达到阈值；
- 用户暂停/恢复/编辑目标；
- Goal 完成或 blocked。

普通 turn 没有状态变化时，只更新 `Last Activity`，不重写文档。

### 8.3 标准 Markdown 格式

canonical 文件：

```text
~/.bugent/handoffs/<session_id>/<goal_id>/HANDOFF.md
```

snapshot：

```text
~/.bugent/handoffs/<session_id>/<goal_id>/epochs/<epoch_id>.md
```

建议模板：

```markdown
---
handoff_version: 1
goal_id: goal_...
session_id: sess_...
status: active
phase: executing
current_checkpoint: CP-003
revision: 12
updated_at: 2026-09-24T08:00:00Z
updated_by: worker
snapshot_hash: sha256:...
---

# Goal Handoff: <objective title>

> 这是持续维护的权威工作文档。事实章节由系统维护；叙事章节由 worker/reviewer 通过 patch 补登和订正。不要删除旧条目，使用 supersedes/corrects 记录变更。

## 1. Goal Contract

### Objective

<完整 objective>

### Success Criteria

| ID | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| SC-001 | ... | proven / partial / missing | E-... |

### Constraints

- C-...

### Non-goals

- NG-...

### Budget

| Item | Used | Limit | Remaining |
| --- | --- | --- | --- |
| Tokens | 12.5K | 50K | 37.5K |
| Active time | 18m | - | - |

## 2. Current State

- Goal status: active
- Phase: executing
- Current checkpoint: CP-003
- Current todo: T-004
- Last verified revision: <commit/diff hash>
- Next action: ...
- Blockers: B-...
- Open questions: Q-...

## 3. Checkpoints

| ID | Order | Title | Status | Acceptance | Evidence | Review |
| --- | --- | --- | --- | --- | --- | --- |
| CP-001 | 1 | ... | completed | ... | E-001 | R-001 |
| CP-002 | 2 | ... | completed | ... | E-003 | R-002 |
| CP-003 | 3 | ... | active | ... | - | - |

## 4. Plan

### Revision 3

| Phase | Checkpoints | Status | Notes |
| --- | --- | --- | --- |
| P1 | CP-001..CP-002 | completed | ... |
| P2 | CP-003..CP-004 | active | ... |

### Assumptions

- A-...

## 5. Todo Snapshot

| ID | Checkpoint | Task | Status | Evidence |
| --- | --- | --- | --- | --- |
| T-001 | CP-003 | ... | completed | E-... |
| T-002 | CP-003 | ... | in_progress | - |

## 6. Evidence Ledger

| ID | Checkpoint | Kind | Command / Artifact | Result | Digest | Created |
| --- | --- | --- | --- | --- | --- | --- |
| E-001 | CP-001 | test | `bun test ...` | exit 0 | sha256:... | ... |
| E-002 | CP-001 | file | `src/...` | present | sha256:... | ... |

## 7. Work Log

> 只追加，不覆盖。订正使用 C-* 条目并引用被订正条目。

### W-0001 · 2026-09-24T...

- Actor: worker
- Action: ...
- Result: ...
- Evidence: E-...
- Next: ...

### W-0002 · ...

## 8. Decisions

### D-0001 · <decision title>

- Status: accepted / superseded
- Context: ...
- Decision: ...
- Rationale: ...
- Consequences: ...
- Evidence: E-...
- Supersedes: D-...

## 9. Risks and Blockers

| ID | Severity | Status | Risk / Blocker | Mitigation | Next Check |
| --- | --- | --- | --- | --- | --- |
| B-001 | high | open | ... | ... | ... |

## 10. Open Questions

| ID | Question | Needed For | Asked To | Status | Answer |
| --- | --- | --- | --- | --- | --- |
| Q-001 | ... | CP-003 | user | open | - |

## 11. File / Artifact Map

| Path / Artifact | Purpose | State | Hash / Revision |
| --- | --- | --- | --- |
| `src/...` | ... | changed | sha256:... |

## 12. Verification

| Check | Scope | Command | Last Result | Revision |
| --- | --- | --- | --- | --- |
| tests | auth | `bun test tests/auth.test.ts` | pass | abc123 |

## 13. Review History

| Round | Checkpoint | Verdict | Findings | Resolution |
| --- | --- | --- | --- | --- |
| R-001 | CP-001 | approve | 0 high | - |
| R-002 | CP-002 | changes_requested | 1 high | fixed |

## 14. Context Epoch Index

| Epoch | Branch | Reason | Snapshot | Resume Point |
| --- | --- | --- | --- | --- |
| EP-001 | branch_... | checkpoint CP-002 | epoch_...md | CP-003 |

## 15. Revision History

| Revision | Time | Actor | Operation | Snapshot |
| --- | --- | --- | --- | --- |
| 11 | ... | system | checkpoint completed | sha256:... |
| 12 | ... | worker | current state update | sha256:... |
```

### 8.4 章节可变性

| 章节 | 规则 |
| --- | --- |
| Goal Contract | 系统事实，objective 修改需用户确认 |
| Current State | 可更新，但保留 revision |
| Checkpoints | 状态由系统状态机更新 |
| Plan | 版本化，不覆盖旧 revision |
| Todo Snapshot | 当前快照可替换，历史保留 revision |
| Evidence Ledger | 只追加 |
| Work Log | 只追加 |
| Decisions | 只追加，supersede 旧决策 |
| Risks / Blockers | 可更新状态，不删除历史 |
| Open Questions | 可更新答案，不删除问题 |
| File Map | 可更新当前状态，保留 revision |
| Verification | 只追加结果 |
| Review History | 只追加 |
| Context Epoch Index | 只追加 |
| Revision History | 系统生成，只追加 |

### 8.5 订正规则

禁止直接改掉旧事实。

订正必须表达：

```text
corrects: W-0007
reason: ...
old_value: ...
new_value: ...
evidence: E-...
```

如果订正影响已完成 Checkpoint：

- Checkpoint 回到 `verifying`；
- 关联 Review 标记 `stale`；
- 重新验证；
- 生成新 Handoff revision。

### 8.6 Handoff Patch API

模型不能整文件覆写，使用结构化 patch：

```ts
type HandoffPatch =
  | { op: "set_current_state"; value: CurrentState }
  | { op: "upsert_checkpoint"; checkpoint: Checkpoint }
  | { op: "append_work_log"; entry: WorkLogEntry }
  | { op: "append_evidence"; evidence: Evidence }
  | { op: "append_decision"; decision: Decision }
  | { op: "update_question"; id: string; status: string; answer?: string }
  | { op: "update_blocker"; id: string; status: string; nextCheck?: string }
  | { op: "correct_entry"; targetId: string; reason: string; patch: unknown }
  | { op: "set_next_action"; value: string };

interface HandoffUpdate {
  baseRevision: number;
  actor: "system" | "worker" | "reviewer" | "user";
  patches: HandoffPatch[];
}
```

规则：

- `baseRevision` 过期则拒绝；
- patch 必须通过 schema 校验；
- 系统事实章节不能被 worker patch 覆盖；
- 每次成功 patch 产生新 revision；
- revision 只追加，不覆盖历史。

### 8.7 Epoch Snapshot

创建 Context Epoch 时：

```text
canonical HANDOFF.md revision N
  -> 生成 epoch snapshot
  -> snapshot 不可变
  -> Epoch 记录 snapshot_hash
```

之后 canonical Handoff 可以继续更新，但已创建的 Epoch 永远引用它创建时的 snapshot。

### 8.8 Context Epoch 创建

只能在安全边界创建：

- 无 open ToolBatch；
- 无排队 user message；
- 无正在执行的工具；
- 已完成 Handoff snapshot。

创建流程：

```text
1. 创建新 branch
2. 从 msgid 0 作为 epoch root
3. 写入新的 seed messages
4. 切换 session active branch
5. 旧 branch 保留
```

### 8.9 Epoch Seed 顺序

新 session：

```text
msgid0 system prompt
msgid1 MCP manifest
msgid2 skills manifest
msgid3 goal contract
msgid4 checkpoint/plan/todo snapshot
msgid5 handoff snapshot
msgid6 continuation steering
```

已有 session：

- 不重编号；
- 新 epoch 使用新的 msgid；
- 语义顺序保持一致；
- 旧 msgid1/2 不被改写。

### 8.10 Handoff 读取

- snapshot ≤ 32 KiB：直接作为 developer message 注入。
- snapshot > 32 KiB：注入 `Current State + Checkpoints + Open Questions + Next Action`，并要求新 epoch 第一个工具调用为 `get_handoff`。
- `get_handoff` 默认返回 canonical 最新 revision，也可按 epoch 返回 snapshot。
- 新 epoch 的 developer instruction 必须声明：

> Handoff snapshot 与当前工作区是权威状态；不要把旧记忆当成当前事实。不要重新总结 Handoff，除非发现事实错误并通过 correction patch 记录。

### 8.11 Todo 注入

- 新 Epoch 只注入当前 Todo 快照一次。
- 之后 Todo 变化作为 developer delta 追加。
- 不每轮全量注入 Todo。
- 不自动注入历史 Todo revision。

## 9. Continuation

### 9.1 自动继续条件

```text
goal.status = active
goal.phase = executing/ready
没有 waiting_user
没有 open ToolBatch
没有 queued user
没有正在执行的工具
没有 pause
没有 budget/usage limit
没有未完成 review
```

### 9.2 优先级

```text
用户新输入
  > 排队用户消息
  > goal continuation
```

Goal continuation 不能抢占用户输入。

### 9.3 Steering Prompt

```text
Continue working toward the active goal.

<goal_context>
objective
success criteria
current checkpoint
acceptance criteria
constraints
budget
</goal_context>

<handoff_context>
completed evidence
remaining work
blockers
next action
</handoff_context>

<todo_context>
current todo snapshot
</todo_context>
```

Continuation prompt 必须要求：

- 以当前工作区为权威；
- 不缩小目标；
- 判断上一轮 progress / verified wait / no progress；
- 完成前逐项验证；
- 不把计划更新当作实际进展。

### 9.4 No-progress

每轮分类：

```text
progress
verified_wait
no_progress
```

- `progress`：权威状态变化或获得新证据。
- `verified_wait`：轮询已确认存在的进程/任务/handle。
- `no_progress`：只是重述计划、重复状态、没有新证据。

同一真实阻塞连续 3 个 Goal turn 才可进入 `blocked`。

缺少用户信息不算 blocked，进入 `waiting_user` 并 defer continuation。

## 10. 预算与停止

### 10.1 Token Budget

累计：

- 每次 provider usage 的 input + output；
- 可按需记录 cached token；
- 每个 Goal turn 增量记账。

达到预算：

```text
goal.status = budget_limited
```

允许一个收尾 turn，但不能开始新的实质工作。

### 10.2 Time Budget

只统计 active Goal turn 时间，不计 idle 时间。

### 10.3 Usage Limit

provider 返回配额限制：

```text
goal.status = usage_limited
```

停止自动 continuation，等待用户恢复。

### 10.4 Error

- 可重试 provider 错误：由 provider/retry controller 处理。
- 不可重试或重试耗尽：停止 continuation，Goal 进入 blocked/paused，防止错误循环。
- Abort：不自动继续。

## 11. 最终完成审计

所有 Checkpoint 完成后：

```text
final_audit
```

检查：

- 每条 success criterion 是否有证据；
- 每个显式要求是否覆盖；
- 是否有 open question；
- 是否有 unresolved blocker；
- 是否有未验证范围；
- 是否缩小了原始目标；
- 最终独立 reviewer 是否 approve。

只有全部通过：

```text
goal.status = complete
```

最后一个 checkbox 不是完成条件。

## 12. 子代理 Review

### 12.1 角色

```text
Worker：实现
Verifier：确定性验证
Reviewer：独立审查
User：高风险授权
GoalController：状态推进
```

### 12.2 Reviewer 隔离

- 新 session / agent；
- 独立 context；
- 只读 workspace；
- 可运行测试；
- 不可写文件；
- 不可改 Goal；
- 不可提交 Checkpoint；
- 不能与 Worker 共享私有推理链。

### 12.3 Review 分级

| 风险 | 要求 |
| --- | --- |
| 低 | 自动验证 |
| 中 | 自动验证 + 独立 review |
| 高 | 自动验证 + 独立 review + 用户 gate |
| 极高 | 多 reviewer + 用户 gate |

Reviewer 模型可配置：

```toml
[goals]
review_policy = "medium" # off | medium | high | always
review_model = "openai/deepseek-v4.1-flash"
```

## 13. 持久化设计

Schema v10 新增表：

```text
session_goals
goal_checkpoints
goal_plan_revisions
goal_todo_snapshots
goal_evidence
goal_handoffs
goal_epochs
goal_turn_accounting
goal_reviews
goal_review_findings
```

### 13.1 session_goals

```text
goal_id TEXT PRIMARY KEY
session_id TEXT NOT NULL
raw_intent TEXT NOT NULL
objective TEXT NOT NULL
success_criteria TEXT NOT NULL
constraints TEXT NOT NULL
non_goals TEXT NOT NULL
risk_policy TEXT NOT NULL
status TEXT NOT NULL
phase TEXT NOT NULL
token_budget INTEGER
tokens_used INTEGER NOT NULL
time_used_seconds INTEGER NOT NULL
continuation_count INTEGER NOT NULL
blocked_streak INTEGER NOT NULL
active_checkpoint_id TEXT
active_epoch_id TEXT
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
```

### 13.2 goal_checkpoints

```text
checkpoint_id TEXT PRIMARY KEY
goal_id TEXT NOT NULL
ordinal INTEGER NOT NULL
title TEXT NOT NULL
deliverable TEXT NOT NULL
acceptance_criteria TEXT NOT NULL
evidence_required TEXT NOT NULL
depends_on TEXT NOT NULL
status TEXT NOT NULL
created_at INTEGER NOT NULL
completed_at INTEGER
```

### 13.3 goal_evidence

```text
evidence_id TEXT PRIMARY KEY
goal_id TEXT NOT NULL
checkpoint_id TEXT
kind TEXT NOT NULL
summary TEXT NOT NULL
reference TEXT NOT NULL
digest TEXT
command TEXT
exit_code INTEGER
created_at INTEGER NOT NULL
```

### 13.4 goal_handoffs

```text
handoff_id TEXT PRIMARY KEY
goal_id TEXT NOT NULL
revision INTEGER NOT NULL
status TEXT NOT NULL
updated_by TEXT NOT NULL
current_state TEXT NOT NULL
markdown_path TEXT NOT NULL
snapshot_hash TEXT
supersedes_revision INTEGER
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
UNIQUE(goal_id, revision)
```

canonical `HANDOFF.md` 是当前工作文档；每个 revision 可生成不可变 snapshot。数据库保存 revision 元数据和结构化事实，Markdown 保存人类可读版本。

### 13.5 goal_epochs

```text
epoch_id TEXT PRIMARY KEY
goal_id TEXT NOT NULL
branch_id TEXT NOT NULL
parent_epoch_id TEXT
checkpoint_id TEXT
handoff_id TEXT NOT NULL
handoff_revision INTEGER NOT NULL
handoff_snapshot_hash TEXT NOT NULL
reason TEXT NOT NULL
created_at INTEGER NOT NULL
```

## 14. 代码接线

### 14.1 `src/core/message.ts`

`InjectionSource` 增加：

```text
goal
plan
checkpoint
handoff
review
```

### 14.2 `src/core/session.ts`

新增：

```text
appendGoalContext()
appendPlanSnapshot()
appendHandoffContext()
```

保持：

- 不插入 ToolBatch；
- 不改写旧 msgid；
- 只追加。

### 14.3 `src/core/loop.ts`

保持 loop 纯粹。新增 hooks：

```ts
onUsage?(usage: Usage): void;
onTurnFinished?(result: TurnResult): void;
onTurnError?(error: unknown): void;
```

Goal continuation 由 `GoalController` 调用 `runTurn()`，不要让 loop 直接认识 Goal。

### 14.4 `src/core/runtime.ts`

`SessionRuntime` 持有：

```text
GoalController
GoalStore
ReviewRunner
LivingHandoffBuilder
ContextEpochManager
```

### 14.5 `src/store/db.ts`

- `SCHEMA_VERSION = 10`
- v9 -> v10 migration
- 新表与索引

### 14.6 `src/store/repository.ts`

新增：

```text
GoalRepository
CheckpointRepository
EvidenceRepository
HandoffRepository
EpochRepository
ReviewRepository
```

### 14.7 `src/tools/todo.ts`

Goal 模式扩展：

- `checkpointId`
- `completionEvidence`
- completed 必须带证据
- 校验 todo 只属于当前 checkpoint

### 14.8 `src/tui/app.ts`

新增：

- Goal 状态栏
- `/goal` 菜单
- `/goal checkpoints`
- checkpoint progress
- review 状态
- handoff/epoch boundary
- Goal activity 状态

## 15. 工具契约

### 15.1 `get_goal`

返回当前 Goal、状态、phase、预算、checkpoint progress。

### 15.2 `create_goal`

只在显式 `/goal` 或系统指令下调用。

参数：

```text
objective
success_criteria
constraints
token_budget?
```

### 15.3 `update_goal`

模型只可提交：

```text
complete
blocked
paused
```

`active` / resume / budget_limited / usage_limited 由用户或系统控制。

### 15.4 `update_plan`

参数：

```text
phases
checkpoints
assumptions
```

系统校验 checkpoint 结构。

### 15.5 `todo_write`

沿用整写覆盖，新增 checkpoint 关联与 evidence。

### 15.6 `submit_checkpoint`

参数：

```text
checkpoint_id
summary
evidence[]
remaining_risk[]
```

提交后进入 verifying/reviewing。

### 15.7 `get_handoff`

返回 canonical 最新 revision，或按 epoch 返回不可变 snapshot。返回内容包含 revision、snapshot hash 和完整 Markdown。

### 15.8 `handoff_update`

通过结构化 patch 更新 canonical handoff：

```text
base_revision
actor
patches[]
```

不允许整文件覆盖；系统事实章节由系统维护；worker 只能更新叙事、决策、风险、问题、下一步等允许章节。

## 16. UI / UX

### 16.1 状态栏

```text
Pursuing goal · 3/7 checkpoints · 12.5K/50K
```

状态：

```text
Goal paused (/goal resume)
Goal stalled (/goal resume)
Goal hit usage limits (/goal resume)
Goal unmet (63.9K/50K)
Goal achieved (40K tokens)
```

### 16.2 `/goal`

显示：

```text
Goal: ...
Status: active
Phase: executing checkpoint 3/7
Current: 并发刷新去重
Budget: 12.5K / 50K
Time: 18m
```

### 16.3 `/goal checkpoints`

```text
[x] 1. 梳理现有 refresh 流程
[x] 2. 补并发回归测试
[>] 3. 合并并发 refresh
[ ] 4. 处理失败回滚
[ ] 5. 全量验证
```

### 16.4 `/goal` 子命令

```text
/goal
/goal checkpoints
/goal continue
/goal pause
/goal resume
/goal edit
/goal clear
```

### 16.5 Activity Spinner

新增状态：

```text
goal_init
goal_plan
goal_checkpoint
goal_review
goal_handoff
goal_audit
waiting_user
```

## 17. 配置

```toml
[goals]
enabled = false
auto_continue = false
max_consecutive_turns = 50
max_goal_token_budget = 200000
context_refresh = "checkpoint" # checkpoint | threshold | manual
handoff_inline_bytes = 32768
review_policy = "medium" # off | medium | high | always
review_model = "openai/deepseek-v4.1-flash"
```

发布阶段：

- P0～P4：`enabled = false`
- P5：实验开启
- 稳定后默认开启 Goal，但仍要求显式 `/goal`

## 18. 测试与验收

### 18.1 单元测试

- Goal 状态机
- Checkpoint 状态机
- 预算累计
- blocked audit
- todo evidence 校验
- schema v9 -> v10
- injection 安全边界
- cache 前缀稳定性
- handoff 脱敏
- review verdict 规则

### 18.2 集成测试

- `/goal` 初始化
- ask_user -> plan -> checkpoint -> todo
- checkpoint verify/review
- review changes_requested -> remediation
- checkpoint handoff
- context epoch 创建
- resume 后读取 handoff
- auto continuation
- user 输入优先于 continuation
- crash recovery
- budget limit
- usage limit
- blocked 3 turn

### 18.3 PTY 测试

- `/goal` 菜单
- status line
- pause / resume / edit / clear
- checkpoint 列表
- review 状态
- handoff/epoch 边界
- activity spinner

### 18.4 安全测试

- reviewer 无写权限
- handoff 不含 secret
- Goal objective 不作为高优先级指令
- context refresh 不破坏 ToolBatch
- 旧 msgid 不被改写
- 不自动注入完整 todo 历史

## 19. 实施阶段

### P0：基础模型

- 本文档
- Goal/Checkpoint/Plan/Todo/Evidence 类型
- schema v10
- repository
- 单元测试

### P1：Goal Contract

- `/goal`
- get/create/update goal
- ask_user 初始化
- Goal 状态栏

### P2：Plan / Checkpoint / Todo

- update_plan
- checkpoint 校验
- todo checkpoint 关联
- evidence 校验

### P3：Verification / Review

- deterministic verifier
- read-only reviewer
- review rounds
- checkpoint complete gate

### P4：Handoff / Context Epoch

- handoff builder
- epoch branch
- seed messages
- get_handoff
- 手动 continue

### P5：Automatic Continuation

- idle continuation
- budget/time accounting
- waiting_user deferral
- no-progress/blocked audit

### P6：Final Audit / UX

- final goal review
- goal menu
- checkpoint UI
- crash/resume
- experimental enable

## 20. 非目标

- 不把 Goal 等同于 Todo。
- 不每轮自动注入完整 Todo。
- 不删除旧对话历史。
- 不改写 msgid0/1/2。
- 不让 Reviewer 修改代码或 Goal。
- 不让模型自行 resume / 提升预算 / 解除 usage limit。
- 不从普通任务自动创建 Goal。
- 不在 ToolBatch 中间刷新 Context Epoch。

## 21. 验收定义

Goal Mode 2.0 可发布的最低标准：

1. `/goal` 可以完成 inspect -> ask_user -> plan -> checkpoint -> todo -> active。
2. Todo 完成后必须提交证据。
3. Checkpoint 必须通过 deterministic verification 和 independent review。
4. Checkpoint 完成后能生成 handoff 并创建 context epoch。
5. 新 epoch 能通过 goal + handoff + plan/todo 继续推进。
6. 用户输入始终优先于 goal continuation。
7. Goal 完成必须经过 final audit，而不是最后一个 checkbox。
8. budget/blocked/usage/paused 状态可恢复且可审计。
9. 所有历史分支保留，旧 msgid 不被改写。
10. Reviewer 无法修改 workspace 或 Goal 状态。
