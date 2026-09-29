# bugent Handoff

> 更新时间：2026-10-09
> 分支：`master`
> 功能检查点：`aed6cf9 fix(tui): TAB 统一展开成空格，修掉 read_file 卡片右侧滚动条缺口`
> 状态：TUI 流式平滑、Lezer Markdown AST、表格行级增量已完成并单独提交；工作区仍有其他同事的 Goal/tools/prompt/agent 改动，禁止一起提交
> 本轮补充：**权限授权统一**（bash 执行前判定 + 60s 授权窗口 + 弹窗倒计时）已落地、全量回归通过、未提交；上一轮 Goal 预算优化同样未提交
> 最新一轮：**WebUI 设计落地审计 + 玻璃补强方案（已定稿，源码零改动）**（详见下节）
> 上一轮：anthropic-messages adapter + wire 配置字段 + provider 退避重试，typecheck 与相关回归通过、未提交

## WebUI 设计落地审计 + 玻璃补强方案（2026-09-29，未动手）

**当前状态：只完成了审计和方案设计，`webui/` 下源码一行未改。** 本节就是为了让下一位（或下一个会话）跳过全部重新调研直接开工。用户已拍板两个前提：

1. **优先级：`docs/webui/addendum-liquid-glass.md`（附录）> `docs/webui/ui-restraint-rules.md`（守则）> `docs/webui/agent-webui-spec.md`（主 spec）**。玻璃标签栏、`liquid-glass-react` 依赖都是合法的，主 spec 里"白色背景为主/禁大面积 backdrop-filter/禁新增大型依赖"相关条款被附录 §1 显式覆盖。
2. 审计发现的问题清单成立，交给我方"继续补强"。

### 审计结论（三个子代理并行核对，证据到 file:line）

- 主 spec 落地率约 65%。骨架真实：token 体系、虚拟列表、rAF 批处理、写时克隆 reducer、IME 防误发、工具块全套、Todo 折叠策略、MockTransport 全场景都在。
- 最严重缺陷：**A 档玻璃（标签滑块）实际是坏的**——库覆盖了传入的 transform（定位错 + 平移动画死）、`saturation=1.15` 被当百分号（≈灰度）、默认 padding 撑大滑块。
- 其余大头：玻璃白名单 4 处只落地 1 处；降级机制全是死的（`glassEnabled` 无人调用、无 FPS 自动降级、matchMedia 只查一次）；流式 Markdown 性能硬要求未达标（无块切分、代码块流式中每个 delta 重建 Shiki）；rAF 批处理被 `App.tsx` 逐事件 `flushNow()` 旁路；切标签滚动位置只存不恢复；消息流式增长不跟随；消息 hover 操作栏/出现动画/Todo 滑出动画是"备而未用"的半成品；DELIVERY.md 有 3 条不实声明（玻璃分布 5 处实为 2 处、编辑/重新生成按钮"就位"实为只有 CSS 和 i18n 键、i18n 全覆盖实为 toolSummary 硬编码）。

### 液态玻璃库事实（`webui/node_modules/liquid-glass-react/dist/index.esm.js`，586 行，重新发现成本高，务必先读这段）

1. `LiquidGlass` 渲染 Fragment：2 个影子 div + 主容器 + 2 个 rim 高光 span，**全部**用 `positionStyles = { position: style.position || 'relative', top: style.top || '50%', left: style.left || '50%' }`，并强制 `transform: translate(calc(-50% + dx), calc(-50% + dy)) scale(...)`、`transition: all .2s`——**传入的 transform/transition 一定被覆盖，但 position/top/left/width/height 会透传**。
2. **正确集成姿势**：外层 wrapper div（我们自己的定位/尺寸/动画 transform）+ 内层 `LiquidGlass` 用默认定位（relative + 50%/50% + 自带 -50% 平移）自居中在 wrapper 里；给库传 `style={{ width: '100%', height: '100%' }}`。平移动画做在 wrapper 上（合规：transform 200ms）。
3. **同时传 `globalMousePos={{x:0,y:0}}` 和 `mouseOffset={{x:0,y:0}}`**（两个都要，模块级常量）：库的 mousemove 监听 useEffect 直接 early-return（**零监听、零重渲染**），弹性/缩放恒为 scale(1)，rim 渐变静止（光斑跟随关闭，守则 2.3 合规）。
4. 参数换算（全走 tokens 推导，禁止写死）：`saturation` 是百分数 → 传 `115`（对应 `--glass-saturate: 1.15`）；`blurAmount` → 库公式 `blur((4 + blurAmount*32)px)`，传 `0.4375` 精确命中 `--glass-blur: 18px`；`padding` 必须显式传 `0`（默认 "24px 32px"）；`displacementScale` 传 0 等于没有折射 → 新增 token `--glass-displace`（建议 8px）。
5. 库内部 `.glass` div 有 inline `boxShadow: 0 12px 40px rgba(0,0,0,0.25)`（比 `--glass-shadow` 重 4 倍）和内容包裹层 inline `font: 500 20px/1 system-ui` + `textShadow`——**必须用 CSS 压回**：`.glass-a .glass { padding: 0 !important; width: 100% !important; height: 100% !important; box-shadow: var(--glass-shadow) !important; }`，按钮文字显式设 `font-family/font-size/text-shadow: none`（继承打不赢 inline）。
6. `.glass__warp`（真正出霜的层）只有 backdrop-filter **没有 background** → CSS 补 `background: var(--glass-bg)` 才有附录 §5 的材质白。
7. `cornerRadius` 是 px 数字 prop；库根 div 拿 ref 测 glassSize，width/height 传 style 可行。
8. **不要给库传 `onClick`**：会追加 3 个 radial-gradient 悬停/按压发光层 + scale(0.96)。真实按钮作为 child 放进去，按压反馈用自己的 `.btn:active { scale 0.97 }`（白名单允许）。
9. 项目没装 Tailwind，库的 `text-white`/`bg-black`/`opacity-0` 类名全部失效，只有 inline style 生效（影子 div 因此恰好不可见，是运气不是设计）。
10. Firefox 跳过 `filter: url(#...)` 但 backdrop-filter 仍生效，可接受。

### 设计裁决（附录内部张力，已按"具体白名单 > 通用禁令"裁定，写进 DELIVERY）

| 张力 | 裁决 |
| --- | --- |
| §3.1 白名单同时点名"B 档标签栏整体"和"A 档选中滑块"，但 §3.2 禁玻璃叠玻璃 | 两者都保留（白名单是具体意图，禁令针对意外嵌套）；滑块在栏上呈更白一层的"选中"效果，正是 macOS 观感。DELIVERY 里记录该解释 |
| §3.1 A 档点名滑块，§8 又要求"A 档尺寸固定" | **滑块改固定尺寸 120×30**，滑动居中对齐选中标签（`x = tab.offsetLeft + tab.offsetWidth/2 - 60`），不再随标签宽度变化——两条同时满足 |
| 附录 B 档点名"输入框整体（含其上方 Todo 面板的容器）" | **Todo 面板 + Composer 用同一个 B 档玻璃包住**（`dock-inner` 外套一层 `GlassSurface tier=B strength=strong radius=lg`）。只有这样预算才算得平：tabbar(B) + dock(B) + 滑块(A) + 回到底部(A) = A2+B2 = 4 ≤ 4 |
| 附录 B 档点名"权限确认卡片浮层"，但权限卡现在是消息流内联卡 | **权限卡保持实底不做玻璃**。内联卡属于消息内容区（§3.2 禁区），白名单只覆盖"浮层"形态；改浮层是大重构且会把预算顶到 5。DELIVERY 记录 |
| 主 spec §8.1 空状态建议卡片 vs 守则 2.5 明确禁止 | 守则赢，维持"一行淡提示"现状 |
| 主 spec §2 新建/关闭标签宽度动画 vs 守则"动画只用 transform/opacity" | 不做宽度动画（FLIP 复杂度不值），DELIVERY 记账 |

### 文件级改造清单（按此顺序动手）

