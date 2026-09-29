# 测试报告：沙箱权限 / 权限管理 / 安全 / 性能

**姿态：只测不修**（审查模式）。测试时间：2026-09-29。测试对象：commit `5cdba67`（工作区含未提交改动的当前代码状态）。
测试方式：静态代码审查 + 模块级只读探针（bun 直接 import 被测模块）+ 现有测试套件基线采样。按用户约束，**未读取** `webui/` 目录与所有 docs/md 文档（含 `src/entry-webui.ts`、`tests/webui-server.test.ts` 等 webui 关联文件也一并回避）。

---

## 覆盖声明（最前）

| 层 | 状态 | 说明 |
|---|---|---|
| API/协议层 | 部分覆盖 | bridge（WebSocket 协议层）为**源码级审查**，未拉起服务做端到端连接测试；loop/registry/gate 权限链为源码级 + 模块探针验证 |
| DB 层 | 未测（仅源码走查） | 未执行 SQLite 对账；`store/repository.ts`、`store/db.ts` 仅静态审读 |
| UI 层 | 未测 | TUI 需交互终端；webui 按用户约束出界。`tests/tui-pty.test.ts` 等在 win32 下 22 例失败（平台性 PTY 限制），未逐一归因 |
| 性能效率 | 静态走查，未测 | 热点路径（tokenizer/BPE、loop 流式节流、readCapped、store JSON 解析）仅代码走查 + 既有 PERF 注释核对，无基准数据 |
| 兼容性 | 部分测 | Windows（本机）实探；Linux 侧（bwrap/原生沙箱 provider）**无法核实**——本机 win32 无法验证内核沙箱路径 |
| 无障碍 | 未测 | 本轮未纳入 |

**未测项（逐条列原因）：**
1. **Linux 内核沙箱端到端**（bwrap argv 构造、原生 provider、no_new_privs、断网）——平台不可达，无法核实。相关发现（如 P2-2 verify_commands 的沙箱兜底程度）在 Linux 上的实际强度只能给推断，不给结论。
2. **MCP stdio 沙箱**（`src/mcp/` 编译出的 NativeSandboxConfig 实际生效情况）——同上。
3. **完整 CLI/TUI 端到端弹窗流程**——无无头入口；弹窗次数结论来自代码路径 + 探针（planWriteApproval 返回值），未在真实 TUI 里目视确认。
4. **并发 TOCTOU 竞态实测**（atomic-write 的毫秒级窗口）——竞态需构造精确时序，未构造。
5. **provider adapters 协议逐字节测试**（openai-chat / anthropic-messages 流式解析）——时间预算外，有 `tests/anthropic-messages.test.ts` 未复跑归因。
6. **长会话内存曲线**（AgentEventBus 事件累积、TUI transcript）——未跑压测。
7. `tests/` 全量基线在 win32 下为红：1211 pass / 131 fail / 12 skip。抽样归因：TUI PTY 冒烟 2 文件 22 例（Windows PTY 平台性）；bash-authorization / command-scan / files / authorization 共 21 例——**失败原因正是本报告 P1-1 / P1-2 的路径分隔符语义**（测试用 POSIX 路径书写，在 win32 上 resolve 后不命中），即这批红测试是 bug 的现存证据而非环境噪音；其余 ~88 例未逐一归因。

---

## 一、发现的问题（严重度排序）

### P1-1【高】Windows 上"自由读 + 越界写"退化为"仅当前盘符"：跨盘读被拒、批准后的跨盘写仍失败、exec 溢写输出回读链路断裂

