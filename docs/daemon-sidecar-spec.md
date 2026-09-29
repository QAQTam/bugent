# bugent daemon / sidecar spec(v1 草案)

> 进程与生命周期侧 spec。目标:让 `bugent.exe` 同时是 **后端 daemon 兼 CLI**,并为未来 Electron 以
> **sidecar** 方式托管后端做好准备。本文只定义**进程角色、发现与鉴权、生命周期、以及为此对
> UI 协议做的增量修订**;线上消息格式仍以 `docs/ui-protocol-spec.md` 为准,冲突处以本文为准并回改该文档。
>
> 背景输入:`docs/claude-agent-protocol-review.md`(协议裁决表,重点 A2/A3/A8、B 组、C11)与
> opencode-2 的同构实现(单二进制多模式、注册文件发现、stdio sidecar、SQLite 事件 seq)。

## 1. 目标与非目标

**目标**

- 一个二进制 `bugent`,通过子命令承担四种角色:TUI/一次性 CLI(现状)、前台 server、受管 daemon、sidecar;
- 前端(WebUI / Electron / 未来 buTUI GUI)全部作为协议客户端接入,不持有业务逻辑与密钥;
- daemon 可被发现、验活、复用、防双开、可受管退出;Electron 拉起的 sidecar 生命周期与宿主绑定;
- 协议增量修订(全部**非破坏性**,`UI_PROTOCOL_VERSION` 保持 1)补齐 review 的 B 组 P0:seq、事件日志、补发、快照衔接、心跳、背压;
- CLI 与 server 共用同一份 runtime 装配,消除 `src/index.ts` 与 `src/entry-webui.ts` 的能力漂移。

**非目标**

- 不做跨机部署/远程访问(仍仅绑定回环;`--hostname` 覆盖属于显式越过,文档警告不拦截);
- 不做多用户/多租户鉴权(单用户本机信任模型,token 只防"别的本地进程误连");
- 不做 daemon 崩溃后运行中 turn 的自动恢复(opencode 式 execution claim 留 v2,本文只保证"标记中断",见 §9.3);
- 不把 TUI 改写为协议客户端(TUI 维持进程内模式;TUI-over-protocol 留 v2)。

## 2. 角色与命令面

| 命令 | 角色 | 行为 |
|---|---|---|
| `bugent` | TUI(不变) | 进程内装配,TUI 直接持有 session |
| `bugent -p "…"` | 一次性(不变) | 进程内跑完即退 |
| `bugent serve` | 前台 server | Bridge + 静态页,Ctrl+C 退出;默认给 WebUI/开发用 |
| `bugent serve --sidecar` | sidecar | stdout 握手 + stdin 退出,专供宿主进程托管(§5) |
| `bugent serve --daemon` | 受管 daemon | 注册文件 + 空闲自退 + 持有者监视(§4) |
| `bugent server status` | 管理命令 | 读注册文件并验活,打印 `{url, pid, version, alive}` |
| `bugent server stop` | 管理命令 | 向 daemon 请求优雅停止(§9.2) |

规则:

- `serve` 系列共用 `--port`(缺省 0=随机)、`--cwd`、`--mock`、`--yes`、`--mode`、`--no-persist` 等现有选项;
- `--sidecar` 与 `--daemon` 互斥,同时给出必须报参数错误;
- `server status` / `server stop` 是纯客户端:只读/写注册文件 + 发一次 HTTP/WS 请求,**绝不自行拉起 daemon**;
- TUI 的 daemon 接入(探测→拉起→复用)在 v1 **不做**,`bugent` 行为与今天完全一致。

## 3. Runtime 装配单一来源

- 新增 `src/runtime/assembly.ts`:导出 `createFullSessionFactory(options)` —— config 加载、provider 解析、
  default tools、MCP / skills / goal 工具集、`PermissionPolicy` 组装、`SessionStore` 打开、`openSession`。
- `src/index.ts`(CLI)与 serve 系列入口都必须经它装配;`src/entry-webui.ts` 退役为薄壳
  (只保留参数解析与 `startWebui` 兼容导出,内部改调 assembly)。
- **能力对等验收**:同一份 config 下,`session.new` 产出的会话在 TUI 与 server 两条路径上
  注册表工具集合、MCP manifest、goal 工具完全一致(新增测试断言工具名集合相等)。
- 允许的显式差异只有一处:server 路径的权限 prompter 走协议往返(bridge 统一构造 gate,现状保持)。

## 4. Daemon 模式(发现、防双开、退出)

### 4.1 注册文件

- 路径:`~/.bugent/server.json`(Windows 即 `%USERPROFILE%\.bugent\server.json`)。
- 内容:

```jsonc
{
  "v": 1,
  "id": "srv-018f…",       // 本次 daemon 实例 id,启动时生成
  "pid": 12345,
  "version": "0.4.0",
  "url": "ws://127.0.0.1:53124/ws",
  "httpUrl": "http://127.0.0.1:53124",
  "token": "…",            // 32 字节随机 base64url
  "startedAt": 1730000000000
}
```

- 写入:临时文件(`server.json.<id>.tmp`)+ rename 原子替换,mode `0o600`;写前先读旧文件,
  若旧文件里是一个**仍存活且版本兼容**的 daemon,本次启动直接复用并退出(打印其 url),不写文件。

### 4.2 启动算法

1. 读注册文件;文件存在且 `GET /healthz`(§6.4)可达 → 复用现任,输出 url,进程退出 0;
2. 否则 `Bun.serve` 起监听;`EADDRINUSE` → 回到 1 重试(共 3 次,间隔 500ms),仍失败则报错退出;
3. 监听成功后原子写注册文件;
4. 启动**持有者监视**:每 5s 重读 `server.json`,若 `id !== 自身 id`(被新实例替换)→ 走 §9.2 优雅停止。
   这保证升级换装时旧 daemon 自动让位,不需要 kill。

### 4.3 空闲自退

- 条件同时满足:`#conns` 为空、无 `activeTurn`、无 pending permission/ask_user/fallback;
- 时长 `--idle-exit <minutes>`,daemon 缺省 15,`serve` 缺省关闭(0);
- 退出走 §9.2 同一条优雅停止路径。

## 5. Sidecar 模式

- 启动:端口恒为 0(随机);**stdout 上只允许出现一行握手**,其余日志一律走 stderr:

```jsonc
{"v":1,"pid":12345,"url":"ws://127.0.0.1:53124/ws","token":"…","version":"0.4.0"}
```

- 宿主(Electron main)读到此行即完成握手;renderer 永远拿不到 token(§7.3);
- 退出:**stdin 关闭**(含宿主崩溃导致的管道断裂)是唯一退出信号。收到后走 §9.2,宽限 5s;
- **token 不得进入任何环境变量**;sidecar 启动时应主动从 `process.env` 删除宿主可能误传的
  `BUGENT_SERVER_TOKEN`,防止被工具子进程继承;
- sidecar 不写注册文件、不参与 daemon 发现(宿主自管生命周期)。

## 6. 鉴权与端点

### 6.1 token

- 32 字节 `crypto.getRandomValues` → base64url,每进程启动生成一次;
- daemon:存注册文件(0o600);sidecar:只经 stdout 管道交给宿主;
- 校验失败/首条非 `hello`:现状不变(`error` evt + close 4401)。

### 6.2 WS 握手

- 现状保持;Electron 场景由 main 持 token、renderer 经 preload 注入后随 `hello` 发送。

### 6.3 WebUI 静态页

- v0 的 `?token=` query 传参**降级为 dev-only**(显式 `--dev-token-in-url` 才启用,缺省关闭);
- 正式路径:页面加载后通过 `POST /session-token`(同源、回环)换取 token;
  服务端仅对 `127.0.0.1` 来源且 `Origin` 与自身同源时返回 `{token}`,其余 403。

### 6.4 健康检查

- `GET /healthz`:**免鉴权**,只返回 `{name:"bugent", id, version, protocol:1}` —— 不含 token、不含 session 信息;
  用途:发现验活、版本匹配探测;
- 其余 HTTP 路径(静态资源除外)未来新增时必须先过鉴权;静态资源目录只含构建产物,视为非敏感。

## 7. Electron 接入约定(前瞻)

1. main 进程 spawn `bugent.exe serve --sidecar`(Electron 打包时 exe 作为资源内嵌,附带版本文件);
2. 读握手行 → main 保存 `{url, token}`;
3. renderer 通过 preload 拿到 `url`,**token 由 main 在每次需要时注入**(v1 最简实现:main 起一个
   本地代理或经 IPC 把 token 按次交给 preload 闭包,不得落 renderer 全局变量);
4. 宿主退出 → stdin 关闭 → sidecar 优雅停止,无需 PID 管理;
5. 启动时可并发读 `~/.bugent/server.json` 探测已有 daemon(`version` 主版本一致才复用),
   复用则不 spawn sidecar —— 该优化 v1 可选。

## 8. 协议增量修订(对 ui-protocol-spec,全部非破坏性)

以下改动并入 `docs/ui-protocol-spec.md` 的下一次 minor 修订;`UI_PROTOCOL_VERSION` 恒为 1,
未知字段按 §9 既有规则处理。