1. **`src/tokens/tokens.css`**：新增 `--glass-displace: 8px`；删 `--dur-page`（确认无引用）；`--glass-highlight` 保留（附录点名，当前 B 档"边框+阴影"两件套未用它，记账 reserved）。
2. **`src/store/glass.ts`（新增）**：玻璃状态模块。`{ level: 'full'|'noA'|'off', solid: boolean }` + `useSyncExternalStore`；`setGlassEnabled(v)`（附录 §6.2 全局开关，off = 全实底）；`initGlassMedia()` 给 `prefers-reduced-transparency`/`prefers-contrast: more` 挂 `change` 监听（修"只在 mount 查一次"）。
3. **`src/lib/glass-perf.ts`（新增）**：rAF 帧率监控单例；刷新率估计 = 观测到的持续 fps 上限；fps 连续 2s < 刷新率×80% → level 步降 `full→noA→off`（单向，面板手动复位）；`A→B` = GlassSurface 里 tier A 在 `level!=='full'` 时走 B 渲染路径。`process.env.NODE_ENV === 'test'` 时是 no-op（happy-dom 会误触发）。
4. **`src/components/GlassSurface.tsx`（重写）**：`useGlass()` 响应式降级；props 补 `interactive: boolean`（附录 §6.2 点名）；A 档按上面"库事实 2/3/4/5/6"重写集成，外包 `.glass-a` wrapper + `data-tier="A"`；B 档输出加 `glass-surface` 类名（让 `app.css:278` 的死媒体查询活过来）；降级实底路径不变。
5. **`src/components/tabs/TabBar.tsx`（重写）**：滑块 wrapper（fixed 120×30、`useLayoutEffect` + ResizeObserver 测位、wrapper transform 200ms）；「+」按钮移出 `.tabs` 固定右缘；`onWheel` 把 deltaY 转 scrollLeft（不 preventDefault，React 根上 wheel 是 passive）；左右边缘渐隐（onScroll 维护 canLeft/canRight → `data-fade-*` + CSS mask）；HTML5 拖拽排序（dragstart/dragover/drop + store `reorder(dragId, overId)` 新 action）；roving tabindex + ArrowLeft/Right/Home/End 键盘切标签（selection follows focus）；**删掉标签点的 breathe 动画**（running = 静态 accent 点，守则 2.3"同屏持续动画 ≤1"）。
6. **`src/app/App.tsx`**：删逐事件 `flushNow()`（测试自己会调，`ingest` 的 delta 本来就走 rAF）；`useEffect` 里 `initGlassMedia()` + `startGlassPerf()`；dock 包玻璃；notice 加「重试」按钮（重发末条用户消息）；处理 `webui:regenerate` / `webui:edit` window 事件（沿用 `webui:approve` 模式：regenerate = 末条用户消息重新 send，edit = setDraft + focus composer）；Ctrl/Cmd+K 最小命令面板（新建/关闭/切换标签）；`<ErrorBoundary>` 包 MessageList；Composer 加 `key={session.id}`；桌面通知：仅当 `Notification.permission === 'granted'` 且 `document.hidden` 时 turn 收尾通知，**绝不主动要权限**（守则 7：拿不准不加）；FpsPanel 用 `import.meta.env.DEV` 门控。
7. **`src/components/messages/MessageList.tsx`**：滚动恢复 = `useVirtualizer({ initialOffset: session.scrollTop })` + mount effect 设 `el.scrollTop`；流式跟随 = effect 依赖从 `messages.length` 改为内容签名（末条消息 blocks 文本总长），否则同一条消息增长不滚；「回到底部」改 A 档玻璃（fixed 100×32，见库事实 5/8）；消息出现动画 = `prevIds` ref（mount 时初始化为现有 id 集，render 中 diff 出新 id，effect 后补登记——StrictMode 安全），enter 类加在**内层 `.msg-shell` wrapper**（不能加在 vitem 上，会和虚拟列表的 translateY 打架）；`.scroller` 加 `role="log"`。
8. **`src/lib/md-blocks.ts`（新增）+ `src/components/markdown/Markdown.tsx`（重写）**：`splitMarkdownBlocks()`——围栏感知（``` / ~~~ 开闭配对）顶层块切分 + **列表宽松项合并**（空行后仍是 list item 就并回同块，否则 `<ol>` 断开会重置编号，这是正确性问题不是优化）+ 引用块同理合并；每块 `<MdBlock>` memo，key = `${index}:${djb2hash}`；`StreamingContext` 传给 CodeRenderer。**Shiki 单例**：模块级 `createHighlighter({ langs: [] })` 一个 Promise + `loadLanguage` 按需 + 高亮结果 Map 缓存（上限 200 条）；`streaming` 上下文为 true 时纯文本 `<pre>`，message_end 后才高亮（主 spec §3.2 第 6 条，当前行为正好相反）。
9. **`src/components/tools/ToolBlock.tsx`**：工具输出 12 行钳制（`.tool-out` max-height + 测量 overflow 才显示「展开全部」按钮，zh.expandAll）；`pending` 权限等待图标从转圈 Loader2 改静态 `Hand`（唯一持续动画让位给 running spinner）；分组头 spinner 只在 body 折叠时转（展开时让位给组内工具行，保住同屏唯一）；hover 操作栏接线：助手消息 = 复制/重新生成，用户消息 = 复制/编辑（CSS `.msg-hover-bar` 已有，只差 JSX）；`toolSummary` 动词改走 i18n。
10. **`src/components/todo/TodoPanel.tsx`**：两阶段挂载让 0fr→1fr 真正播放（todos 出现 → 内容挂载 → 双 rAF 后 `data-visible=true`；消失 → `data-visible=false` + `onTransitionEnd` 后卸内容）；当前 in_progress 项 `scrollIntoView({block:'nearest'})`；in_progress 图标静态 accent 圆点（去 Loader2 spin）。
11. **`src/app/App.tsx` 布局 + `src/app.css`**：dock 玻璃（`.dock-glass`，`:focus-within` 边框变 accent）；`.composer` 去自己的背景/边框/阴影（玻璃层承担）；标签文字全部 `var(--text-primary)`（选中 weight 500 / 未选 400，修玻璃上对比度，附录 §5"玻璃上文字用主文字色"）；`.glass-surface` 加 `contain: paint`；reduced-motion 重写：`transition-property: opacity !important`（保淡入淡出）+ `animation-iteration-count: 1` + 媒体查询内**重定义** `msg-in`/`pop-in` 为纯 opacity keyframes（当前 0.01ms 全杀连淡入都没了）；`999px` 胶囊改 radius token；A 档相关新 CSS（`.glass-a .glass` 压库默认样式等）。
12. **`src/i18n/zh.ts`**：加 `actRun/actRead/actEdit/actSearch`；删 `tabRename`（无触发条件，守则四.7）；`retry/regenerate/edit/expandAll` 全部接上。
13. **`src/components/composer/Composer.tsx`**：粘贴/拖拽图片缩略卡（onPaste/onDrop files、objectURL 缩略、× 移除、send 带 `attachments`——transport 签名已支持 `attachments?: File[]`，纯 UI 先行）。
14. **`src/app/ErrorBoundary.tsx`（新增）+ `src/components/CommandPalette.tsx`（新增）**：都是最小实现。
15. **`src/store/sessions.ts` 拆分**：reducer + VM 类型移到 `store/reducer.ts`（406 行超 300 约束，且本轮还要加 `reorder`）；**记得同步改 `test/reducer.test.ts` 的 import**。
16. **测试**：`cd webui && bun test` 现状 17 pass 全绿是基线；新增 splitMarkdownBlocks 用例（含 ol 不断号、围栏内空行不切）、glass store 降级用例、reorder reducer 用例；ui.test 里标签结构变化（+ 按钮移位、玻璃类名）需要跟着改。
17. **`docs/webui/DELIVERY.md` 修正**：3 条不实声明改为实况（或补齐实现后改回）；按附录 §9 补"库核实结果 / 性能实测 / 我加了但附录没写的东西"清单（自加项：`--glass-displace` token、A 档 blur 由 `--glass-blur` 反推库参数、固定尺寸滑块 120×30、回到底部 100×32、玻璃叠玻璃解释、权限卡保持实底的理由）。

### 明确不做（守则 7：拿不准不加，DELIVERY 里向用户交底）

权限卡玻璃化（禁区+预算）、标签宽度动画、空状态建议卡片（守则 2.5 禁止）、IndexedDB 持久化（挂账）、数学公式预留扩展点、主动申请通知权限。

### 验证方式

```bash
cd webui && bun test          # 基线 17 pass / 0 fail
cd webui && bun run typecheck
cd webui && bun run build     # 注意 shiki 单例后 bundle 变化
bun run src/entry-webui.ts --mock   # 浏览器冒烟：滑块对齐/平移动画、玻璃降级（系统设置）、Ctrl+Shift+P 面板
```

附录 §8 要求的三个实测场景（流式+滚动穿玻璃、快速切标签、Todo 展开同时流式）下一位在真机上跑 FpsPanel 记录，写回 DELIVERY。

---

## provider 层三件事：messages adapter / wire 字段 / 退避重试（2026-10-09）

本轮在 provider 层做了三件相互衔接的事，全部未提交。

### 1. `anthropic-messages` adapter（已实现）

对接 Anthropic `/v1/messages` 及兼容实现。`registry.ts` 的占位 throw 已替换，
`config/toml.ts` / `provider-profiles.ts` 校验表此前已接受该 endpoint，配置层零改动。

- **wire 映射**（`toWireRequest`）：`system`/`developer` → 顶层 `system` 数组；
  `role:"tool"` → user 消息里的 `tool_result` block，**连续多条合并进一条 user 消息**
  （API 要求 user/assistant 严格交替）；assistant `toolCalls` → `tool_use` block；
  image → base64 source block；空文本块丢弃（空 content 会被拒）。
- **请求**：`x-api-key` + `anthropic-version: 2023-06-01`；`max_tokens` 必填，兜底 8192。
- **SSE**（`mapStreamEvent`）：`message_start`（输入侧 usage + `cache_read_input_tokens`→cached）
  → `content_block_delta`（`text_delta`/`thinking_delta`→reasoning/`input_json_delta` 按 index 拼 argsDelta）
  → `message_delta`（输出侧 usage + stop_reason）；流内 `error` 事件直接抛错；
  stop_reason：`tool_use→tool_calls`、`max_tokens→length`、其余→stop。
- **reasoning 回放**：默认 `none` 不回放（官方对带 tool use 的 thinking block 校验
  signature，回放缺签名历史会被 400）；显式开启才以 thinking block 回放，只适合兼容网关。
- **公共底座抽取**：SSE 行解析 / proxy+tls 请求扩展 / 回环直连处理从 openai-chat
  上移到 **`src/provider/adapters/http.ts`**，openai-chat 改为复用，导出接口不变
  （`ProviderProxy`/`ProviderTlsConfig` 仍从 openai-chat re-export）。
- 待实现：`openai-responses`（含 freeform custom tool 的首次兑现）。

### 2. config 新增 `wire` 字段（中性命名，`endpoint` 兼容）

用户诉求：config 不再以 `openai-chat` 这类厂商前缀命名 wire，以免误导用户。

- `src/provider/registry.ts` 新增 `WIRE_ALIASES` + `parseWire()`：
  `chat→openai-chat`、`messages→anthropic-messages`、`responses→openai-responses`、`mock→mock`；
  旧全名写法继续接受。内部 `EndpointKind` 不变（adapter 标识 / session 落库 / `ModelClient.id`）。
- `config/toml.ts`：`wire = "messages"` 写法生效；`wire` 与 `endpoint` 同时出现**直接报错**
  （不做静默优先级）；缺省仍 `openai-chat`；首次生成的配置模板已改为 `wire = "chat"`。
- `provider-profiles.ts`：导入收 `wire` 或 `endpoint`（互斥）；**导出继续写 `endpoint`**
  （旧二进制读 profile 不破坏）。
- TUI 新增 provider 对话框改为四选 wire；`bugent.config.example.ts` 加了 Anthropic 示例。
- TS 配置（`bugent.config.ts`）走带类型检查的 `ProviderConfig`，保持 `endpoint` 全名。
- 之后的 wire 字段沿用中性命名原则（如 `prompt_cache`、`thinking_budget`），不带厂商前缀。

### 3. provider 退避重试（**临时机制**，标注了"临时"）

schedule：T+5s / T+10s / T+30s / T+60s / T+90s，共 5 次，每次用 loop 重建的**最新上下文**重发。

- **`src/provider/retry.ts`（新增）**：`RETRY_DELAYS_MS`（可变数组，测试临时改写）、
  `isRetryableProviderError`（429/500/502/503/504/529/限流/过载/retry 关键词，基于错误消息文本）、
  `parseRetryAfterMs`（错误消息里的 `(retry-after: N)`）、`retryDelayMs` = max(调度值, Retry-After)、
  `sleepWithSignal`（中止时抛 AbortError，与 fetch 中断一致）。
- **loop 集成**（`core/loop.ts` catch 分支）：只在**尚未产出任何内容**
  （text/reasoning/tool_call 全空）时重试 —— 已流出内容再重发会重复；
  429/过载几乎都发生在请求建立阶段，覆盖主场景。`continue` 回到 for(;;) 顶部走 `buildContext()`。
  新增可选 hook `onProviderRetry({attempt,total,delayMs,error})`，`combineHooks` 已广播。
- **两个 adapter** 抛 HTTP 错误时把 `retry-after` 响应头拼进错误消息，供解析。
- **TUI**：`AgentActivity` 增 `retrying` 态；菊花亮绿/暗绿交替（theme 新增
  `retrySpinner`/`retrySpinnerDim`），文本 `重试中：N/M`；`onProviderRetry` 把错误滚过
  思考 tail + 实时区 `pushError`；onText/onReasoning 到达即恢复 working。
  **webui bridge 不渲染 retry 态**（hook 可选，不影响），重试本身全端生效。
- 判定基于错误文本是临时的 —— 转正时应把错误结构化（状态码/Retry-After 进错误对象）。
- mid-stream 已产出内容时的失败仍直接抛错，走既有 disconnected 展示。

### 本轮验证

- `bun run typecheck` 通过。
- `tests/anthropic-messages.test.ts`（15 例，含 Bun.serve 回放端到端）、
  `tests/retry.test.ts`（7 例）、config/profiles 的 wire 用例全过。
- 相关 14 个测试文件 152 pass / 0 fail。全量 `bun test` 的 129 个失败
  （沙箱/PTY/symlink）与 store 审计、runtime 隔离两例均已在**干净树上复现**，属
  Windows 环境限制与存量问题，与本轮改动无关。

### 涉及模块

```text
src/provider/retry.ts                      退避重试判定/延时/sleep（新增，临时机制）
src/provider/adapters/http.ts              SSE/代理/TLS 公共底座（从 openai-chat 上移）
src/provider/adapters/anthropic-messages.ts  Anthropic /v1/messages adapter（新增）
src/provider/adapters/openai-chat.ts       复用 http.ts；错误消息附 retry-after
src/provider/registry.ts                   anthropic-messages factory；WIRE_ALIASES/parseWire
src/core/loop.ts                           退避重试接入；onProviderRetry hook
src/core/provider-profiles.ts              profile 导入兼容 wire
src/config/toml.ts                         wire 字段 + 生成模板更新
src/tui/thinking.ts                        retrying 活动态 + 绿色 shimmer
src/tui/theme.ts                           retrySpinner / retrySpinnerDim
src/tui/app.ts                             onProviderRetry 接线；对话框 wire 四选
tests/anthropic-messages.test.ts           15 例（新增）
tests/retry.test.ts                        7 例（新增）
tests/config.test.ts / provider-profiles.test.ts  wire 用例
```


## 权限授权统一（2026-09-26）

规范：`docs/permission-authorization-spec.md`。起因是"同一件事、两个工具、两种结果"：
`write_file` 写工作区外会弹窗，`bash` 重定向写同一个路径只会得到 `Read-only file system`
—— 用户连申请授权的机会都没有，唯一出路是切 `no-sandbox`（默认批准一切），
而那正是 `mode.ts` 明令禁止的"升档"。

### 本轮已落地

- **两层边界**：进程内工具走调用前闸门；沙箱子进程走"执行前静态判定 + 内核兜底"。
  两条路共用同一套按次授权（`CapabilityGrant`）与同一个 60 秒窗口。
- **`src/sandbox/command-scan.ts`（新增）**：纯函数扫描重定向 / 写命令 / 输出选项 /
  解释器 + 写信号，产出 `outsidePaths`、`network`、`writeIntent`；
  `planWriteApproval()` 把扫描翻成"要不要问、批准后放开什么"；
  `writableAncestors()` 算 `--bind` 的源目录（目标不存在时上提）。
- **bash 执行前拦**：命中越界就不跑，弹窗；拒绝/超时回传
  `用户拒绝操作` / `授权已超时（授权窗口内未收到确认）`。
  静态识别得出的联网命令（`curl` / `git push` / `npm install`）同样事前问；
  识别不出的（解释器里的 socket）保留"跑失败 → 带真实报错 → 按次授权"兜底。
- **批准后真放开**：`ShellRunOptions.writablePaths` → `buildSandboxArgv` 逐个 `--bind`。
  `read-only` 档批准写工作区时绑工作区本身（能盖掉那条只读判定）。
- **`src/permission/authorization.ts`（新增）**：60 秒窗口 + 三态
  `approved` / `denied` / `timeout`，**超时 = 拒绝**（fail closed）。
- **三态贯通**：`onRequestCapability` / `SessionInteraction` / `TuiInteraction` /
  `BugentButuiInteraction` 的返回类型从 `boolean` 改成 `AuthorizationOutcome`。
- **TUI 弹窗倒计时**：三个入口共用 `TuiApp#authorize`，标题右侧 `· 还剩 47s`，
  走既有帧调度每秒重绘，归零自动关掉弹窗。
