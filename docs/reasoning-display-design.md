# Reasoning / Thinking 展示设计

## 1. 背景

bugent 当前支持 DeepSeek 等模型返回完整 `reasoning_content`。这些内容已经进入 core
消息模型：

```text
provider reasoning chunk
  -> loop 累积 reasoning
  -> session.appendAssistant(..., reasoning)
  -> StoredMessage.reasoning
  -> SQLite messages.reasoning
```

但 TUI 当前只把 reasoning 当作 UI-only 的实时活动状态：

```text
onReasoning(delta)
  -> reasoningPacer
  -> ThinkingBuffer
  -> 底部只显示当前思考行
```

结果是：

- live 阶段可以看到当前思考尾部
- 完整 reasoning 虽然已经持久化，但聊天视图看不到
- 会话恢复后，历史 reasoning 仍然不可见
- 用户无法在需要时回看完整思考链

本设计只解决 **TUI 展示与交互**。不改变 provider reasoning replay，不把 reasoning
重新塞进模型上下文，也不引入 summary 提取。

## 2. 目标

1. 保留当前轻量的 live 思考体验。
2. 完成后允许用户在 chatview 中查看完整 reasoning。
3. reasoning 与 assistant 正文、tool call 保持真实时间顺序。
4. 默认不展开，避免长思考淹没最终回答。
5. 展开后展示全文，不做固定四行/六行截断。
6. 复用现有 `StoredMessage.reasoning`，不新增数据库 schema。
7. 支持 hidden / collapsed / expanded 三种展示策略。
8. 流式期间不重复对完整 reasoning 做 Markdown 布局。

## 3. 非目标

- 不把 reasoning 当作 assistant 最终回答。
- 不改变 reasoning 的 provider replay 行为。
- 不把 reasoning 加入 `buildContext()`。
- 不实现 Codex 风格的 summary 提取；DeepSeek 返回的是完整思考。
- 不要求 live 阶段完整滚动显示全文。
- 不处理 encrypted reasoning；当前链路没有可展示的 encrypted 内容。

## 4. 推荐交互

### 4.1 Live：Thinking

reasoning 正在流式输出时：

- 保持现有底部思考 tail。
- 在 chatview 中插入一个占位的 `reasoning` item。
- 该 item 只显示一行：

```text
✻ Thinking…
```

占位 item 的作用不是展示全文，而是固定它在 transcript 中的顺序位置。这样后续
assistant 正文和 tool card 不会插到 thinking 前面。

底部仍可继续显示当前思考尾部，具体可以复用现有 `ThinkingBuffer`：

```text
✻ Thinking…  当前思考尾部文本
```

### 4.2 Completed：Thought

reasoning 完成并写入 assistant message 后，把占位 item 原地变成：

```text
✦ Thought · 12.4s · 1,842 tok
```

默认折叠。

如果一轮有多个 reasoning 段：

```text
✦ Thought 1 · 12.4s
assistant / tool call
✦ Thought 2 · 3.1s
assistant / tool call
✦ Thought 3 · 8.7s
final answer
```

编号按当前 turn 内 reasoning item 出现顺序生成。

### 4.3 Expanded：完整思考

点击 Thought 行或触发展开动作后，展示完整内容：

```text
− Thought 1 · 12.4s · 1,842 tok
  完整 reasoning……
  完整 reasoning……
  完整 reasoning……
```

展开态不截断行数。终端只绘制可见 viewport 行，但这只是视口虚拟化，不是对
reasoning 内容做四行/六行窗口限制。

建议动作：

- 点击 header：展开 / 折叠
- `[复制思考]`：复制原始 reasoning
- `[全部展开]`：展开当前 turn 的所有 Thought
- `[全部折叠]`：折叠当前 turn 的所有 Thought

## 5. Transcript 数据模型

新增显示 item：

```ts
| {
    kind: "reasoning";
    /** UI 内稳定 id；live 期间使用临时 id，完成后绑定 msgid。 */
    id: string;
    /** 完整 reasoning 原文。live 期间为空，完成后来自 StoredMessage.reasoning。 */
    text: string;
    /** 是否已完成。 */
    done: boolean;
    /** 是否展开完整内容。 */
    expanded: boolean;
    /** live 阶段开始时间，用于计算 duration。 */
    startedAt?: number;
    /** 完成态耗时。 */
    durationMs?: number;
    /** 可选 token 估算。 */
    tokens?: number;
    /** 完成后绑定 assistant 消息。 */
    msgid?: MsgId;
    /** 当前 turn 内的序号，从 1 开始。 */
    sequence?: number;
    /** 中断时标记，不伪装成正常完成。 */
    interrupted?: boolean;
  }
```