- **现象（普通人版）**：工作区放在 D 盘、用户主目录在 C 盘的电脑上（本机即如此），agent 想读 C 盘里的文件（比如自己的 home 目录、`~/.bugent/output` 下的完整命令输出）会直接报"路径越界"；用户明明批准了"允许写到工作区外"，写 C 盘仍然失败。命令输出太长时 agent 被告知"完整输出在 C 盘某文件，用 read_file 去读"，但 read_file 读不了——指引模型走进死胡同。
- **规则**：设计口径（`src/tools/files.ts` 头注释、`src/permission/mode.ts` 注释）是"三档都能读工作区之外（档位不限制读）"；`writeOutside` 按次批准后写应真实放行。
- **实际**（探针实证，win32 本机）：
  - `resolveReadable("D:\\bugent", "C:\\Windows\\win.ini", [ANYWHERE])` → 抛 `PathEscapeError`
  - `resolveForWrite("D:\\bugent", "C:\\tmp-x\\f.txt", grantedOutside=true)` → 抛 `PathEscapeError`（**用户已批准仍失败**）
  - 小写盘符 `d:\bugent\package.json`（同一目录，仅大小写不同）→ 抛 `PathEscapeError`
  - 当前盘不受影响：`D:\package.json` 可读、`D:\tmp-x\f.txt` 可写