- **CLI 同样有时限**：`node:readline` 没有内建超时，由窗口到点关掉它。

### 涉及模块

```text
src/permission/authorization.ts   60s 窗口 + 三态（新增）
src/permission/gate.ts            check() 三态；GateVerdict/GateDecision 增 refusal
src/permission/prompt.ts          StdinPrompter 套窗口；ScriptedPrompter 接受 boolean 或三态
src/sandbox/command-scan.ts       执行前判定 + 批准范围规划（新增）
src/sandbox/bwrap.ts              options.writablePaths -> --bind
src/tools/bash.ts                 执行前判定 -> 弹窗 -> 按次放开
src/tools/types.ts                onRequestCapability 返回三态
src/tools/builtin.ts              workspaceWritable 传给 bash
src/core/loop.ts src/core/runtime.ts src/butui/bridge.ts src/index.ts
src/tui/app.ts                    #authorize + 标题倒计时
docs/permission-authorization-spec.md  README.md  CHANGELOG.md
tests/authorization.test.ts  tests/command-scan.test.ts  tests/bash-authorization.test.ts
tests/mode.test.ts  tests/tui-pty.test.ts  tests/permission-modes.test.ts
tests/permission-wiring.test.ts  tests/runtime.test.ts
```

### 验证状态

```text
bun run typecheck
# pass

bun test
# 1110 pass / 1 skip / 0 fail（本轮之前是 1030 pass / 1 skip / 0 fail）
```

行为矩阵（实测，`bash`）：

| 档位 | 操作 | 弹窗 | 批准后 | 拒绝后 |
| --- | --- | --- | --- | --- |
| `read-only` | 写工作区内 / 写工作区外 / 联网 | 是 | 真的成功 | 拦下·没跑 |
| `workspace-write` | 写工作区内 | 否 | 成功 | — |
| `workspace-write` | 写工作区外 / 联网 | 是 | 真的成功 | 拦下·没跑 |
| `no-sandbox` | 全部 | 否 | 成功 | — |

"批准后真的成功"是**跑通验证**过的，不是断言返回值形状：写工作区外真的落盘；
联网批准后用 `Bun.serve` 起本地服务、`curl` 真的连上（拒绝则连不上）。

PTY 端到端两条（真终端、真 CLI）：
- 倒计时弹窗：`write_file` 写工作区外 → 弹窗显示 `还剩 2s` → 到点自动关闭 →
  模型收到 `授权已超时（授权窗口内未收到确认）`，且文件没落盘。
- bash 越界：`bash("echo hi > <工作区外>")` → 弹窗标题 `需要授权 · 写入工作区之外`、
  正文带命令与目标 → 按 `n` → 模型收到 `用户拒绝操作`，命令没执行。

### 本轮踩的坑（改这块别再踩）

