# WebUI 阶段交付说明（v0.1）

> 交付范围：主 spec §12 的阶段 1–4 + 协议侧接入点 + 无头测试 + **后端接入（`bun run bugent:webui`）**。Electron 打包未做（见"未做清单"）。

## 〇、后端接入（`bun run bugent:webui`）

- 入口 `src/entry-webui.ts`：一个 Bun 进程同时 ① 启动 bridge（会话工厂接**真实 runtime 装配**：loadConfig → ProviderRegistry → createDefaultTools → composePolicy → openSession/SessionStore 持久化）；② 伺服 `webui/dist` 静态页（SPA 回退）。
- 启动后打印 `http://127.0.0.1:<port>/?token=<token>`；页面从 query 取 token 走 ProtocolTransport（协议 §12"token 如何到达浏览器"采纳 stdout/URL 方案），无 token 时仍是 MockTransport 演示模式。
- CLI：`--port <n>`（缺省随机端口）、`--mock`（mock/echo provider，无需 API key）、`--cwd`、`--yes`（全放行）、`--no-persist`、`--allow-network`、`--no-sandbox`。
- 测试：`tests/webui-server.test.ts`（静态伺服/SPA 回退/同端口 WS/mock provider 流式回显/token 拒绝），3/3 pass；另做了真实进程端到端冒烟（构建产物 200 + 主 bundle 498KB）。
- v0 差异：未接 MCP / skills / goal / subagent 工具集；per-session provider 切换、credential store 未接（key 走 config 内嵌配置）。

### 修复记录："发消息后无反应"（联调阶段发现，4 个缺陷）

1. **会话 id 不匹配（根因）**：UI 标签用本地 id，协议侧 session id 由服务端生成，前端从未调 `session.new` → attach 必失败。修复：`ProtocolTransport` 增加 local↔server id 映射，首次 send 懒建 session（session.new → attach → turn.send），事件按 server→local 反查路由回正确标签。
2. **命令在 WS 就绪前发送**：`cmd()` 在 hello 完成前直接 `ws.send` 抛 InvalidStateError。修复：出站命令排队，hello reply 后 flush（hello 本身绕过队列）。
3. **回放结构不匹配**：attach reply 的 `messages` 是 StoredMessage（无 `text` 字段），history reducer 渲染为空。修复：`projectHistory()` 投影为 HistoryMessage。
4. **重复/早退状态**：App 本地乐观渲染用户消息与协议 `user.message` 重复（已删，用户消息一律由 transport 回发）；`message_end` 在用户消息上提前把状态改回空闲（改为仅 assistant 消息结束才收尾）；`turn.started` 现映射为运行中状态；断线重连后 `attached` 复位，下一次 send 自动重新 attach。
- 回归：`webui/test/protocol-transport.test.ts`（真实 bridge + ProtocolTransport 无头端到端）2/2；全链路真实进程 e2e（`--mock` + ProtocolTransport）PASS；webui 17/17、协议+服务 13/13。

## 一、做了什么

### 协议侧（docs/ui-protocol-spec.md）

| 交付物 | 说明 |
|---|---|
| `src/protocol/types.ts` | 信封/命令/事件类型；只 re-export 现有 core/permission/tools/tui 类型，不复制结构（§10.1） |
| `src/runtime/bridge.ts` | headless WS runtime：`Bun.serve` 承载 `ws://127.0.0.1:<port>/ws`，仅绑回环；hello token 认证（错 token → error + close 4401）；一连接多 session；session.list/new/attach/close、turn.send/cancel、permission.resolve/always、ask_user.answer、extension_role.fallback；LoopHooks→事件为 §5 规范性映射（`combineHooks` 注入 adapter，不改 loop）；attach 全量历史带 `replay:true`、第二连接 `session_taken`；断连时挂起往返按 denied 收尾（§6） |
| `PermissionPolicy.addRule()` | §6.1 "总是允许"运行时加规则入口。**插入规则表最前**（"第一条命中生效"语义下，显式授权必须压过构造期 ask/deny 兜底，否则永远轮不到——测试中发现并修正）；复刻 `bash`→`exec` 别名规则 |
| `tests/protocol.test.ts` | 10 条：握手/4401、§5 事件顺序、turn_busy、cancel 幂等与收尾、denied 路径、always 加规则放行、多 session 不串流、session_taken、unknown_command（§10.2/10.3） |
| `scripts/protocol-smoke.ts` | headless echo client（§10.3）：echo/cancel/denied/多 session 四场景，`bun run scripts/protocol-smoke.ts` 退出码 0 |