### 8.1 事件序号 seq(B1/B2)

- `#evt` 发出的**每个 session 级 evt** 增加信封字段 `seq: number`:bridge 按 session 单调递增,从 1 开始;
- 分配即定序:同一 session 的事件先分配 seq 再发送,WS 单流保证到达序 = seq 序(单连接语义下);
- `reply` 与连接级 `error` **不带 seq**(它们不属于 session 事件流)。

### 8.2 事件日志与补发(B2/B3/B5/B6)

- bridge 为每个 session 维护**有界环形日志**(缺省 4096 条,含全部 session 级 evt);
- 写入顺序:**先 append 日志,再 send**(推送出去的事件一定已在日志里);
- `session.attach` 请求增加可选 `afterSeq?: number`;reply 增加必带 `lastSeq: number`(日志中最新 seq):
  - `afterSeq` 缺省或 `0`:全量回放(现状) + `lastSeq`;
  - `afterSeq > 0` 且 `lastSeq - afterSeq < 4096`:补发 `(afterSeq, lastSeq]` 区间事件(仍以
    `{...message, replay:true}` 形态区分回放与 live),然后切 live;
  - `afterSeq` 太旧(超出窗口):reply `ok:false, code:"seq_too_old", lastSeq` —— 客户端必须重新全量回放(B5 降级路径);
- 客户端按 `seq` 去重:重连补发与 live 的边界处,`seq <= 已见最大值` 的事件丢弃。

### 8.3 进行中快照(B7)

- `BridgeSession` 在 turn 进行中累积"当前 assistant 草稿":`turnId`、已累积 text、已出现的 tool 卡
  (call + 最新 delta 状态);`turn.done` 后清空;
- `session.attach` reply 增加可选 `snapshot?: { turnId, draftText: string, tools: [{id, name, args, running}] }`;
  客户端据它重建进行中的消息,此后 delta 直接续写,不缺字、不重复。

### 8.4 挂起请求进快照(A6)

- `session.attach` reply 增加可选 `pending?: Array<{ kind: "permission"|"capability"|"ask_user"|"fallback", requestId, payload }>`;
- 客户端据此重建权限卡/提问卡;resolve/answer 语义与 live 完全一致(requestId 通用)。

### 8.5 历史分页(D1/D2/D3)

- 新 cmd `session.history`:`{ sessionId, before?: number, limit?: number }`
  (`before` 为消息 msgid 游标,`limit` 缺省 50,上限 200);
- reply:`{ ok, messages: StoredMessage[], hasMore: boolean, nextBefore?: number }`,页内按 msgid 升序;
- `session.attach` 的全量回放**改为只回最近 `limit`(缺省 100)条** + `hasMore`;更早历史一律走 `session.history` 向前翻;
- 消息落库于 SQLite(`SessionStore`),`before` 走主键游标查询,不做全表扫描(D9 的最低满足形态);
  纯内存 session(未持久化)分页退化为内存数组切片,语义相同。

### 8.6 心跳与背压(B10/A7)

- bridge 对每条已授权连接每 **15s** 发一帧 `{"kind":"evt","type":"server.ping",…}`(无 `sessionId`);
  客户端 **45s** 未收到任何帧(含 ping)视为死链,主动重连;
- 每条连接的出站队列有界(**4096 帧**):队列满 → 该连接 `close(1013)`,绝不阻塞事件循环;
  客户端收到 1013 后按既有退避重连,重连后用 `afterSeq` 补发(§8.2);
- 客户端重连修复:`ProtocolTransport.ensureSession` 必须以 `attached === false` 为准重新 attach
  (修复现状"重连后 serverId 仍在、永不重连 attach"的 bug,B9 的行为缺口)。

### 8.7 管理命令

- 新 cmd `server.stop`(无 `sessionId`):仅限已授权连接;服务端走 §9.2 后回 `{ok:true}`;
  daemon 模式下这是 `bugent server stop` 的实现路径;
- 新 cmd `server.info`:reply `{ ok, version, protocol: 1, uptimeMs }`。

## 9. 生命周期与停止语义

### 9.1 会话恢复(B8 前半)

- `session.list` 返回 = 内存活跃 session ∪ **`SessionStore.listSessions` 的持久化 session**
  (持久化项 `activeTurn:false`,附 `persisted:true`);
- `session.attach` 命中持久化但未加载的 sessionId → 工厂从 SQLite 恢复 `AgentSession`(openSession 既有
  恢复路径),再走正常 attach;恢复失败回 `ok:false, code:"restore_failed"`。