- `--bind` 的**挂载顺序**：本次可写路径必须排在 `--tmpfs /tmp` 之后，
  否则工作区落在 `/tmp` 下会被 tmpfs 盖掉（`bwrap: Can't chdir to …`）。
- `/tmp` 是私有 tmpfs **不代表可以把它从 `writeTargets` 里剔掉**：
  工作区本身可能就在 `/tmp`（临时 worktree、测试目录）。只能从 `outsidePaths` 里排除。
- **不要做全局关键词兜底扫描**：`grep -rn "mkdir" src` / `git commit -m "fix open( bug"`
  都会被误判。写信号只对解释器分支生效，且 `open()` 必须带写模式。
- 短选项 `-o` 含义按命令不同（`curl -o f` vs `ssh -o X`），只有 `--output` 这类
  长选项能对所有命令通用。
- **超时文案不能写死秒数**：窗口长度由实现方（TUI/CLI）决定，闸门不知道具体值。
- **`read-only` 档必须无条件绑工作区（只读）**：`--tmpfs /tmp` 会把它遮掉，
  不绑回来则工作区在 `/tmp` 下时每条命令都 `Can't chdir`（既有 bug，本轮修掉）。
  这条基础策略必须排在按次授权的 `--bind` **之前**，否则按次授权覆盖不掉它。

### 剩余挂账（授权方向）

| 优先级 | 设计 | 主要模块 | 当前状态 | 关键约束 |
| --- | --- | --- | --- | --- |
| P0 | 沙箱内写盘的可观测性 | `src/sandbox/command-scan.ts`、`src/core/workspace.ts` | bash 写工作区**仍然不产生 `WorkspaceFileChange`**，`/undo` 看不到 | 见 `docs/workspace-ledger-sandbox.md`（overlay 账本路线，引擎已在 `项目/wsbox`） |
| P1 | 扫描器的命令表补全 | `src/sandbox/command-scan.ts` | 目前覆盖常见命令；`tar -x`、`git checkout` 等仍靠内核兜底 | 宁可漏判（内核兜底）也不要把只读命令变成弹窗 |
| P1 | 授权记录进审计 | `src/store/audit.ts`、`src/permission/gate.ts` | `GateDecision.refusal` 已带结论，但 bash 走的是 `onRequestCapability`，未进审计流水 | 要能回答"这次为什么被拒/超时" |
| P2 | 扫描器的命令表补全（写路径） | `src/sandbox/command-scan.ts` | `git checkout`、`tar -x`、`make install` 等仍靠内核兜底 | 宁可漏判（内核兜底）也不要把只读命令变成弹窗 |

## Goal 预算优化挂账（2026-09-26）

### 本轮已落地

- 预算口径改为 `input - cached + output`；cached token 只审计，不占 Goal 预算。
- `max_goal_token_budget` 现在同时是“上限”和“未显式指定时的默认预算”。
- reviewer / final auditor 的独立 provider usage 计入 Goal。
- 达到预算时：
  - Goal 进入 `budget_limited`
  - 停止自动 continuation
  - 对同一 Goal 只注入一次 `Goal Budget Limit` 收尾上下文
  - 收尾上下文走 `session.enqueueInjection(..., "goal")`，不直接改写 active turn
- `/goal status` 现在显示 remaining budget 与 active time。

本轮涉及模块：

```text
src/goal/controller.ts       Goal 状态机、预算判定、收尾注入、review usage 记账
src/goal/review.ts           reviewer 返回 usage / duration
src/goal/types.ts            ReviewResult 增加 usage / durationMs
src/store/goal-repository.ts Goal token/time 账本与预算口径
src/tui/app.ts               /goal status 输出入口（dialogLines）
tests/goal-controller.test.ts
tests/goal-repository.test.ts
tests/goal-review.test.ts
README.md
docs/goal-mode-spec.md
```

验证状态：

```text
bun run typecheck
# pass

bun test
# 1031 pass / 0 fail
```

同日关联变更（也已落地、未提交）：

- chatview 的 live `Thinking` 完成后原地变成默认折叠的 `Thought`；只有点击 Thought 头部才展开。
- 相关模块：
  ```text
  src/tui/transcript.ts
  src/tui/render-reasoning.ts
  src/tui/hit-target.ts
  src/tui/app.ts
  src/provider/registry.ts
  tests/transcript.test.ts
  tests/reasoning-render.test.ts
  tests/hit.test.ts
  tests/tui-pty.test.ts
  ```
- 设计稿：`docs/reasoning-display-design.md`

### 剩余设计挂账

| 优先级 | 设计 | 主要模块 | 当前状态 / 入口 | 关键约束 |
| --- | --- | --- | --- | --- |
| P0 | 用户可控预算更新 | `src/tui/app.ts`、`src/goal/controller.ts`、`src/store/goal-repository.ts` | 尚无 `/goal budget <n>`；`budget_limited` 目前无法通过正常 UI 提升预算后恢复 | 只有用户/系统能改预算；模型只能申请创建时的 budget |
| P0 | 预算预留与硬上限语义 | `src/core/loop.ts`、`src/goal/controller.ts`、`src/store/goal-repository.ts` | 当前仍是 turn 结束后记账，允许当前 turn 超预算 | 若做预留，要定义 reserve/commit/release；不能破坏现有 append-only 与错误恢复 |
| P0 | 所有子代理 usage 汇总 | `src/agent/supervisor.ts`、`src/agent/read-only-executor.ts`、`src/agent/integrator.ts`、`src/goal/controller.ts` | reviewer/final auditor 已计入；worker/explorer/其他子代理尚未统一计入 root Goal | 不能重复计费；要区分 root Goal、review、worker 的 usage 归属 |
| P1 | 系统生成的最终 Goal 账单 | `src/goal/controller.ts`、`src/store/goal-repository.ts`、`src/goal/handoff.ts`、`src/tui/app.ts` | `listTurnAccounting()` 已有逐 turn 数据，但没有 UI/CLI 最终报告 | 最终账单应以系统账本为准，模型只负责总结，不负责提供数字 |
| P1 | 持久化 budget-limit 已报告标记 | `src/goal/controller.ts`、`src/store/goal-repository.ts` | 当前 `#budgetLimitReportedGoalId` 只存在内存，进程重启可能重复注入 | 若持久化，需避免与 resume/edit budget 冲突 |
| P1 | 预算阈值预警 | `src/goal/controller.ts`、`src/tui/app.ts` | 目前只有达到预算后的提示，没有 80% / 90% 预警 | 预警应是 UI/context 提示，不应改变 Goal 状态 |
| P1 | 结构化 completion budget report | `src/tools/goal.ts`、`src/goal/controller.ts` | 目前没有 Codex 风格的 completion report 字段 | 数字必须来自系统账本；不能只靠模型转述 |
| P2 | mid-turn 增量记账 | `src/core/loop.ts`、`src/core/session.ts`、`src/goal/controller.ts` | 当前只在 `completeTurn()` / review 完成时记账 | 若做 mid-turn，优先走安全边界；不要直接改写运行中上下文 |
| P2 | Time budget 执行 | `src/goal/types.ts`、`src/goal/controller.ts`、`src/config/schema.ts` | 当前只有 `timeUsedSeconds` 统计，没有 time limit | 需要区分 wall-clock、tool 执行时间和 idle |
| P2 | 完整 Goal 审计输出 | `src/goal/controller.ts`、`src/goal/handoff.ts` | Handoff 已有 Budget 表，但 final audit 完成通知没有系统账单 | 最终报告应覆盖 token、cached、active time、review 成本和停止原因 |

### 设计护栏

- 保留 bugent 的 `Goal -> Checkpoint -> Plan -> Todo -> Evidence -> Review -> Handoff -> Epoch`，不要压扁成 Codex 的薄 Goal。
- 保留独立 reviewer 和 final audit；不能退回“主模型自审即完成”。
- 不直接照搬 Codex 的 active-turn steering。bugent 优先走安全边界注入，保护 append-only msgid 和前缀缓存稳定性。
- 预算数字必须来自 provider usage / 系统账本；模型只能解释，不能生成权威预算。
- 允许超预算时，必须明确是“当前 turn 收尾超支”而不是“预算失效”。

## 当前检查点

目标是把 TUI 从“按网络 delta 一跳一跳”推进到“到达与显示解耦、目标 120fps、流式 Markdown 只重绘变化部分”。

已完成三个独立提交：

```text
41ec617 perf(tui): 解耦流式到达与 120fps 显示
dc45b95 perf(tui): 增量重排流式 Markdown 表格
478ab46 feat(tui): 引入 Lezer Markdown AST 与表格模型
```

### 1. Lezer Markdown AST

相关文件：

```text
src/tui/markdown-ast.ts
src/tui/lezer-markdown-boundary.ts
src/tui/streaming-markdown.ts
src/tui/markdown.ts
```

能力：

- 使用 `@lezer/markdown` + GFM 解析 Markdown。
- AST 识别顶层 block、fenced code、GFM table。
- 未闭合 fenced code 不误判为完整代码块。
- `LinkReference` 出现后禁用 stable prefix 冻结。
- `splitMarkdown()` 不再手写扫描围栏和表格 delimiter。
- 表格直接消费 Lezer 的 `TableHeader/TableRow/TableCell` 模型。
- 行内 Markdown 仍交给 Bun，代码块仍走原有高亮器。
- 可用 `BUGENT_LEZER_MARKDOWN=0` 回退到旧边界扫描。

### 2. 表格行级增量

`src/tui/markdown.ts` 现在维护有界表格状态：