- **根因定位**：`src/tools/paths.ts:36` `export const ANYWHERE = sep;`——Windows 下 `sep = "\\"`，而 `canonicalRoot` 对它 `resolve()` 后得到**当前盘符根**（`D:\`），ANYWHERE 哨兵退化为"当前盘任意"而非"任意路径"。`isInside`（paths.ts:39-41）是纯字符串前缀匹配，无大小写归一（NTFS 大小写不敏感）。`files.ts:267`（read_file）、`files.ts:43-45`（resolveWriteTarget）是受影响调用点。
- **严重度**：高。Windows 是本项目开发平台；跨盘布局（D: 工作区 + C: home）下核心读写闭环直接断裂，且 exec 溢写（`src/tools/spill.ts` 落 `~/.bugent/output/`）→ read_file 回读这条"长输出不丢信息"的补偿机制同时失效。

### P1-2【高】Windows 上所有 exec 工作区内写被误判为"写工作区外"：workspace-write 档承诺被打破，弹窗文案错误

- **现象（普通人版）**：Windows 上，agent 跑一条完全在项目目录里写文件的命令（比如 `echo hi > build.log`），系统弹窗说"这条命令会写工作区**之外**的文件"——事实上它写的就是工作区里面。选了"可写工作区"档本不该问的，现在每条带重定向/写命令的命令都要多挨一次误导性弹窗。
- **规则**：`src/sandbox/command-scan.ts` 设计原则"保守，判不出来就说判不出来"；`mode.ts` workspace-write 档 = "不用问就能读 + 写工作区"。工作区内写目标绝不该进 `outsidePaths`。
- **实际**（探针实证）：
  - `scanCommand("echo hi > build.log", {cwd:"D:\\bugent"})` → `outsidePaths = ["D:\\bugent\\build.log"]`（应为空）
  - `planWriteApproval` 对该命令返回 `{paths:["D:\\bugent\\build.log"], binds:["D:\\bugent"]}` → bash.ts:1041-1059 触发"写工作区之外"授权弹窗
  - 无 bwrap 平台（Windows）上 `requireApprovalEveryRun` 已经先弹一次（`builtin.ts:114-125`），叠加后**同一条命令两次询问**
  - 现有测试即证据：`tests/command-scan.test.ts`「写工作区内 -> 不打扰用户」「相对路径按 cwd 解析」「tee 的目标逐个判定」等在 win32 全部失败
- **根因定位**：`src/sandbox/command-scan.ts:457-460` `insideWorkspace` 硬编码 POSIX 前缀 `cwd + "/"`；而 `expandTarget`（:443-455）用平台绑定的 `path.resolve`，win32 产出反斜杠路径 → 前缀永不命中 → 全部判外。同族问题：`isEphemeral`（:417-419）只认 `/tmp`，Windows 的 `%TEMP%` 展开目标误判。
- **严重度**：高（功能承诺失效 + 弹窗疲劳训练用户无脑点"允许"，间接侵蚀整个按次授权模型的可信度）。方向是 fail-safe（多问不漏问），故不评"安全信任边界破坏"级。

### P2-1【中】运行时"总是允许"规则插到规则表最前，压过用户显式 deny 规则；且 resource 按 glob 解释，命令文本里的 `*` 会放大规则

- **现象（普通人版）**：用户在配置里写死"永远禁止 `git push --force`"。之后某次弹窗里点了"总是允许"某条相关命令，从此那条硬禁令可能被静默绕过——不需要用户再确认任何东西。
- **规则**：`gate.ts` 判定顺序第一条是"显式 deny 规则——硬性禁令，永远优先"；`policy.ts` 头注释只声明运行时授权压过"兜底规则"，未授权压过**用户显式写的 deny**。
- **实际**（探针实证）：
  ```ts
  const policy = new PermissionPolicy({ default:"ask",
    rules:[{ tool:"exec", resource:"git push --force*", decision:"deny" }] });
  policy.addRule({ tool:"exec", resource:"git push*", decision:"allow" });
  policy.evaluate({ tool:"exec", resource:"git push --force origin main", ... })
  // → decision: "allow"（应永远轮不到这条，deny 应生效）
  ```
  另外 `addRule` 把 `resource` 原文当 **glob** 编译：批准过的命令文本里含 `*`/`?`（如 `chmod 644 *.log`）会成为通配符，"总是允许"的实际范围比用户看到的那条命令更宽。
- **根因定位**：`src/permission/policy.ts:142-156`（addRule `unshift` 到最前 + `globToRegExp`）；调用方 `src/runtime/bridge.ts:459-477`（`permission.always`）。gate 的判定顺序（`gate.ts:175-237`）没有区分"构造期 deny"与"运行期 allow"的优先级。
- **严重度**：中。权限管理语义倒置；触发需要"存在 ask 弹窗 + 用户点总是允许"这一串前提，但一旦触发是静默的。

### P2-2【中】`apply_subagent_patch` 的 verify_commands 绕过 exec 的整条权限流：用户 deny 规则管不住、Windows 上无沙箱裸跑

- **现象（普通人版）**：模型可以借"应用子代理补丁后的验证命令"夹带任意 shell 命令。弹窗只显示"运行 N 条验证"，**不显示命令内容**；用户即使配了"禁止 curl"也拦不住验证命令里的 `curl`。
- **规则**：exec 的权限模型是三层兜底——用户规则（deny/ask）+ 执行前扫描（writeOutside/网络按次问）+ 无沙箱时逐条确认（`bash.ts:1004-1059`）。同等危险的命令执行不应因换了个工具入口而绕开。
- **实际**：verify_commands 来自模型入参（`agent.ts:571`），经 `options.verificationRunner.run()` 直接执行（`agent.ts:586-606`）——该 runner 就是 exec 工具用的 ShellRunner，但**不经过** `bashResourceClaims`/`scanCommand`/`planWriteApproval`/`onRequestCapability`，也不匹配 `{tool:"exec"}` 用户规则（工具名是 `apply_subagent_patch`，describe 的 resource 是 `workspace via <agentId>`）。Linux 上有 bwrap 断网兜底（runner 继承沙箱配置）；**Windows（无 bwrap）上是本地裸进程**，仅受 `requires:{write:true}` 的一次性闸门约束。
- **根因定位**：`src/tools/agent.ts:525-631`（applyPatch 工具）；runner 注入 `src/tools/builtin.ts:168-174`。
- **严重度**：中。模型发起 + 用户只看到条数就能放行任意命令；在无内核沙箱的平台上信任边界实际靠"用户读没读指令全文"之外的东西兜着。

### P2-3【中】bridge 会话命令不校验 attach 归属：任意持 token 连接可驱动/取消/关闭任意 session、裁决其权限弹窗

- **现象（普通人版）**：按协议设计，一个连接要"attach"某个会话才能看到它的事件；但实际上不 attach 也能直接给它发指令——包括替另一个连接的用户点掉权限弹窗、取消正在跑的任务、直接关掉会话。
- **规则**：bridge 注释与协议（§7）约束"每个 session 同时只允许一个连接 attach"；操作命令应只对已 attach 的连接生效。
- **实际**：`#requireSession`（bridge.ts:586-594）只检查 session 存在，不检查 `conn.attached.has(sessionId)` → `turn.send` / `turn.cancel` / `session.close` 均可跨连接操作；`#cmdPermissionResolve` / `#cmdPermissionAlways` / `#cmdAskUserAnswer`（:432-505）更是**遍历所有 session** 找 requestId，任何连接可裁决任何会话的挂起弹窗。缓解因素：所有连接共享同一静态 token（单用户本地模型），威胁主体是"本机另一个持 token 进程/页面"。
- **根因定位**：`src/runtime/bridge.ts:381-505`。
- **严重度**：中（协议授权模型与实现不符；本地单用户场景下实际风险可控，多客户端/嵌入宿主场景放大）。