### WebUI（docs/webui/agent-webui-spec.md + 克制守则 + Liquid Glass 附加件）

位于 `webui/`（Vite + React 19 + TS + zustand，`bun dev` / `vite dev` 直接跑，无需后端）。

- **tokens/tokens.css**：全站唯一变量源；3 档圆角、2 档阴影、动画曲线/时长、玻璃材质变量（附加件 §5 原样）。
- **布局**：顶部标签栏（无左侧列表）→ 消息区（滚动区延伸到玻璃层下方，附加件 §4）→ Todo 面板 + 输入框托盘；内容最大宽 760px。
- **标签栏**：状态点（空闲/运行中呼吸/等待橙/出错红/未读蓝点）、hover 关闭、双击重命名、中键关闭、Ctrl/Cmd+T/W/数字、滑动选中玻璃块（A 档，transform 平移 200ms）、每标签状态/草稿/滚动位置独立。
- **消息区**：`@tanstack/react-virtual` 虚拟列表（动态高度 + 零尺寸容器回退）；底部 80px 阈值跟随（rAF 合并），上滑不打扰 + 「回到底部」带计数。
- **流式 Markdown**：react-markdown + remark-gfm；未闭合语法交给 remark 优雅处理；流式 token 入 rAF 缓冲每帧最多刷一次；已完成块 `React.memo` + **写时克隆 reducer**（未修改的消息引用不变，这是 memo 生效的前提）；代码块流式纯文本、结束后懒加载 Shiki；复制按钮 ✓ 反馈；无光标、无打字机（守则 §2.3）。
- **工具块**：折叠一行 36px（状态图标 + 动词+对象摘要 + 耗时）；展开 `grid-template-rows: 0fr→1fr`；失败默认展开、成功默认折叠；输出 >1 万字符截断 + 「复制完整内容」；连续工具调用合并分组（运行中显示当前工具）；思考块默认折叠。
- **权限卡**：内联卡片 + 允许/拒绝/总是允许；`allowAlways:false`（capability/ask_user）不渲染"总是允许"（协议 §6.1）。
- **Todo 面板**：输入框上方托盘；无 todo 不渲染；折叠显示"进行中 ± 相邻"共 3 条、全部完成显示最后 3 条；`+N` 进度；展开 >8 条内部滚动 240px。
- **输入框**：多行自适应（1–8 行）、Enter 发送/Shift+Enter 换行、`isComposing` 检查（IME 不误发）、流式变停止、Esc 停止。
- **玻璃**：统一 `GlassSurface`（tier A=liquid-glass-react 真折射仅选中标签滑块+回到底部；tier B=纯 CSS 磨砂：标签栏、输入框容器、权限卡浮层）；`prefers-reduced-transparency/contrast`、不支持 backdrop-filter 时降级实底；同屏 A≤2、A+B≤4。
- **其他**：断线重连指数退避提示条；FPS 面板（Ctrl+Shift+P，含同屏玻璃计数）；文案全部走 `i18n/zh.ts`；组件单文件 <300 行。

## 二、无头测试（本任务验收要求）

| 测试 | 运行 | 结果 |
|---|---|---|
| 协议 bridge（WS 黑盒） | `bun test tests/protocol.test.ts` | 10/10 pass |
| 协议 smoke（§10.3） | `bun run scripts/protocol-smoke.ts` | 5 项检查通过 |
| WebUI reducer 逻辑 | `cd webui && bun test test/reducer.test.ts` | 8/8 pass |
| **WebUI 无头渲染（happy-dom，无浏览器）** | `cd webui && bun test test/ui.test.tsx` | 7/7 pass：初始渲染/禁词扫描、流式 Markdown（含未闭合 `**`）、5 工具合并分组、权限卡出现→批准→消失、Todo 折叠 3 条/展开、错误条、标签草稿独立 |
| 生产构建 | `cd webui && bun run build` | ✓ 4.7s |
| 全仓 `bun test` | — | 1177 pass；130 fail 均为**既有环境失败**（Windows 无 symlink 权限 EPERM、PTY/沙箱限制），已用 `git stash` 对照确认与本次改动无关 |