- 以 `TableRow` 前缀复用已经完成的渲染行。
- 固定列宽追加时只重排新行。
- 新行改变列宽时整表失效，避免边框错位。
- 缓存 key 包含宽度、超链接开关、delimiter 和行内容。
- 表格状态上限 64；行内单元格 LRU 上限 2048。
- `getMarkdownCacheStats()` / `resetMarkdownCacheStats()` 用于性能回归。

1000 行表格追加一行：

```text
tableStateHits:   1
tableRowRenders:  1
tableRowReuses: 1001
```

本机微基准（1000 行表格追加 100 行）：

```text
旧实现   p50 18.76ms  p95 21.23ms
新实现   p50  4.67ms  p95  6.33ms
```

注意：这是 Markdown 表格渲染基准，不是完整 TUI 帧耗时。表格仍会扫描/复制全部输出行，尚未做到端到端 O(1)。

### 3. TUI 到达与显示解耦

相关文件：

```text
src/tui/stream-pacer.ts
src/tui/frame-scheduler.ts
src/tui/term.ts
src/tui/transcript-layout.ts
src/tui/transcript.ts
src/tui/app.ts
```

行为：

- `StreamPacer` 把 provider delta 先入队，再按约 120 token/s 分帧揭示。
- 大突发不会一帧跳完整段。
- 队列延迟超过阈值后有限追帧，避免无限落后。
- `StreamPacer` 已改为头指针 + 摊销压缩，消除 `Array.shift()` 的 O(n²)。
- `FrameScheduler` 默认 120fps（8.333ms），从上一实际帧计算下一帧，避免 10ms token 节奏锁成 20ms。
- `Terminal.writeFrame()` 用单次 stdout 写入提交差分帧，并尝试 DEC 2026 同步输出。
- `TranscriptLayout.applyChanges()` 只更新新增/标脏 block；旧 block 改行数时修正后续偏移。
- highlight.js 异步完成后同时失效布局缓存和 Markdown stable/tail 缓存。
- `BUGENT_SYNC_UPDATE=0` 可关闭同步输出；`BUGENT_LAYOUT_STATS=1` 在退出时打印布局统计。

## 验证状态

```text
bun run typecheck
# pass

TUI / Stream / Layout 定向测试
# 59 pass

TUI PTY 冒烟
# 24 pass

Markdown / Lezer 定向测试
# 50 pass
```

全量测试最近一次：

```text
971 pass / 1 fail
```

唯一失败是并发全量运行时的 Goal 工具用例；单跑 `tests/goal-controller.test.ts` 为 `21 pass`，与 TUI/Markdown 提交无关。

## 上机检查点

建议先跑：

```bash
bun run src/index.ts --mock --no-persist
```

模拟突发流：

```bash
BUGENT_MOCK_CHUNK_CHARS=4 \
BUGENT_MOCK_CHUNK_DELAY_MS=0 \
bun run src/index.ts --mock --no-persist
```

退出时打印布局统计：

```bash
BUGENT_LAYOUT_STATS=1 bun run src/index.ts --mock --no-persist
```

终端闪烁或同步输出异常时：

```bash
BUGENT_SYNC_UPDATE=0 bun run src/index.ts --mock --no-persist
```

验收重点：

1. 约 100 tok/s 是否逐字流动，而不是整段跳。
2. 约 200 tok/s 突发时是否仍平滑，但不过度滞后。
3. 长代码块首次出现后，异步高亮是否能及时刷新。
4. 1000 行左右表格追加时是否卡顿。
5. 滚动、工具卡片和输入框是否撕裂或闪烁。
6. 需要时记录完整帧 p50/p95/p99；目前还没有端到端帧统计。

## 已知限制与下一步

1. **完整帧基准尚未做**
   - 当前只有 Markdown 表格微基准。
   - 需要测 compose + layout + diff + terminal write 的完整 p95/p99。

2. **表格仍不是严格 O(1)**
   - 昂贵行渲染已增量化，但每帧仍遍历/复制全部输出行。
   - 若真机大表仍卡，下一步做列宽 multiset、rolling prefix hash、rope/chunk 输出。

3. **长上下文/分页未做**
   - 当前主要是窗口化布局与 block 缓存。
   - 需要先看 `oldUpdates` 统计，再决定 Fenwick O(log n) 或优先做分页/持久化窗口。

4. **Markdown 边角**
   - 列表/引用内部 fenced code 仍走 Bun prose，不一定进入自定义高亮。
   - 行内 AST 尚未完全替换 Bun 行内渲染。

5. **工作区仍有同事改动**
   - `src/goal/*`、`src/tools/*`、`src/agent/*`、`src/prompts/system.md`、对应测试和 `src/store/goal-repository.ts` 当前均未提交。
   - 不要把同事改动混入 TUI/Markdown 提交。
   - 当前暂存区应为空。

## 交接给下一位

优先顺序：

```text
1. 真机验收当前 TUI 平滑检查点
2. 若大表仍卡：做真正增量的表格宽度/输出结构
3. 若长会话滚动仍卡：做布局统计驱动的 O(log n) 或分页
4. 最后再补 Markdown 嵌套块与行内 AST
```

---

## Historical handoff (2026-09-24)


## 1. 当前状态

已验证：

```bash
bun test
# 514 pass / 0 fail

bun run typecheck
# clean
```

当前全局 `bun` 已替换为 Bugent Bun fork：

```text
/home/qaqtamsy/.bun/bin/bun
version 1.4.3
upstream backup: /home/qaqtamsy/.bun/bin/bun-upstream-1.4.2
project runtime: runtime/bun/bin/bugent-bun
```

下一阶段主线已经形成正式设计：

```text
docs/goal-mode-spec.md
```

Goal Mode 2.0 的对象边界：

```text
Goal -> Checkpoint -> Plan -> Todo -> Evidence -> Review -> Handoff -> Context Epoch
```

不要把 todo 当作 goal；Todo 完成、Checkpoint 完成、Goal 完成是三套不同门槛。

真实 provider 冒烟已通过（本地 wbproxy，允许的模型）：

```bash
bun run src/index.ts \
  -p '请调用 read_file 读取 package.json，然后用一句话告诉我 package name。' \
  -m openai/deepseek-v4.1-flash \
  --mode read-only \
  --yes
# 工具调用正常，回答 "package name 是 bugent"
```

工作区有两个既有未跟踪探针，不要提交：

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

## 2. 最近已完成

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
SCHEMA_VERSION = 9
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

## 3. Phase A：ToolBatch 协议安全（已完成）

核心不变量：

```text
assistant(tool_calls=[tc1, tc2, tc3])
tool(tr1)
tool(tr2)
tool(tr3)
```

中间不能插入 user / injection / assistant / 新 tool call batch / 缺失或错序的 tool result。

实现位置：`src/core/session.ts`

规则：

- `appendAssistant(text, toolCalls)` 落库 assistant 后立即打开 batch；
- batch 打开期间，`appendUser` / `appendInjection` / 新 `appendAssistant` 直接抛错；
- `appendToolResult` 只接受当前 batch 内的 call id；
- 结果先存原始输入，flush 时才分配 msgid，保证乱序到达时 msgid 与消息顺序仍严格递增；
- `flushToolResultsInOrder()` 只 flush 已到齐的前缀；
- 所有结果到齐后 batch 自动关闭；
- `finishToolBatch()` / `abortToolBatch()` 按原 call 顺序补 synthetic error；
- `runTurn` 在发下一次 provider 请求前断言没有 open batch；
- `runTurn` 的 `finally` 补齐 abort / 异常留下的缺失结果；
- `AgentSession` 恢复历史时扫描尾部孤立 tool calls，并补：

```text
Error: tool result missing due to interrupted session
```

如果历史里的 tool result 顺序与 call 顺序不匹配，恢复会明确报错；这种形态不能靠追加修复。

## 4. Phase B：消息队列（已完成）

实现位置：`src/core/session.ts`、`src/tui/app.ts`

### 4.1 API

```ts
type SubmitResult =
  | { status: "started"; msgid: number }
  | { status: "queued"; position: number };

class AgentSession {
  submitUser(text: string): SubmitResult;
  enqueueUser(text: string): number;
  enqueueInjection(text: string, source?: InjectionSource): void;

  dequeueUserAfterTurn(): string | undefined;
  drainInjectionsAtSafeBoundary(): StoredMessage[];

  hasOpenToolBatch(): boolean;
  finishToolBatch(missingText?: string): StoredMessage[];
  abortToolBatch(reason?: string): StoredMessage[];
}
```

### 4.2 语义

- busy 时用户输入只排队，不启动第二个 `runTurn`；
- turn 正常结束后自动 drain 队首 user message；
- abort / 错误后保留队列，不自动执行；
- 空 Enter 可继续执行 abort 后保留的队列；
- injection 只在没有 open batch 的模型步边界 flush；
- `ask_user` answer 属于当前 tool execution，不 append user；
- branch / runtime switch、`/new`、retry 清空旧队列。

TUI 状态栏显示：

```text
[已排队 N]
```

abort 且队列非空时显示：

```text
已中断；[已排队 N] 保留，按 Enter 继续
```

## 5. 真实 provider 取证

使用 wbproxy：

```text
http://127.0.0.1:8787/v1
```

### hy4-preview-f

两组异常请求都返回 200：

- 孤立 tool call；
- tool call 与 tool result 中间插 user。

说明该上游/模型当前比较宽容，但不能依赖。

### deepseek-v4.1-flash

同样两组请求都返回 400：

```text
code=11148
tool_call_sequence_broken
tool calls and tool results do not match
```

结论：

> 工具消息配对必须在 bugent 内部保证，不能靠 provider 容错。

修复后的真实工具调用链已返回 200。

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