### P3-1【低】多行命令绕过 deny/ask 规则：glob 编译出的正则 `.` 不匹配换行

- 探针实证：`globToRegExp("git push*")` → `^git push.*$`；`"git push\n--force origin main"` 不命中。
- 影响：硬性禁令按字面量都拦不住同一条命令的换行书写。`policy.ts` 头注释已声明"换行变体"是已知取舍（指 bash 语义变形），但这里连规则引擎自身的字面量匹配都不成立，超出声明范围。修复方向：编译时加 `s`（dotAll）标志或把 `\n` 归一。
- 严重度：低（deny 规则本不承担安全边界，档位 + 内核/逐条确认兜底仍在）。

### P3-2【低】bridge 的"总是允许"用在能力授权（联网/越界）弹窗上时存入一条永不命中的死规则

- `#buildHooks.onRequestCapability`（bridge.ts:535-546）构造的 request 是 `{tool: call.name, resource: ""}`；`#cmdPermissionAlways` 把 `resource:""`（空串 ≠ undefined）编译成 `^$` 规则——任何真实请求的 resource 非空，规则永不匹配。用户点"总是允许"的实际效果只是放行这一次，与按钮语义（"总是"）不符。
- 根因：`bridge.ts:459-477` 未区分 permission 往返与 capability 往返。

### P3-3【低】bridge 静态伺服的前缀校验无尾分隔符：可命中同名前缀的兄弟目录

- `bridge.ts:174-183`：`join(root, candidate)` 后 `resolved.startsWith(root)`——`root=/x/webui/dist` 时 `../dist-backup/y` → `/x/webui/dist-backup/y` 命中前缀被放行。`..` 逃逸本身被挡住，影响限于同父目录下 root 字符串前缀的兄弟目录。`staticDir` 默认不启用。修复：比对 `root + sep` 前缀。

### P3-4【低】bridge 权限/ask/降级往返无超时

- `authorization.ts` 的设计铁律"超时 = 拒绝（fail closed）"在 headless bridge 侧未接线（`#askPermission` 注释自认"超时结论 v0 不做"）。UI 连接挂着但不回答 → turn 永久挂起。断连路径已兜底（`#dropConn` 全部按 denied/undefined/false 收口），故不构成 fail-open，只构成挂起。

### P3-5【低】macOS keychain 删除凭据时漏掉 account 维度：可能误删其它条目

- `src/store/credentials.ts:123-128`：`security delete-generic-password -s SERVICE` 未带 `-a ${key}`，按 service 匹配删除（macOS 删第一个匹配项）——多 session/多 provider 并存时删错条目。Linux 的 `secret-tool clear` 带齐了 `service`+`account`，无此问题。

### P3-6【低】session 级 provider 配置只剔除 `apiKey`；`headers`（可含 Authorization）、`tls.passphrase`/`tls.key` 内联值会明文落 SQLite

- `src/store/repository.ts:297-308` 只解构掉 `apiKey`。`ProviderConfig`（registry.ts）含 `headers?: Record<string,string>` 与 `tls?: ProviderTlsConfig`（后者有 `passphrase`/`key` 字段）。用户以自定义 header 传凭据是常见用法——与 credentials.ts "绝不把 API key 写进 SQLite" 的契约精神不符。

