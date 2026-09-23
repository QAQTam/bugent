# bugent Handoff

> 更新时间：2026-09-24  
> 分支：`master`  
> 最新提交：`5e82597 feat(provider): 支持 reasoning replay`

## 1. 当前状态

已验证：

```bash
bun test
# 424 pass / 0 fail

bun run typecheck
# clean
```

工作区只有两个既有未跟踪探针，不要提交：

```text
scripts/xw-probe.ts
scripts/xw-probe2.ts
```

测试真实模型时只使用：

```text
deepseek-v4.1-flash
hy4 系列
```

其他模型视为付费，不使用。

## 2. 最近已完成的能力

### 2.1 reasoning replay

提交：`5e82597`

reasoning 现在：

- 实时进入 TUI 思考行；
- 累积到 assistant 消息；
- 持久化到 SQLite `messages.reasoning`；
- 进入 `buildContext()`；
- 由 OpenAI Chat adapter 按配置回放。

配置：

```toml
[[providers]]
reasoning_replay = "reasoning"
# reasoning | reasoning_content | both | none
```

当前 schema 版本：

```text
SCHEMA_VERSION = 4
```

### 2.2 思考链路 UI

- 青色菊花帧：`✻ ✽ ✶ ✳ ✢`
- 80ms 帧动画
- 土金色正文
- TUI 展示仍是 O(1) 缓冲
- 在 assistant 消息边界、turn 结束、branch/runtime 切换和 `/new` 时 reset

注意：

- TUI 的 `ThinkingBuffer` 是展示态；
- `StoredMessage.reasoning` 是协议回放态；
- 两者生命周期不同，不要混用。

## 3. 当前待解决的核心问题

### 3.1 工具调用必须成对且连续

严格 provider 要求：

```text
assistant(tool_calls=[tc1, tc2, tc3])
tool(tr1)
tool(tr2)
tool(tr3)
```

中间不能插入：

- user
- injection
- assistant
- 新 tool call batch
- 缺失/错序的 tool result

否则可能返回：

```text
400
code=11148
tool_call_sequence_broken
tool calls and tool results do not match
```

### 3.2 已做真实取证

使用 wbproxy：

```text
http://127.0.0.1:8787/v1
```

#### hy4-preview-f

两组异常请求都返回 200：

- 孤立 tool call
- tool call 与 tool result 中间插 user

说明该上游/模型当前比较宽容，但不能依赖。

#### deepseek-v4.1-flash

同样两组请求都返回 400：

```text
code=11148
tool_call_sequence_broken
```

结论：

> 工具消息配对必须在 bugent 内部保证，不能靠 provider 容错。

## 4. 设计原则

不要把所有消息放进一个普通 FIFO。分成三种优先级：

```text
P0  tool result batch      事务性屏障
P1  injection             安全边界消息
P2  user message          turn 边界消息
```

### 4.1 ToolBatch

建议在 `AgentSession` 内维护：

```ts
interface OpenToolBatch {
  calls: readonly ToolCall[];
  results: Map<string, StoredMessage>;
  nextToFlush: number;
}
```

规则：

- assistant 带 tool calls 落库后，立即开启 batch。
- batch 开启期间禁止 append user / inject / 新 assistant。
- tool result 只能写入当前 batch。
- 并发工具结果先暂存，按 `calls` 顺序 flush。
- batch 未关闭前不允许发下一次 provider 请求。

正常流程：

```text
appendAssistant(text, [tc1, tc2, tc3])
beginToolBatch([tc1, tc2, tc3])

toolResult(tc2) -> buffer
toolResult(tc1) -> buffer
toolResult(tc3) -> buffer

flushToolResultsInOrder()
closeToolBatch()
```

当前 loop 顺序执行工具，天然接近这个顺序；未来并发工具、MCP、子 agent
必须依赖 batch 保证协议安全。

### 4.2 abort / 异常补齐

如果工具结果缺失：

```text
A(tc1,tc2,tc3)
T(tr1)
abort
```

必须补齐：

```text
T(tr1)
T(Error: tool result missing due abort)  // tc2
T(Error: tool result missing due abort)  // tc3
```

补齐按原 tool call 顺序写入。

需要两层保障：

1. `runTurn` 的 `finally`：当前进程内补齐。
2. `openSession` 恢复时：扫描历史里的孤立 tool call，做 crash recovery。

否则进程在 tc1 和 tc2 之间被杀，resume 后仍会 400。

## 5. 消息队列设计

### 5.1 队列类型

```ts
type UserQueueItem = {
  kind: "user";
  text: string;
  createdAt: number;
};

type InjectionQueueItem = {
  kind: "inject";
  text: string;
  source: "mcp" | "skill" | "system" | "snapshot";
  createdAt: number;
};
```

工具结果不进入普通队列。工具结果属于 `ToolBatch`。

### 5.2 Flush 边界