规则：

- retry 使用新 branch；
- 不复用旧 queue；
- 不额外注入旧 user message；
- 新 branch 的 session 从空队列开始；
- 旧 branch 的排队消息不带入新 branch。

## 7. 测试覆盖

`tests/protocol-safety.test.ts` 已覆盖：

1. `tc1,tc2,tc3 -> tr1,tr2,tr3` 顺序；
2. batch 内提交 user，不会插到 tool call / tool result 之间；
3. batch 内 injection 在 batch 后 flush；
4. 并发 tool result 乱序到达，最终按 call 顺序 flush；
5. abort 后补齐 synthetic tool results；
6. crash recovery：resume 后修复尾部孤立 tool calls；
7. retry：旧 branch 不变，新 branch 只出现一次原 user message。

TUI PTY 冒烟覆盖了连续 10 条输入排队后自动 drain。

`tests/tool-concurrency.test.ts` 已覆盖：

1. 不同资源的工具真正并行执行；
2. 同一文件写锁让 edit 类工具串行；
3. `edit_file` 与 `python` 修改同一文件时通过 workspace 写锁串行；
4. 结果乱序完成时仍按 tool_calls 顺序落库；
5. bash 只读 / 写命令的资源分类；
6. ResourceLockManager 的同文件互斥、workspace 与具体文件冲突；
7. 等待锁时 abort 会取消排队请求。

## 8. Phase C：并发工具与资源锁（已完成）

实现位置：

- `src/core/loop.ts`：同一 assistant 消息里的多个 tool calls 并发执行；
- `src/tools/locks.ts`：读写资源锁；
- `src/tools/types.ts`：ToolRegistry 在 `tool.run` 外层持锁；
- `src/tools/files.ts`：文件工具声明具体文件资源；
- `src/tools/bash.ts`：bash 资源分类；
- `src/tools/ask_user.ts`：交互工具独占 `interaction`。

锁模型：

```text
workspace                 整个工作区
workspace/<relative path> 单个文件
interaction               交互弹窗
```

冲突规则：

- 键相等，或一个是另一个的目录前缀时视为重叠；
- 任一侧是 write 就必须串行；
- read/read 可以并发；
- 锁按 call 顺序申请，保证同文件实际写入顺序与消息顺序一致，undo 才能按逆序正确回滚。

工具声明：

- `read_file` -> `workspace/<file>` read
- `write_file` / `edit_file` -> `workspace/<file>` write
- 只读 bash（ls / cat / rg / git status 等）-> `workspace` read
- 非只读 bash（python / sed -i / 重定向 / git apply 等）-> `workspace` write
- 未声明资源的写工具 / 沙箱工具 -> 保守地拿 `workspace` write
- `ask_user` -> `interaction` write

关键效果：

```text
edit_file(a.ts) + read_file(a.ts)      -> 串行
edit_file(a.ts) + edit_file(b.ts)      -> 并行
edit_file(a.ts) + python 修改 a.ts     -> 串行
python 修改 a.ts + python 修改 b.ts    -> 串行（无法静态判断目标，保守）
```

并发结果仍由 ToolBatch 保证按 call 顺序落库；`appendReady` 只 flush 已连续到齐的前缀，因此完成顺序不影响协议顺序。

### 8.1 弹窗布局

权限确认、能力授权、升档、`ask_user` 和消息操作菜单现在不再覆盖消息区底部，而是：

- 取代输入面板的位置，水平居中显示；
- 有完整边框（`┌─┐│└─┘`，`dialogBorder` 色）；
- 整体铺 `dialogBg` 独立底色，和输入面板 / 正文形成层级；
- 按钮使用填充方框 `▐ 同意（y） ▌`，快捷键直接合进按钮；
- 按钮语义色：普通同意绿、高危授权同意琥珀、拒绝红、取消/检查/复制中性灰蓝；
- 打开时隐藏思考区，给弹窗让空间；
- 消息区高度自动收缩，最新一条消息始终留在弹窗上方；
- 终端过小时弹窗最多占 `height - 2` 行，底部内容仍可能被裁剪。

没有采用“右侧空白区”方案：当前正文是单列全宽布局，右侧并没有稳定保留的空白区域。若以后要做右侧面板，需要先引入响应式分栏布局。

### 8.2 当前限制

- bash 非只读命令拿整个 workspace 写锁，无法做到“不同文件的 python 并行”；
- bash 只读分类是保守白名单，`echo hi` 之类也会被当作写命令；
- 交互弹窗通过 TUI 的 `#serializeInteraction` 串行，避免并发工具互相覆盖对话框；
- 权限确认在持有资源锁后发生，因此同文件工具会按 call 顺序等待用户确认，不会因弹窗耗时改变写入顺序。

## 9. Context Layout v2（死规矩）

新 session 固定：

```text
msgid0  system prompt snapshot（Markdown 文件读取）
msgid1  MCP manifest（存储 role=system，协议默认 developer）
msgid2  skills manifest（存储 role=system，协议默认 developer）
msgid3+ user / assistant / tool conversation
```

规则：

- system prompt 不再写死在源码，默认从 `src/prompts/system.md` 读取；
- 配置可用 `agent.system_prompt_file` 覆盖，支持 `~` 和相对 cwd 路径；
- 读取结果快照进 msgid0，之后文件变化不修改已有 session；
- msgid1/msgid2 存储为 system message，通过 `injectionSource=mcp/skill` 标识；
- 默认渲染为 developer role；
- 端点拒绝 developer role 时，TUI 询问是否改用 system role 重发；
- 回退只影响渲染，不改写历史消息；
- 上下文顺序由 `ContextPlan` 语义决定：system -> MCP -> skills -> conversation；
- 工具名命名空间：`mcp__<server>__<tool>` / `skill__<skill>__<tool>`。

数据库新增 `messages.injection_source`，schema 升到 v8。

## 10. 斜杠命令 / session context

已实现：

- 输入 `/` 打开命令菜单；
- `/context` 查看当前 session 的 provider / model / client / sandbox / branch / API key 状态；
- `/context` 可进入二级配置菜单；
- `/mode <mode>` 切换当前 session 沙箱档位；
- `/provider` 从已注册 provider 中切换，新增 session 级 provider，或管理 provider profiles；
- `/model` 输入模型名，也支持 `provider/model` 一次切换两者；
- `/key` 掩码输入 API key；
- `/new`、`/exit` 保留。

关键原则：**不修改全局 config**。

- 沙箱档位按 session 保存到 `sessions.sandbox_mode`；
- provider/model 按 session 写回 `sessions.provider_id` / `sessions.model`；
- 非敏感 provider profile 按 session 保存到 `session_providers` 表；
- 一个 session 可以保存多个 provider profile，并在 TUI 中切换；
- provider profile 支持 `endpoint/baseUrl/headers/extraBody/reasoningReplay/proxy`；
- TLS 支持 `caFile/certFile/keyFile` 文件路径，adapter 在创建 client 时读取 PEM；
- provider profile 支持切换、重命名、复制、删除；active profile 不能直接删除；
- 新增版本化 `provider-profiles` 文档与 `exportProviderProfiles/importProviderProfiles` core API，未来 WebUI 可直接复用；
- 导入导出默认不含 apiKey 和内联 TLS 私钥；导入冲突策略支持 `skip/overwrite/rename`，并支持 dry-run；
- `createSessionRuntime()` 解析 effective mode：显式请求 > session 记录 > workspace-write；
- provider/model 解析：显式请求 > session 记录 > 启动时默认；
- API key 优先保存到系统 keychain（Linux `secret-tool` / macOS `security`），不可用时降级到进程内存；
- keychain 按 `sessionId + providerId` 隔离，启动时自动加载 active provider 的 key；
- `ProviderRegistry.resolve(ref, overrides)` 支持 session 级 provider 覆盖，也支持未注册 provider + 完整配置；
- 切换任何 provider/model/sandbox 都通过重建 `SessionRuntime` 完成；
- 重建时保留同一个 sessionId / branchId，消息历史从 store 恢复，不新建会话；
- 有排队消息或 turn 运行中时拒绝切换，避免配置切换与旧队列混用；
- provider 切换会清掉旧 provider 的 API key override，避免把旧 key 发给新 provider；
- provider/model/profile/api-key 变更都会写 `session_config` audit 事件，payload 不含密钥。

安全边界：

- `/key` 使用 masked input，输入和汇总都不回显明文；
- API key 不进入 transcript / audit / SQLite；
- `setProviderConfig()` 即使被错误传入 `apiKey` 也会强制剔除；
- keychain 不可用时只退化为进程内存，不会写明文文件；
- 真实 API key 仍只应使用允许的测试模型和本地 wbproxy。

尚未实现：

- TUI 里还没有 provider profile 导入/导出入口（core API 已有）；
- TLS 表单还没接进 TUI（adapter/core 已支持 *File）；
- Windows 还没有 keychain 后端。

下一步建议：WebUI 接 `provider-profiles` core API；TUI 可再加一个简单的导入/导出 JSON 命令。

## 10.1 Bun fork / runtime SDK

Bun fork：

```text
/home/qaqtamsy/项目/bun
branch: feat/spawn-sandbox-hook
commit: 675ec8c768
base revision: 6d504dd983
```

新增原生 sandbox provider ABI：

```c
void* bun_spawn_sandbox_prepare(const char* config, size_t config_len, int* errno_out);
int bun_spawn_sandbox_apply(void* state);
void bun_spawn_sandbox_destroy(void* state);
```

`Bun.spawn` 新增：

```ts
sandbox: {
  library: string;
  config?: string;
}
```