### P3-7【低】`sed 's/a/b/w 文件'`（sed 的 w 写文件命令）持工作区**读锁**：并发 edit_file 存在丢更新窗口

- 探针实证：`bashResourceClaims("sed 's/a/b/w /tmp/evil.txt' input.txt")` → `[{key:"workspace", access:"read"}]`。`isReadOnlySegment`（bash.ts:697-704）只挡 `-i` 写法，不识别 sed 脚本体内的 `w file`/`r file` 命令。锁是并发正确性边界（非安全边界），读锁下并行的 edit_file 与该 sed 可交叉 → 丢更新。

### P3-8【低】exec 联网授权批准重跑后仍失败时，会再次弹网络授权（重试去重缺失）

- `bash.ts:1061-1101`：首次 scan 判出 needsNetwork → 用户批准 `allowNetwork` 重跑；若重跑依旧输出网络样式错误（如 DNS 解析真失败），底部兜底分支再次触发 `onRequestCapability({capability:{network:true}})` 向用户要第二次同语义授权。应记住本次已放行 network，重跑失败直接如实回传。

---

## 二、观察项 / 设计确认（不算 bug，供拍板）

1. **read-only 档下主代理的能力声明与自身不变量矛盾**：`src/index.ts:503-510` 与 `core/runtime.ts:252-259` 在 read-only 档仍给外部父身份声明 `fs.write/process.exec/agent.spawn`——`agent/model.ts` 的 `MINIMUM_AUTHORITY` 规定 read-only 权威不能持有 `fs.write`/`agent.spawn`（`validateAgentProfile` 会拒绝），但外部父身份是裸对象字面量，不走编译器校验。实际后果有限（子代理落盘在 worktree、回集走 `apply_subagent_patch` 的 write 闸门），但"衰减必须从合法父出发"的不变量被破坏。建议外部父身份同样过一遍 `compileAgentSandboxSpec`/`validateAgentProfile`。
2. **子代理 budget 字段未生效**（代码已自注，`tools/agent.ts:321-330`）：maxInputTokens / maxOutputTokens / maxWallClockMs 均未执行， runaway worker 只有 `SUBAGENT_MAX_STEPS=300` 步上限，无墙钟/成本上限。
3. **read_file 自由读 + 子代理组合的渗透链半程**：reviewer/explorer 拿无闸门的 read_file（`read-only-executor.ts:76-90`），按设计可读文件系统任意文件（含 `~/.ssh` 等），结果作为"data"回传父上下文。只读自由是产品决策，但"工作区内容当不可信数据"的提示词防线与"任意盘读"叠加时，注入内容可以引导子代理把敏感文件内容带进父上下文——再由父进程联网外传（需按次批准）。是否给子代理的 read_file 收窄 extraRoots，值得拍板。
4. **bridge `session.new` 的 cwd 完全由客户端指定**，无服务端 allowlist（`bridge.ts:294-304`）——嵌入式宿主（Electron）场景下等于"UI 决定 agent 的授权工作区"。若这是有意的（宿主即用户），建议在协议注释里写明信任假设。
5. **`writesOutsideWorkspace` 与批准后解析的口径差**：文件工具在 Windows 上，工作区内但含小写盘符的路径会先被判"越界"（走弹窗）、批准后仍解析失败（P1-1）——用户被问了又失败，体验为"批准无效"。
6. **AgentEventBus 的 `#events` 与 `#messages` 数组只进不出**（supervisor.ts:217, 320）——长会话 + 多子代理持续累积；runtime 生命周期内无上界。
7. **性能走查结论（未测基准，仅静态）**：
   - 做得好的：tokenizer BPE 的 O(n²) 有 128 符号切片上限 + 8192 条 LRU 缓存（PERF-003）；loop 工具参数流式预览 40ms 节流且无消费者时完全跳过（PERF-004）；`readCapped` 截断后继续消费防管道死锁；`readWindow` 流式读避免大文件全量入内存；`read_file` 的 8MB 扫描上限防深 offset 扫全文件。
   - 存疑待测：`store/repository.ts` 每条消息行 `JSON.parse`（`buildContext` 高频路径的重复解析成本）；`P1-2` 修复前 Windows 上 scan 对每条命令跑两遍正则/路径解析（量级小，非热点）；TUI `app.ts`（5015 行）未走查——本轮性能面以数据/执行链为限。