### 9.2 优雅停止(统一路径)

`server.stop` / stdin 关闭 / SIGINT / SIGTERM / 持有者被替换 / 空闲超时,全部进入同一条路径:

1. 停止接受新 cmd;对所有 pending permission/ask_user/fallback 以 `denied`/abort 结论释放(与 §6 断连语义一致);
2. 活跃 turn 给 **10s** 宽限跑完;到期 `abort()`;
3. 给每条连接发 `error {code:"server_stopping", fatal:true}` 后关闭;静态页停止服务;
4. `SessionStore` 关闭;daemon 模式删除自己写的注册文件(原子 rename 掉,而非 truncate);
5. 进程退出码 0。

### 9.3 崩溃与非优雅退出

- 无 shutdown hook 依赖;重启后持久化 session 一律 `activeTurn:false`,**不自动续跑**;
  中断的 turn 以最后落库消息为止,前端通过 `session.history` 看到的是截断后的历史(v1 接受,自动恢复留 v2)。

## 10. 打包与分发

- `webui/dist` 经 `Bun.embeddedFiles` 内嵌进 exe;`Bridge.staticDir` 改为优先读嵌入资产,
  文件系统目录仅作 dev 覆盖(与 `prepareStandaloneRuntime` 释放嵌入资产的既有先例同构);
- `scripts/package-bugent.ts` 产物附带 `bugent-cli.version` 文本文件,供宿主做版本匹配探测;
- Windows 升级期间运行中的旧 exe:依赖 §4.2 持有者自退让出文件句柄,**不得依赖 taskkill**;
  打包脚本在替换前应先调 `bugent server stop`(存在时)。

## 11. 安全边界

- 仅回环绑定;`--hostname` 覆盖时启动横幅必须打印醒目警告(密钥模型不适用于局域网);
- token 的全部传递通道只有三条:注册文件(0o600)、sidecar stdout 管道、`POST /session-token`(同源回环);
  **不得**出现在:环境变量、命令行参数、URL query(dev 开关除外)、日志;
- 工具子进程继承的 env 不得包含 token(sidecar 启动时主动清理,§5);
- renderer(浏览器/Electron)永远只持有"能连上 server"的凭据,provider API key 只存在于服务端进程内存
  (现状保持,review A9)。

## 12. 里程碑与验收

| 阶段 | 内容 | 验收(全部要可执行测试) |
|---|---|---|
| M1 装配归一 | §3 | 工具集对等测试;现有 `protocol.test.ts` / `e2e.test.ts` 全绿 |
| M2 sidecar | §5、§7 | 测试:spawn `--sidecar` → 读到单行握手 JSON;关闭 stdin → 进程 5s 内退出且退出码 0;stdout 除握手行外无输出 |
| M3 seq + 补发 + 快照 | §8.1–8.4 | 测试:同 session 事件 seq 严格递增;attach `afterSeq` 补发区间正确;`seq_too_old` 降级;turn 中途 attach 的 snapshot 续接不缺字;pending 权限出现在 attach reply |
| M4 分页 + 心跳/背压 | §8.5–8.6 | 测试:history 游标翻页 hasMore 正确;15s ping;模拟慢消费者 → 1013 断开且不阻塞其它连接;重连后自动 re-attach 补发 |
| M5 daemon | §4、§6.4、§9 | 测试:二次启动复用现任;注册文件被替换 → 旧 daemon 自退;`server stop` 优雅停止;空闲超时退出;崩溃重启后 session.list 可见持久化 session 且 attach 可恢复 |
| M6 打包 | §10 | exe 内嵌 webui;`/healthz` 免鉴权;sidecar 场景 renderer 无 token 端到端冒烟 |

对 review 裁决表的预期覆盖:M1–M6 完成后,A2/A3/A8、B1/B2/B3/B5/B6/B7/B8/B9/B10、C3(补 seq)、
D1/D2/D3/D9 达标;A4/A5/A6 由 §8.3/§8.4 提供数据基础,多前端同看(放开 `session_taken`)另行裁决。

## 13. 开放问题(实现前需拍板)

- 注册文件 token 的 Windows ACL:0o600 在 NTFS 上的实际语义需验证,不足时考虑 DPAPI 加密;
- `session.history` 游标用 msgid 还是 seq(若事件日志未来落库,seq 游标可统一消息与事件两套体系,倾向 seq);
- Electron main 注入 token 的具体机制(IPC 按次 vs 本地代理)留 WebUI/Electron spec 细化;
- 空闲自退缺省值与"挂起审批是否阻止自退"的交互(本 spec 取"阻止",待产品确认)。