`DisplayItem` 的相关辅助函数需要同步：

```ts
displayMsgId(item)
displayActionMsgId(item)
```

reasoning item 本身没有独立持久消息；完成后使用所属 assistant message 的 `msgid`。

## 6. Transcript API

建议增加以下方法：

```ts
beginReasoning(): number
finishReasoning(options: {
  text: string;
  msgid: MsgId;
  durationMs: number;
  tokens?: number;
}): void
toggleReasoningExpanded(id: string): boolean
```

### `beginReasoning()`

- 在当前 transcript 尾部插入 `done: false` 的 reasoning item
- 返回 item index
- 如果当前 assistant step 已经有 live reasoning item，则复用，不重复插入

### `finishReasoning()`

- 原地更新 live item
- 写入完整 `text`
- 绑定 `msgid`
- 记录耗时、token 和序号
- `expanded` 保持配置默认值

必须原地更新，不能删除后重新 append。否则会破坏 reasoning 与后续 assistant
文本、tool card 的顺序。

### `toggleReasoningExpanded()`

- 切换 `expanded`
- bump 对应 item version
- 触发 transcript layout 失效
- 展开时才进行完整 Markdown 渲染

## 7. App 事件接线

### 7.1 第一次 reasoning delta

当前 hook：

```ts
onReasoning: (delta) => {
  this.#reasoningPacer.push(delta);
  this.#noteOutput(delta);
  this.#requestFrame();
}
```

调整为：

```ts
onReasoning: (delta) => {
  this.#ensureLiveReasoningItem();
  this.#reasoningPacer.push(delta);
  this.#noteOutput(delta);
  this.#requestFrame();
}
```

`#ensureLiveReasoningItem()` 只在当前 assistant step 第一次收到 reasoning 时调用
`transcript.beginReasoning()`。

### 7.2 assistant message 完成

当前：

```ts
onAssistant: (message) => {
  const reasoning = this.#reasoningPacer.flush();
  if (reasoning.length > 0) this.#thinking.push(reasoning);
  this.#thinking.reset();
  ...
}
```

调整为：

```ts
onAssistant: (message) => {
  const tail = this.#reasoningPacer.flush();
  if (tail.length > 0) this.#thinking.push(tail);

  this.#finishLiveReasoningItem(message);

  this.#thinking.reset();
  ...
}
```

`#finishLiveReasoningItem()`：

- 使用 `message.reasoning` 作为完整原文，不从 `ThinkingBuffer` 取全文
- 使用 live item 的 `startedAt` 计算耗时
- 绑定 `message.msgid`
- 更新为 `done: true`

这样可以避免在 UI 再维护一份完整 reasoning 缓冲。

### 7.3 中断和失败

如果 abort 或 provider error 发生在 `appendAssistant` 之前：

- 不伪造完整 reasoning
- 可以将 live item 标为 `interrupted`
- 或者保留临时 item 并在下一轮开始时清理
- 不写入模型上下文

推荐第一版先清理 live item，第二版再加入 `Thought interrupted`。

## 8. 会话恢复

`Transcript.restore()` 当前按消息顺序重建：

```ts
for (const message of messages) {
  if (message.role === "assistant") {
    if (text.length > 0) {
      appendAssistantText(text);
      endAssistant(message.msgid);
    }
    for (const call of message.toolCalls ?? []) startTool(call, message.msgid);
  }
}
```

调整为：

```ts
if (message.role === "assistant") {
  if (message.reasoning !== undefined && message.reasoning.length > 0) {
    pushCompletedReasoning({
      text: message.reasoning,
      msgid: message.msgid,
      expanded: defaultReasoningExpanded,
    });
  }

  if (text.length > 0) {
    appendAssistantText(text);
    endAssistant(message.msgid);
  }

  for (const call of message.toolCalls ?? []) {
    startTool(call, message.msgid);
  }
}
```

这样恢复后的顺序是：

```text
Thought
assistant text / tool calls
```

不需要数据库迁移。