---

## 三、已验证正确的逻辑（下轮回归的对照组）

**档位与闸门**
- `defaultApproves` 三档 × {write, writeOutside} 语义全部正确（探针：workspace-write+write→true；workspace-write+writeOutside→false；read-only+write→false）
- 批准一次只生效一次：gate 不回写档位，`setMode` 仅用户路径可达
- 授权窗口 fail-closed、三态（approved/denied/timeout）区分、超时后迟到的批准被丢弃、request 同步抛异常走清理不泄漏计时器（BUG-024 修复在位）
- gate 判定顺序：deny → 越界按次授权 → ask → 放行；no-sandbox 下工具自报 ask 升级为 allow、用户显式 ask 保留（index.ts:571-587）

**路径与文件写入**
- `resolveWithin` 的三重符号链接防护（最近存在祖先 realpath + 末段 lstat + 悬空链接拒绝）
- `atomicWriteWithin` 四道边界复核（mkdir 前/temp 落盘前/rename 前/落点复核+自清理）、`wx` 标志、mode 保留（BUG-012/BUG-020 在位）
- 资源锁：normalizeClaims 合并、目录前缀重叠判定、FIFO 队头公平、abort 三态清理
- `fileResource` 越界目标降级为整 workspace 锁而不是抛错（保住"按次授权"可达闸门）

**exec 与扫描**
- 环境变量白名单跨平台正确（Windows PATHEXT/SystemRoot 等地基变量 + 大小写归一）；`createShellRunner` 无沙箱路径同样过滤（pass_env 逃生口接通）
- 扫描器的 `$( `` ` `)` / `<(` / `>&file` / `~user` / 注释里的 `~`（BUG-010）/ `sudo -u root tee` 带值选项跳过 / `cp -t` 目标优先 / `2>&1` fd 复制 / 敏感目录 bind 绝不放开（.ssh/.gnupg/.aws/.config/.bugent）
- 联网"先真跑失败→带真实报错问"（BUG-009 文案明示报错可伪造）；重跑硬上限一次
- 网络/超时：已 abort signal 不再起进程；读失败兜底 SIGKILL；timeout 用 Bun 原生 + killSignal SIGKILL

**子代理**
- 权威衰减编译期（compileAgentSandboxSpec）+ 运行期（supervisor.spawn）双重校验；能力衰减 assertCapabilityAttenuation；深度上限、session 唯一性、rootId 一致性全被强制
- reviewer/explorer 永久无 fs.write（executor 运行时再拒一次）；worker 仅在沙箱可用时才拿到 exec；worker 永不持有用户交互通道（onRequestCapability 恒 denied）
- 子代理通知以"data, not instruction"标注注入（trust: untrusted-data）；terminal 通知只入安全边界（enqueueInjection）
- 补丁完整性：artifact digest 绑定校验 + 验证失败回滚

**凭据与协议**
- apiKey 读写两处都强制剔除（不入 SQLite）
- MCP 工具默认 `ask`（提示注入的人工闸门）+ `needsSandbox`
- bridge：首消息强制 hello+token 握手；断连把所有挂起授权按 denied 收口（fail-closed）；协议版本协商

---

## 四、数据还原说明

- 本轮为静态审查 + 只读探针，**未拉起** bugent 应用、未触碰 `~/.bugent` 下的用户数据、未改动任何业务文件。
- 测试残留：探针脚本位于 `.tmp-probe/`（probe.ts / probe2.ts），交报告后已删除；未在工作区/沙箱外落任何文件。
- `bun test` 基线对账：测试套件自身不改状态（临时目录自管理）；结束后 `git status` 与开工前一致（除本报告与校准单两个新增文件、探针目录已删）。
- 用户的常驻服务：开工时无（端口摸底 3000/8080/8081/5173 无监听），未动。
