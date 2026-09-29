# 回归校准单 —— bugent（沙箱/权限专项首轮）

> 建单：2026-09-29，commit `5cdba67`，配套报告 `test-report-sandbox-permission-20260929.md`。
> 用法见文末。探针均为**只读**断言，直接 `bun run` 即可，不产生文件副作用。

## 表

| # | 当年症状 | 最小探针 | 兜住它的规则 |
|---|---------|---------|-------------|
| 1 | Windows 跨盘（工作区 D: / home C:）下 read_file 读 C 盘被拒、批准 writeOutside 后写 C 盘仍 PathEscapeError；小写盘符同目录被拒 | `resolveReadable("D:\\bugent","C:\\Windows\\win.ini",[ANYWHERE])` 应成功；`resolveForWrite("D:\\bugent","C:\\x\\f",true)` 应成功；小写盘符同目录应成功 | 信任边界/守卫一致性：ANYWHERE 哨兵语义必须平台无关；路径比较需大小写归一（win32） |
| 2 | Windows 上 `echo hi > build.log`（工作区内）被判"写工作区外"并弹错误授权窗 | `scanCommand("echo hi > build.log",{cwd:"D:\\bugent"}).outsidePaths` 应为空；`planWriteApproval(...)` 应返回 undefined | 守卫一致性：工作区内外判定必须用平台 sep（或统一归一化）拼前缀；现有 `tests/command-scan.test.ts` 在 win32 必须全绿 |
| 3 | 用户显式 deny 规则被运行时"总是允许"插队压过；批准的命令文本含 `*` 时 allow 规则被 glob 放大 | 构造 `{rules:[{tool:"exec",resource:"git push --force*",decision:"deny"}]}` 后 `addRule({tool:"exec",resource:"git push*",decision:"allow"})`，evaluate `git push --force origin main` 应仍为 deny | 权限语义：显式 deny 优先级 > 运行时 allow > ask 默认；addRule 不得越过构造期 deny（或 deny 规则单列硬禁令层） |
| 4 | `apply_subagent_patch` 的 verify_commands 不经 exec 权限流（用户 deny 规则管不住、win 无沙箱裸跑、弹窗只见条数） | 以 verify_commands 含 `curl --version` 调 apply_subagent_patch：配置 `{tool:"exec",resource:"curl*",decision:"deny"}` 应能拦截（或弹窗列出命令全文） | 守卫一致性：同一危险动作（任意命令执行）无论从哪个工具入口进，都必须过同一套规则+扫描+逐条授权 |
| 5 | 多行命令绕过 deny/ask glob 规则 | `globToRegExp("git push*").test("git push\n--force origin main")` 应为 true（dotAll 或归一后） | 校验收口：资源匹配的正则必须与命令文本的实际形态（含换行）对齐 |
| 6 | bridge"总是允许"点在联网/越界 capability 弹窗上存入永不匹配的死规则（resource=""） | bridge 会话内对 capability.request 发 permission.always → 断言 addRule 未产生 `{tool,resource:"^$"}` 死规则，或 capability 有自己的持久化语义 | 错误码/语义不撞车：permission 往返与 capability 往返必须在协议层区分，不得共用同一 requestId 处理器 |
| 7 | bridge turn.send/turn.cancel/session.close/permission.resolve 不校验 attach 归属，跨连接可驱动任意会话 | 已授权但未 attach 的连接对 session A 发 turn.cancel / permission.resolve → 应拒绝（not_attached）而非生效 | 隔离/所有权：会话操作必须校验连接-会话绑定关系 |
| 8 | bridge 静态伺服 `resolved.startsWith(root)` 无尾分隔符，同名前缀兄弟目录（dist-backup）可被命中 | candidate=`../dist-backup/x` → 应 404 | 信任边界：路径前缀判定一律补 `sep` 尾缀再比对 |
| 9 | bridge 权限往返无超时，UI 挂着不答时 turn 永久挂起 | 发起含 ask 规则的命令后不应答 → 应在授权窗口（60s）后按 timeout 收口并回传模型 | 异步触达/超时语义：一切"等人"的入口统一走 withAuthorizationWindow（fail closed） |
| 10 | macOS keychain delete 漏 `-a key`，误删同 service 其它账号条目 | `delete(s1,"openai")` 后 `get(s2,"openai")` 应仍在（darwin 路径，mock runCommand 断言 argv 含 `-a s2:openai`） | 台账/所有权：按 (sessionId, providerId) 二元组的增删查改必须全维度匹配 |
| 11 | session provider 配置只剥 apiKey，headers（Authorization）/tls.passphrase/tls.key 明文落 SQLite | `setProviderConfig` 后直查 session_providers.config，断言 headers.Authorization / tls.passphrase 不在 JSON 里 | 凭据卫生：持久化前的敏感字段清单要覆盖所有可携带凭据的字段，不只 apiKey |
| 12 | `sed 's/a/b/w out.txt'`（无 -i）持工作区读锁，与并发 edit_file 丢更新 | `bashResourceClaims("sed 's/a/b/w o.txt' i.txt")[0].access` 应为 "write"（或 isReadOnlySegment 识别 sed w/r 命令） | 并发正确性：写通道识别必须覆盖命令体内的写原语，不只选项位 |
| 13 | exec 联网批准重跑仍失败会二次弹网络授权 | mock 场景：批准 network 后重跑输出仍含 "Could not resolve host" → 不应再次触发 onRequestCapability | 幂等/重复：同一调用同一能力的授权一次生效，重试不重复打扰 |
| 14 | （基线记忆）win32 下 `bun test` 红测试的两类来源：TUI PTY 冒烟（平台性）与路径分隔符语义套件（=探针 1/2 的现存证据） | 修复探针 1/2 后：tests/command-scan / bash-authorization / files / authorization 应转绿；PTY 类单独豁免 | 单点坏数据 vs 全局：测试基线红必须能按类归因，不允许"红着跑"掩盖新回归 |

## 用法

1. **下一轮开工前通读本表**，每条探针都是必配项；#14 的基线红分类是"哪些失败可以忽略"的唯一依据。
2. 修复合入后，对应行就是最快冒烟单：探针 FAIL = 同类 bug 复发。
3. 新一轮发现的新问题按「症状 → 最小探针 → 规则」追加成行，不要改旧行。