- `prepare` 在 Bun 父进程调用；
- `apply` 在 fork/vfork 子进程、`execve` 前调用，必须 async-signal-safe；
- `destroy` 在 spawn 返回后调用；
- Linux 下 hook 位于 `posix_spawn_bun` 的 child setup 内；
- macOS 有 sandbox hook 时强制走 Bun 的 fork/posix_spawn 路径；
- Windows 当前明确报错，不静默忽略。

已验证：

- debug 和 release 二进制均成功构建；
- release 二进制：`build/release/bun`，约 78MB；
- release 版本：`1.4.3`，revision `6d504dd983`；
- 真实 provider 测试通过：允许路径返回 0，provider 返回 `EACCES` 时 spawn 正确失败；
- bugent 测试：493 pass / 0 fail；
- bugent typecheck 通过。

安装当前 checkout 的 fork：

```bash
bun run runtime:install
bun run runtime:install -- --global
```

`--global` 会保留 `~/.bun/bin/bun-upstream-<version>`，再原子替换
`~/.bun/bin/bun`，并创建 `bugent-bun` alias。runtime 校验同时接受路径相同或
字节内容相同的二进制，因此全局副本与 `runtime/bun/bin/bugent-bun` 都被认可。

bugent runtime SDK：

```text
runtime/bun/
```

提供：

- `@bugent/bun-runtime` 包结构；
- `spawnSandboxed()` / `spawnMcpServer()` helper；
- `include/bun_spawn_sandbox.h`；
- `types/bun-spawn-sandbox.d.ts`；
- `scripts/package.ts` 打包脚本。

打包命令：

```bash
cd /home/qaqtamsy/项目/bugent
bun run package:bun-runtime
```

当前 artifact：

```text
dist/bun-runtime/bugent-bun-runtime-1.4.3-bugent.3-linux-x64.tar.gz
sha256: 12590fd2efbfdd9d9ab69cf09663fd248e49fd23dcd79a98c3b61953b463473c
```

包内运行时：

```text
bugent-bun-runtime/bin/bugent-bun
bugent-bun-runtime/lib/libbugent-sandbox.so
bugent-bun-runtime/include/bun_spawn_sandbox.h
bugent-bun-runtime/src/index.ts
bugent-bun-runtime/types/bun-spawn-sandbox.d.ts
bugent-bun-runtime/runtime.json
```

### 10.1.1 bugent 0.0.0 standalone binary

打包命令：

```bash
bun run package:bugent
```

实现：

- 使用 `runtime/bun/bin/bugent-bun` 执行 `bun build --compile`；
- 将 `src/prompts/system.md` 和 `libbugent-sandbox.so` 作为 `--asset` 嵌入；
- 单文件首次启动时把 `.so` 原子解包到
  `~/.bugent/runtime/0.0.0/lib/libbugent-sandbox.so`；
- standalone 模式通过嵌入 asset 识别，不再要求 `process.execPath` 等于
  `runtime/bun/bin/bugent-bun`；
- 打包脚本会启动一个真实 stdio MCP probe，验证编译后二进制的 fork sandbox
  hook、原生 provider、JSON-RPC 和 mock 对话链路。

当前产物：

```text
dist/bugent/bugent-0.0.0-linux-x64/bugent
sha256: d355dc91674209c598a73e7e948044f8d3b59b10c9735835ffba1afc12f3b3f1

dist/bugent/bugent-0.0.0-linux-x64.tar.gz
sha256: dc6484fa61c67fd8300a1138e1513ddb1b79de09e65d71030230bbe3d1eaabc6
```

构建工具链注意：

- Bun main 要求 LLVM 23.1.x；
- 本机使用缓存工具链 `/home/qaqtamsy/.cache/bugent-llvm/llvm-23.1.1`；
- LLVM release binary 依赖 ICU 70，缓存于 `/home/qaqtamsy/.cache/bugent-llvm/icu70`；
- `nasm` 缓存在 `/home/qaqtamsy/.cache/bugent-tools/nasm-3.02`；
- WebKit prebuilt 使用 gh-proxy 镜像下载到 Bun build cache。

## 10.2 Native sandbox + MCP（本次实现）

新增文件：

```text
native/sandbox/provider.c
native/sandbox/Makefile
native/sandbox/README.md
scripts/build-sandbox.ts
src/sandbox/policy.ts
src/mcp/stdio.ts
src/mcp/tools.ts
src/mcp/manager.ts
```

Linux provider 在 `apply()` 中只使用 syscall：

- `PR_SET_NO_NEW_PRIVS`；
- Landlock filesystem allowlist（deny by default）；
- `network=none` 时安装 seccomp filter，禁止 socket/socketpair/connect/bind/listen/accept/io_uring；
- 可选 `prlimit64` CPU / address-space / file-size / open-files / process limits；
- `close_range(3, ~0, CLOSE_RANGE_UNSHARE)`，只保留 stdin/stdout/stderr。

安全语义：

- MCP stdio 没有“无沙箱降级”路径；必须运行在 Bugent Bun fork 上，否则 fail closed；
- 默认工作区只读、私有 state 目录可写、断网、环境变量白名单；
- `workspaceWrite` 默认 false，可传 `true` 或显式路径数组；
- 读路径、写路径、执行路径均为显式能力；Landlock execute 以目录规则实现；
- Bun/JSC 启动需要读 `/proc`，因此默认 runtime read roots 含 `/proc`；这是有意的只读权衡；
- seccomp 不允许创建新 socket，但允许已有 fd 上的 stdio `recvfrom`/`sendmsg`，否则 Bun stdin 会收到 `EPERM`。

MCP 接线：

- `McpStdioClient` 实现 JSON-RPC stdio、initialize、tools/list、tools/call、超时/关闭和 stderr 诊断；
- `createMcpTool()` 把工具注册成 `mcp__<server>__<tool>`，所有调用仍必须经过 `ToolRegistry.execute()`；
- `McpManager` 负责 server 生命周期和工具快照 reload，并可同时挂接到多个 session runtime；
- `startConfiguredMcp()` 从 `[[mcp.servers]]` 启动 server，生成稳定 manifest；
- `createSessionRuntime()` 自动 attach/detach MCP registry；恢复旧 session 时保留 msgid1，不重写历史，只把变化的完整目录作为 developer delta 注入；
- `McpManager.onToolsChanged` 已接到 CLI：工具目录变化时按安全边界 enqueue developer delta；
- `/context` 会显示每个 MCP server 的工具数量、启用/停用状态，非 Linux 显示关闭原因；
- `/context` 二级菜单支持重载 MCP 工具、启停当前 session 的 MCP server；
- session 级启停持久化在 `session_mcp` 表（schema v9）；缺省视为启用；
- runtime 重建时 MCP client 复用，不重启 server；TUI 切换 runtime 会释放旧 registry attachment；
- `[[mcp.servers]]` 字段：`id/cmd/cwd/env/workspace_read/workspace_write/read/write/exec/network/state_dir/limits`；
- 非 Linux 平台配置 MCP 时明确返回“MCP 已关闭”，不会以无沙箱方式启动。

当前验证：

```text
bun test
# 514 pass / 0 fail

bun run typecheck
# clean
```

后续：

- 增加 session 级 capability grant 覆盖；MCP 进程必须按 grant fingerprint 分池，不能共享成权限并集；
- 在 `/context` 里增加 MCP server 的新增/删除入口；
- HTTP MCP 只做 endpoint allowlist、credential 隔离和 audit，不伪装成 OS 沙箱；
- 用同一 policy compiler 给 bash 增加 strict profile；bwrap 先保留兼容；
- Windows/macOS provider 暂未实现，当前 MCP 在这些平台明确关闭。

## 10.3 Skills

实现位置：

- `src/skills/loader.ts`：发现并解析 `SKILL.md`；
- `src/skills/tools.ts`：`skill__<name>__load` 工具适配；
- `src/skills/manager.ts`：catalog、registry attachment、reload、manifest/delta；
- `src/skills/runtime.ts`：从 `[skills]` 配置启动发现；
- `src/core/runtime.ts`：attach/detach、msgid2 快照与安全边界 delta。

语义：

- `SKILL.md` 必须有 YAML frontmatter 的 `name` / `description`；
- 正文只在模型调用 `skill__<name>__load` 时进入 tool result；
- 默认 roots：`~/.bugent/skills`、`~/.agents/skills`、项目内同名目录；
- roots 从低到高，项目覆盖用户；`disabled` 最后过滤；
- msgid2 只包含 tool 名和 description，不包含正文、绝对路径或环境值；
- `SkillManager.reload()` 原子替换 attached registry，并返回 added/removed 供 developer delta；
- skill loader 仍走 `ToolRegistry.execute()`，因此权限、并发锁、abort 和 ToolBatch 顺序一致。

配置：

```toml
[skills]
paths = ["~/.config/my-skills"]
disable_defaults = false
disabled = ["legacy-skill"]
```

## 10.4 旧 TUI 输入法光标与多行输入

旧 TUI 原先隐藏硬件光标，只用反显单元格模拟输入光标。IME 候选窗锚定的是
终端真实光标，因此候选窗会停留在上一帧末尾。

修复：

- 主输入框每帧通过 `Terminal.setCursor(row, column)` 把真实光标移动到逻辑插入点；
- 光标列由 `src/tui/input-view.ts` 统一计算，覆盖 CJK/emoji 宽字符和折行；
- 输入行不再绘制反显块，真实光标直接覆盖当前字符/空白；
- 弹窗打开时隐藏真实光标；
- `ask_user` 的自由文本输入也暴露逻辑光标位置，由同一套 dialog 坐标换算定位。

多行输入：