| 内容 | 写入时机 |
|---|---|
| tool result | 当前 ToolBatch 内，按 call 顺序 |
| injection | 没有 open batch 的模型步边界 |
| user | 当前 turn 完全结束后 |
| permission response | 不属于消息队列 |
| ask_user answer | 属于当前 tool execution，不 append user |
| abort | 先补齐 ToolBatch，再结束 turn |

### 5.3 默认语义

默认用户输入不插队当前 turn，只排到下一 turn：

```text
turn running
  -> user submits new text
  -> queue it
  -> show [已排队 N]

turn end
  -> drain user queue
  -> start next runUserTurn
```

显式 ESC abort 后：

- 先补齐 tool batch；
- 不自动启动排队消息；
- 显示 `[已排队 N]`，由用户决定何时继续。

未来若要做“用户插话”，应单独设计：

```text
steer / interrupt command
```

不要复用普通 user 输入。

## 6. Retry 语义

retry 不走消息队列。

正确语义：

```text
旧 branch:
  U1 A1 U2 A2

retry U2:
  -> 创建新 branch
  -> 截断到 U2 之前
  -> 在新 branch append 一次 U2
  -> 在新 branch run
```

也就是：

```text
新 branch:
  U1 A1 U2(new msgid)
```

不是：

```text
旧 branch
+ inject U2
+ run
```

规则：

- retry 使用新 branch；
- 不复用旧 queue；
- 不额外注入旧 user message；
- 新 branch 的 session 从空队列开始；
- 旧 branch 的排队消息默认不带入新 branch，需清空并提示。

消息队列和 retry 是两套机制，但边界必须明确。

## 7. 建议 API

```ts
type SubmitResult =
  | { status: "started"; msgid: number }
  | { status: "queued"; position: number };

class AgentSession {
  submitUser(text: string): SubmitResult;
  enqueueInjection(text: string, source: string): void;

  beginToolBatch(calls: readonly ToolCall[]): void;
  appendToolResult(callId: string, text: string): void;
  finishToolBatch(): void;

  hasOpenToolBatch(): boolean;
  drainInjectionsAtSafeBoundary(): void;
  dequeueUserAfterTurn(): string | undefined;
}
```

`appendUser` 可以保留为低层 API，但应加断言：

```ts
if (openToolBatch || turnActive) {
  throw new Error("user message cannot be appended inside an active turn/tool batch");
}
```

避免其他模块绕过队列直接插队。

## 8. TUI 需要的变化

当前风险：

- `#submit()` 在 busy 时没有阻止新 turn；
- 新 `runTurn` 可能与当前 tool batch 并发；
- 从而把 user message 插进 tool call / tool result 之间。

建议：

- `#submit()` 先调用 `session.submitUser(text)`；
- busy 时只显示 `[已排队 N]`；
- turn 正常结束后自动 drain user queue；
- 状态栏显示排队数量；
- abort 后保留队列，不自动执行；
- branch/runtime switch 时清空旧队列。

## 9. 测试清单

必须补：

1. `tc1,tc2,tc3 -> tr1,tr2,tr3` 顺序。
2. batch 内提交 user，最终顺序：

```text
A(tc1,tc2)
T(tr1)
T(tr2)
U(new)
```

不能变成：

```text
A(tc1,tc2)
U(new)
T(tr1)
T(tr2)
```

3. batch 内注入 skill/MCP，必须在 batch 后。
4. 并发工具结果乱序到达，最终按 call 顺序 flush。
5. abort 后补齐 synthetic tool results。
6. crash recovery：resume 后修复孤立 tool calls。
7. retry：旧 branch 不变，新 branch 只出现一次原 user message。
8. 真实 provider：
   - deepseek-v4.1-flash 异常顺序返回 400 / 11148；
   - 修复后的顺序返回 200。

## 10. 实施顺序建议

### Phase A：协议安全

- ToolBatch
- 工具结果顺序
- abort/crash 补齐
- batch 内禁止插队
- 回归测试

### Phase B：消息队列

- user queue
- injection queue
- TUI `[已排队 N]`
- turn 结束后 drain
- retry / branch switch 清空旧队列

### Phase C：并发工具

- 并行执行
- result buffer
- 按 call 顺序 flush
- 与权限、ask_user、abort 的交互测试

## 11. 不要做的事

- 不要把所有消息塞进一个普通 FIFO。
- 不要依赖 hy4-preview-f 的宽容行为。
- 不要在 tool batch 中间注入 user / MCP / skill。
- 不要让 retry 通过队列额外注入 user message。
- 不要把 TUI `ThinkingBuffer` 当成协议 reasoning 存储。
- 不要提交 `scripts/xw-probe.ts` / `scripts/xw-probe2.ts`。

## 12. 常用命令

```bash
cd /home/qaqtamsy/项目/bugent

bun test
bun run typecheck

# 真实测试（只使用允许的模型）
bun run src/index.ts \
  -p '请调用 read_file 读取 package.json，然后用一句话告诉我 package name。' \
  -m openai/hy4-preview-f \
  --mode read-only \
  --yes
```

wbproxy：

```text
http://127.0.0.1:8787/v1
```