## 三、库核实结果（附加件 §6.1 要求）

- `liquid-glass-react@1.1.1`：MIT；2025-06 发布（npm 最新）；peer react>=19 与本项目兼容；零依赖；解包 ~180KB。鼠标跟随/光斑未启用（不传 `mouseContainer`/`globalMousePos`），`aberrationIntensity=0`（禁色散）、`elasticity=0`、`displacementScale=0`。
- 备选未采用：`react-liquid@2.0.1` 2020 年发布，React 19 不兼容；`@liquidglass/react@0.1.3` 功能弱于首选且同为 2025-06 停更，选维护面更清楚的 `liquid-glass-react`。
- `GlassSurface` 统一封装，业务组件零直接引用；全局降级开关 `setGlassEnabled(false)`。

## 四、取舍与"spec 没写但我加了的东西"

1. **`AgentEvent` 两个非破坏扩展**（`transport/types.ts` 注释已声明）：`message_start.role?`（区分 user/assistant，协议侧天然有、mock 需要）；`tool_permission_request.allowAlways?`（§6.1 要求 UI 区分 permission 与 capability 卡片，接口原本表达不了）；另加 `history` 事件承载 attach 回放（协议 §7 的 reply 需要落到前端事件流）。缺省值均向后兼容。
2. **permission 表达为工具行上的状态**：协议的 `permission.request` 带的是 requestId 而非 toolId，适配器合成 `perm-<requestId>` 工具块，权限卡挂在其下——对应主 spec §4.4"在该工具行下方内联出现"。
3. **reducer 写时克隆**：主 spec 要求"已完成块 memo 固定"，zustand 常规不可变更新对"流式追加"不够（block 数组浅拷贝不换 block 引用），故实现 clone-on-write 并有测试锁定该性质。
4. **动画未用 motion（framer-motion）**：守则白名单全是简单 transition/animation，纯 CSS 足够，少一个运行时依赖（主 spec §7.1 自身也说"简单的用纯 CSS"）。
5. **`turn.error` 后补发 `turn.done`**：§5 要求 turn.error 之后必有 turn.done 或连接级 error，选了前者（UI 状态机更简单）。
6. **FPS 面板的自动降级**（附加件 §8）**未实现**：面板能显示 fps/glass 数，低于阈值自动降 A→B 的逻辑需要真实浏览器环境标定，留待浏览器内实测阶段。

## 五、未做清单（需要你确认的取舍）

- **Electron 壳与打包**（阶段 5）：主进程 spawn bridge、preload 注入 token、窗口拖拽区已预留 CSS（`-webkit-app-region`）。
- **会话持久化到 IndexedDB**：协议侧历史在 runtime 的 SQLite 里，attach 回放已通，浏览器侧离线持久化未做。
- **`/` 命令与 `@` 引用菜单**：按 spec 只预留接口，未做 UI。
- **消息编辑/重新生成的真实行为**：按钮就位（重新生成会重发末条用户消息），"从该处重新生成"未做。
- **Web Worker 里的 Markdown 解析**：rAF 批处理 + 块粒度 memo 已做；Worker 化待浏览器实测确认有需要再做。
- **FpsPanel 自动降级**（见上）。
- **真实 runtime 的完整会话工厂**：`Bridge` 通过 `createSession` 注入（缺省 mock 工厂）；把它接到 `src/index.ts` 的 provider/config 装配是 Electron 阶段的工作。

## 六、克制守则自检（§6）

- 产品名/技术栈/版本/"AI/智能"字样：无（无头测试含禁词扫描断言）
- 欢迎语/客套话/免责声明：无
- 假数据/统计卡：无；同一状态多处表达：无（运行中=标签状态点+工具行 loading，属同一信息链）
- 闪烁光标/跳动圆点/流光/错峰入场：无；同屏持续动画 ≤1（运行中指示：状态点呼吸或工具行 spinner）
- 渐变/发光/毛玻璃滥用/彩色图标底座：无（毛玻璃仅附加件白名单 4 元素内）
- 装饰性 emoji/装饰性图标：无；文案全部事实陈述、无第一人称、集中 i18n
- 动画全部在白名单（淡入/平移/grid-rows 展开/按压 0.97/运行中指示）；`prefers-reduced-motion` 全局降级