- `Ctrl+J`、`Alt+Enter` 插入换行；增强键盘协议下的 Shift+Enter 也映射为换行；
- 普通 `Enter` 仍然提交；
- 输入框固定 4 行视窗，按终端宽度自动折行，超过 4 行时跟随光标滚动；
- `Up/Down` 在多行/折行内容中移动视觉行，单行时仍保留历史滚动；
- bracketed paste 保留内部换行，不再折叠成空格；
- `Home/End` 按当前视觉行移动。

回归测试：

- `tests/input-view.test.ts` 覆盖多行、折行、CJK 宽字符和行列映射；
- `tests/tui.test.ts` 覆盖 Ctrl+J / Alt+Enter / 增强键盘协议；
- `tests/tui-pty.test.ts` 验证真实 PTY 中多行输入与一次提交；
- `tests/ask-user.test.ts` 验证输入态暴露硬件光标位置。

## 10.5 旧 TUI scrollback 拖动

主消息区最右列现在是滚动条：

- 轨道只覆盖主消息视口，不覆盖状态栏、输入框或历史抽屉；
- thumb 高度按 `viewportHeight / (viewportHeight + maxOffset)` 计算；
- `scrollOffset=0` 时 thumb 贴底并继续 follow tail，最大 offset 时贴顶；
- 点击轨道会把 thumb 中心移动到点击位置；
- 拖动 thumb 时保存 `grabOffset`，后续鼠标 motion 只按绝对 `y` 映射，不要求指针仍在轨道内；
- 拖动和滚轮、PageUp/PageDown 都最终走 `scrollMainView()`，不会出现条和 chat 状态分叉；
- 主区最大回看仍受三屏限制，更早内容继续通过历史抽屉查看。

实现：

```text
src/tui/scrollbar.ts      几何、命中、拖动映射、轨道合成
src/tui/app.ts            mouse capture / drag lifecycle / 同一 scrollOffset
tests/scrollbar.test.ts   纯数学与渲染回归
tests/tui-pty.test.ts     真实 SGR 拖动后 chat 到达“查看更多消息”
```

## 10.6 Agent activity spinner

菊花不再只代表 reasoning，而是代表 agent 是否仍在工作。
（状态文案已经去掉：菊花本身表达"活着/在跑"，空闲是静止的灰色菊花，工作时闪动。）

```text
idle          ○ idle（状态栏），思考区为空
waiting       ✻ 等待模型 · 连接模型 / 读取工具结果
thinking      ✻ 思考 · reasoning 尾部
responding    ✻ 生成回复
tool          ✻ 执行工具 · bash / mcp__... / skill__...
retrying      ✻ 重试 · 手动 retry / developer role 兼容性重发
disconnected  ✖ 已断开 · 真实错误文本
aborted       ■ 已中止 · 用户中断
```

状态来源：

- `#runTurn` 开始时进入 `waiting`；
- `onReasoning` / `onText` 切换 `thinking` / `responding`；
- `onAssistant` 清 reasoning buffer，但不清 agent activity；
- `onToolCall` 进入 `tool`，`onToolResult` 回到 `waiting`；
- 手动 retry 和 developer role 兼容性回退进入 `retrying`；
- catch / `reason=error` 进入 `disconnected`，abort 进入 `aborted`；
- turn 正常结束进入 `idle`。

因此 bash、MCP、skill load 等长时间工具执行期间，即使没有 reasoning，菊花仍持续动画；断线后菊花停止并保留红色 `✖ 已断开`，不会伪装成 idle。

## 10.7 buTUI experimental entry

已引入独立实验入口，现有 `src/tui` 仍为默认 UI，两套 UI 并行维护：

```bash
bun run butui
bun run butui:typecheck
```

目录：

```text
src/butui/
├── bunfig.toml
├── tsconfig.json
├── preload.ts
├── jsx-runtime.ts
├── main.tsx
└── README.md
```

约束：

- `src/butui` 已从 bugent 根 `tsconfig.json` exclude；
- 必须使用 `--conditions=browser`；
- 必须 preload `@butui/solid/plugin`；
- `jsxImportSource = "@butui/solid"`；
- 通过 sibling `/home/qaqtamsy/项目/buTUI` 的源码路径解析 `@butui/*`，不复制 buTUI 源码；
- `src/butui/vendor/solid-js` 只用于锁定 browser runtime，避免 Bun 错解析到 `solid-js` 的 server 构建；
- 最小工作状态已接入真实 `AgentSession`、`runUserTurn`、真实 `ToolRegistry`、权限/升档/联网授权、流式文本和工具事件；
- `bun run butui -- --mock` 可做无 key 冒烟；`Esc` abort 当前 turn；`Ctrl+C` 恢复终端。

下一步接入顺序：

1. `src/butui/bridge.ts` 继续扩展 branch / retry / undo；
2. 工具 diff 和 artifact；
3. MCP/session context 面板；
4. 命令面板和多页 ask_user。

buTUI 当前基线：

```text
bun --conditions=browser test
# 611 pass / 0 fail

bun --conditions=browser x tsc --noEmit
# clean
```

2026-09-24 修复了 `measureStreamNode` 的 committed/render cache 污染：tail 行定稿时不再丢结尾字符，也不会残留旧 tail 形成重复行。

## 10.8 矩形按钮与吸顶用户消息

两件事都围绕"可点区域"：

**按钮统一成矩形**（`src/tui/button.ts`）：默认是 3 行的描边方框
（`┌──┐ / │ 标签 │ / └──┘`），整块填背景；终端放不下时退化成 1 行的
`▐ 标签 ▌`（宽度一样，只是矮）。正文区「查看更多消息」、思考区「回到最新
消息」、弹窗与消息菜单的动作都走 `paintButtonLines()`，不再有 `[ xxx ]` 这种
没背景、悬停也没反馈的纯文字样式。

- 悬停底色（`buttonHoverBg`）刻意取得比中性/成功/警告/错误四种底色**都亮**，
  所以同一个高亮色在哪种 tone 上都读得出"选中"，不必给每个 tone 再配一套；
  这条不变量由 `tests/button.test.ts` 用感知亮度断言钉住。
- 形态退化由调用方按可用行数决定（`buttonShapeFor`）：正文顶部不够 3 行就换
  紧凑形态，弹窗放不下就整体重画一遍（`#renderDialog` 两趟：先框、超行再紧凑），
  一行都放不下才不画。
- 悬停/按下目标统一成 `ButtonTarget`（dialog / message / moreHistory /
  returnToLatest），`#buttonState()` 让渲染点只问一句"我此刻是不是悬停/按下"。
- **所有按钮都是按下-抬起确认**：按下只换底色，抬起时还停在同一个按钮上才
  生效，拖出去松手不触发。折叠行、输入框光标、右键菜单仍是按下即生效。
- 自检锚点按形态取字形：框是 `┌`，紧凑是 `▐`，登记矩形左上角必须正好是它。

**本轮用户消息吸顶**（`src/tui/user-band.ts`）：最后一条 user 条目整块滚到窗口
上方（`contentEnd < windowStart`，且窗口起点不为 0）时，正文区顶部常驻一行
`↥ › <消息首行>`，整行铺底色；右键点它可开这条消息的操作菜单。它只是顶部多一行
**副本** —— 正文里的用户消息一行不少、不挪位，回看仍是完整一轮；提交下一轮后
新消息落在窗口底部（可见），条件自然不成立，无需额外的解除状态。

**思考区让位规则**：「回到最新消息」出现时思考区向正文借 1 行（`THINKING_SPINNER_ROWS`
+ 按钮行数），菊花和按钮各占各的 —— 菊花是状态的主要指示，不能被控件挤掉。
布局计算一律用 `thinkingRows`（总高），不能用那一刻的 `thinkingBlock.length`。

**待办面板折叠**（`TODO_COLLAPSED_LINES = 3`）：面板默认只显示「标题 + 当前在做
的那一项」，最后一行是展开/收起按钮（紧凑形态，1 行）；两项以内本来就放得下，
不画按钮。展开后的高度仍受 40% 上限约束。按钮走同一套 `ButtonTarget` +
按下-抬起语义，所以悬停/命中/自检全都免费复用。

两个坑都踩过，留个记号：

- 顶部行数不能把正文挤没。吸顶行 + 「查看更多消息」各占一行，正文至少留 1 行，
  否则 body 会多吐一行、把下面的思考区/输入框整体顶偏（自检的锚点会直接报错）。
- 判断"该不该吸顶"要先按"只有按钮"的窗口探一次：窗口缩小后起点只会往下走，
  所以这个判断不会来回抖。


- 不要把所有消息塞进一个普通 FIFO。
- 不要依赖 hy4-preview-f 的宽容行为。
- 不要在 tool batch 中间注入 user / MCP / skill。
- 不要让 retry 通过队列额外注入 user message。
- 不要把 TUI `ThinkingBuffer` 当成协议 reasoning 存储。
- 不要绕过 `ToolRegistry.execute` 直接调 `tool.run`，否则会跳过资源锁与权限。
- 不要让新的写工具漏声明 resources；未声明时只会退化为整个 workspace 写锁。
- 不要提交 `scripts/xw-probe.ts` / `scripts/xw-probe2.ts`。

## 12. 常用命令

```bash
cd /home/qaqtamsy/项目/bugent

bun test
bun run typecheck

# 真实测试（只使用允许的模型）
bun run src/index.ts \
  -p '请调用 read_file 读取 package.json，然后用一句话告诉我 package name。' \
  -m openai/deepseek-v4.1-flash \
  --mode read-only \
  --yes
```

wbproxy：

```text
http://127.0.0.1:8787/v1
```