## 9. 渲染设计

### 9.1 Live item

```text
✻ Thinking…
```

要求：

- 1 行
- dim
- 不渲染完整正文
- 可继续使用 thinking shimmer 或 spinner
- 不参与 Markdown 布局

### 9.2 Collapsed Thought

```text
✦ Thought 1 · 12.4s · 1.8k tok
```

要求：

- 1 行
- 显示序号、耗时、可选 token
- 右侧或行尾显示展开提示
- 不预先渲染完整内容

### 9.3 Expanded Thought

```text
− Thought 1 · 12.4s
  └ 完整 reasoning……
    完整 reasoning……
    完整 reasoning……
```

要求：

- 展开时才渲染完整内容
- 使用现有 Markdown renderer 或 plain renderer
- 保留原文用于复制
- 不受 4/6 行限制
- 长内容由 transcript viewport 滚动处理

建议第一版使用 `renderMarkdown()`，与 chatview 其他内容一致；如果发现 DeepSeek
思考中的 Markdown 噪声较大，再增加 `reasoning_render = "markdown" | "plain"`。

## 10. 配置设计

建议增加：

```toml
[tui]
reasoning = "collapsed" # hidden | collapsed | expanded
```

语义：

| 值 | Live | 完成后 chatview |
|---|---|---|
| `hidden` | 底部 tail | 不插入 Thought |
| `collapsed` | 底部 tail + 占位 | 显示折叠 Thought |
| `expanded` | 底部 tail + 占位 | 默认展开全文 |

默认建议：

```text
collapsed
```

配置只影响展示，不影响：

- `StoredMessage.reasoning`
- provider reasoning replay
- `reasoningReplay` 配置
- 模型上下文

## 11. 顺序语义

关键规则：

1. reasoning 开始时立即插入占位 item。
2. 后续 assistant 文本和 tool call 追加到它后面。
3. reasoning 完成时原地替换占位，不移动位置。
4. 多条 assistant step 产生多个 Thought。
5. restore 时按 msgid 顺序重建 Thought 和后续输出。

目标顺序：

```text
User
Thought 1
Tool call
Tool result
Thought 2
Assistant answer
```

而不是：

```text
User
Assistant answer
Thought 1
Thought 2
```

## 12. 测试计划

### Transcript 单元测试

- 第一次 reasoning 插入 live item
- 同一 step 的多个 delta 不重复插入
- finish 原地更新，不改变顺序
- toggle expanded 只改变展开状态
- restore 从 `StoredMessage.reasoning` 重建 completed item
- 多个 assistant message 生成多个 Thought 并保持顺序

### 渲染测试

- collapsed 模式不渲染完整正文
- expanded 模式渲染全文
- 展开后换行宽度正确
- 中文、emoji、代码块不越界
- hidden 模式不产生 reasoning item
- live item 只占一行

### 端到端 PTY 测试

- mock 模型返回 reasoning 后，底部显示 live tail
- 完成后 chatview 出现 `Thought`
- 点击 Thought 展开全文
- 再次点击折叠
- 恢复会话后 Thought 仍存在

### 上下文隔离测试

- reasoning display item 不进入 `buildContext()`
- `reasoningReplay` 行为不因展示配置改变
- hidden 展示不影响 `StoredMessage.reasoning`

## 13. 分阶段落地

### Phase 1：可见性

- 新增 `reasoning` DisplayItem
- live 插入占位
- 完成后生成折叠 Thought
- restore 重建 Thought
- 默认 `collapsed`

### Phase 2：完整展开

- 点击展开/折叠
- 展开时懒渲染全文
- 复制思考原文
- 全部展开/全部折叠

### Phase 3：体验优化

- Thinking shimmer
- token 估算
- 中断状态
- `hidden / collapsed / expanded` 配置
- 可能的 `/thinking` 快捷操作

## 14. 最终决策

推荐采用：

```text
Live:
  底部 Thinking tail

Completed:
  chatview 中独立 Thought item
  默认折叠

Expanded:
  全量渲染完整 reasoning

Persistence:
  复用 StoredMessage.reasoning

Context:
  reasoning 不额外进入模型上下文
```

核心原则：

> Thinking 是实时状态，Thought 是可回看的完整内容；默认折叠，按需全量展开，顺序进入 chatview，但不与 assistant 最终回答混为同一种消息。
