# 权限授权统一规范

> 状态：规范 · 已按本文实现并全量回归（`bun run typecheck` 通过，`bun test` 1110 pass / 1 skip / 0 fail）
> 前置：`src/permission/mode.ts`、`src/permission/gate.ts`、`src/sandbox/bwrap.ts`、`src/tools/bash.ts`
> 相关：`docs/workspace-ledger-sandbox.md`（观测层缺口，与本规范互补）

---

## 0. 一句话规则

**谁能静态判、就在调用前判；谁不能静态判、就交给沙箱判。两条路都必须先拿到授权，再执行。**

| 工具类别 | 判在哪 | 判定时机 | 越界怎么办 |
| --- | --- | --- | --- |
| 进程内工具（`read_file` / `write_file` / `edit_file` / `apply_patch`） | **权限体系第一层**：调用前闸门 | 调用前 | 弹窗按次授权；批准只对这一次生效 |
| 沙箱子进程（`bash`） | **权限沙箱体系**：执行前静态判定 + 内核兜底 | 执行前（能判定时） | 弹窗按次授权；批准后本次 argv 真放开 |

两条路共用同一套「按次授权」语义（`CapabilityGrant`）、同一个 60 秒窗口、同一套回传文案。

---

## 1. 为什么需要统一

改之前的实际行为是**同一件事、两个工具、两种结果**：

| 意图（`workspace-write` 档） | 实际发生 | 用户看到的 |
| --- | --- | --- |
| `write_file` 写工作区外 | 闸门弹窗，批准后写成功 | 弹窗 → 批准 → 落盘 |
| `bash` 重定向写工作区外 | 内核 `EROFS`，**不弹窗** | 一句「只读文件系统」，没有申请入口 |

根因不是漏接线，而是 bash 被有意排除在闸门外（`src/tools/types.ts`：走沙箱的工具不用声明
`requires`，内核会挡住）。这条推理只在 **`read-only` 档**成立 —— 那一档本来就该硬挡。
但 `workspace-write` 档的档位语义是「写工作区外 → 逐次批准」，bash 却连申请的机会都没有，
唯一的出路是切到 `no-sandbox`（= 默认批准一切，含联网、含整个 `/` 可写）。

**这正是 `src/permission/mode.ts` 明令禁止的模式**：那里写着「越界走按次授权，不走升档」。
bash 这条路径上，「按次授权」被降级成了「永久全量授权」。

所以本规范要修的不是某一条线，而是**把 bash 拉回同一套按次授权语义**。

### 1.1 统一之后的行为矩阵（实测）

三档 × 三类越界操作，`bash` 的实际表现：

| 档位 | 操作 | 弹窗 | 批准后 | 拒绝后 |
| --- | --- | --- | --- | --- |
| `read-only` | 写工作区内 | **是** | 跑了·成功 | 拦下·没跑 |
| `read-only` | 写工作区外 | **是** | 跑了·成功 | 拦下·没跑 |
| `read-only` | 联网 | **是** | 跑了 | 拦下·没跑 |
| `workspace-write` | 写工作区内 | 否（档位已授权） | 跑了·成功 | 跑了 |
| `workspace-write` | 写工作区外 | **是** | 跑了·成功 | 拦下·没跑 |
| `workspace-write` | 联网 | **是** | 跑了 | 拦下·没跑 |
| `no-sandbox` | 全部 | 否（默认批准一切） | 跑了 | 跑了 |

关键点：**默认批准范围之外的操作是「拦截 + 逐次授权」，不是「直接拒绝」**。
只有三种情况才是硬拒绝：显式 `deny` 规则、没有可交互的确认入口（`-p` / 无 TTY）、
以及 60 秒窗口超时。

「批准后」一列不是断言返回值形状，而是**真的跑通了**：写工作区外会真的落盘
（`tests/bash-authorization.test.ts`），联网会真的连上本地服务（同一文件里的
`Bun.serve` + `curl` 用例）。

---

## 2. 第一层：调用前闸门（进程内工具）

不变的部分，写在这里是为了确定边界：

- **入口**：`ToolRegistry.execute()` → `describeCall(tool, call, ctx)` → `gate.check()`。
- **输入**：`requires`（工具的**静态**声明）+ `writesOutside`（**逐次**判定，由路径参数决定）。
- **判定顺序**：`deny` 规则 → 越出 `defaultApprove` → `ask` 规则 → 放行。
- **越界结果**：弹窗；批准**不改档位**，只把 `grant.writeOutside` 下发到这一次调用的
  `ToolCtx.grant`，由 `paths.ts:resolveForWrite` 决定路径解析宽度。

进程内工具没有内核兜底，所以档位能力**必须**由闸门执行 —— 这是 `requires` 必填的原因。

---

## 3. 第二层：沙箱越界（bash）

bash 的输入是一条不透明命令串，`git status` 和 `python x.py` 从字符串上看不出区别。
因此第二层分**两段**：

### 3.1 执行前：静态判定（`src/sandbox/command-scan.ts`）

纯函数，不碰进程：

```ts
scanCommand(command, cwd) -> {
  writeTargets: string[]      // 能解析出的写目标（绝对路径）
  outsidePaths: string[]      // 其中落在工作区之外的
  network: boolean            // 识别出联网迹象
  writeIntent: boolean        // 有写意图，但目标解析不出来
}
```

判定规则（**保守**，宁可漏判、不误判成"安全"）：

1. **重定向**：`>` `>>` `N>` `&>` `N>>` 之后的目标 token。`/dev/null`、`/dev/stdout`、
   `/dev/stderr`、`/dev/fd/*` 视为无副作用；`2>&1` 这类 fd 复制不是路径。
2. **已知写命令 + 路径参数**：`tee`、`sed -i`、`cp`/`mv`/`install`/`ln`/`rsync` 的目标位、
   `rm`/`rmdir`/`mkdir`/`touch`/`truncate`/`chmod`/`chown`/`patch`/`unzip` 的参数位。
   `sed`/`perl` **只在带 `-i` 时**才算写 —— 否则最常见的只读用法会变成每次都弹窗。
3. **输出选项**：`--output` / `--outfile` 这类无歧义长选项对所有命令通用；
   `-o` / `-O` / `-f` 按命令查表（`curl -o f` 是写文件，`ssh -o X` 不是）；
   `dd of=f` 走 `key=value` 形式。
4. **解释器**：`python`/`node`/`bun -e`/`perl`/`ruby`/`sh -c` … **且**代码里出现
   写信号（`writeFile`/`mkdir`/`shutil.`/`open(f,'w')` …）→ `writeIntent = true`。
   `open(f)` / `open(f,'r')` 是读，不算。

**刻意不做"全局关键词兜底扫描"**：那会让 `grep -rn "mkdir" src` 这种纯读命令
每次都弹窗（实测过，关键词出现在引号里是常态）。

**命中越界 → 执行前弹窗，命令根本不跑。** 拒绝或超时则**不执行**，把结论回传模型。

**`no-sandbox` 档不做事前拦截**：那一档的语义就是"默认批准一切、不再拦截"，
档位本身就是用户的预先授权。`builtin.ts` 据此传 `authorizeBeforeRun: false`。

### 3.2 批准后：本次 argv 真放开

`ShellRunOptions` 已经为网络开了这条路（`allowNetwork` 覆盖沙箱配置），写路径照抄：

```
ShellRunOptions.writablePaths?: readonly string[]   // 本次额外可写
buildSandboxArgv()  ->  为每个路径 push --bind <p> <p>
```

**绑定粒度**：bwrap 的 `--bind` 要求源路径已存在，而 `> /home/me/new.txt` 的目标往往不存在。
所以绑定的是**最近的已存在祖先目录**，并在弹窗里如实写明：

```
本次调用将允许写入 /home/me（含其中任意文件）
```

这是一次有意的放大：把「一个文件」放宽到「一个目录」，换来「批准后真的能写」。
只对这一次调用生效，且用户看得到范围。

三种情况分别放开什么：

| 情况 | 放开 |
| --- | --- |
| 解析出工作区外的写目标 | 这些目标各自的最近已存在祖先目录 |
| `read-only` 档写工作区内 | 工作区本身（`--bind cwd cwd` 盖掉那条只读判定） |
| 目标判不出来（`writeIntent`） | **只有命令明确提到 home 时**才放开 home；否则什么都不放开 |

最后一条是刻意的：判不出目标就"哪里都放开"是把授权变成猜谜。放开 home 的前提
是命令文本里出现了 `~` / `$HOME` / 真实的 home 路径 —— 那才是"它想写哪儿"的唯一依据。

`--bind` 的挂载顺序要紧：本次可写路径必须排在**工作区基础策略之后**，否则覆盖不掉它；
而工作区基础策略本身必须排在 `--tmpfs /tmp` 之后（见下一节）。

### 3.3 事后兜底仍然保留

静态判定是启发式，**必然有漏判**。漏判不等于放行：

- **写**：内核仍然把工作区外挂成只读 → `EROFS`。安全上没有任何退步（与改前一致）。
- **联网**：静态能识别的（`curl` / `git push` / `npm install` …）**执行前就问**；
  识别不出来的（解释器里的 socket 调用）保持「真跑一次 → 失败 → 拿着真实报错按次授权」
  这条兜底路径。

所以是**事前判定优先、事后兜底仍在**，不是二选一。

### 3.4 顺带修掉的坑：工作区在 `/tmp` 下时 read-only 档全军覆没

排查上面那条挂载顺序时发现的**既有 bug**（与本次改动无关，但被它放大了）：
`--tmpfs /tmp` 会把工作区遮掉，而 `read-only` 档此前**完全不绑工作区** ——
于是只要工作区落在 `/tmp` 下（临时 worktree、测试目录），`--chdir` 就找不到目录，
**每一条 bash 命令都失败**，连 `echo hello` 都跑不起来：

```
bwrap: Can't chdir to /tmp/xxx: No such file or directory
```

修法是：**无条件把工作区绑回来** —— 可写档绑成可写，只读档绑成**只读**
（`/` 本来就是只读的，这一步只是把被 tmpfs 遮掉的那份重新露出来）。
顺带的好处是 read-only 档批准写工作区时，那条按次 `--bind` 有东西可以覆盖。

---

## 4. 授权窗口：60 秒 + 倒计时

所有需要用户确认的入口共用同一个窗口（`src/permission/authorization.ts`）：

```ts
AUTHORIZATION_TIMEOUT_MS = 60_000
```

三态结果，**不再用 `boolean`**：

| 结果 | 含义 | 回传模型 |
| --- | --- | --- |
| `approved` | 用户在窗口内批准 | 继续执行 |
| `denied` | 用户明确拒绝 | `用户拒绝操作` |
| `timeout` | 60 秒内没有任何输入 | `授权已超时` |

- **超时 = 拒绝**（fail closed），不是默认批准。
- 弹窗在标题栏右侧显示倒计时：`需要授权 · 访问网络 · 还剩 47s`。
- 倒计时由 TUI 的帧调度每秒重绘一次；归零时弹窗自动关闭并 resolve `timeout`。
- CLI（`StdinPrompter`）同样受 60 秒约束：`node:readline` 没有内建超时，
  由 `withAuthorizationWindow()` 负责到点收口并关掉 readline。

覆盖的入口（三个）：

1. `prompter.ask()` —— 显式 `ask` 规则
2. `onEscalate()` —— 越出 `defaultApprove` 的按次授权
3. `onRequestCapability()` —— 能力授权（联网 / 写工作区外）

---

## 5. 模型看到什么

拒绝与超时必须**可区分**，否则模型无法决定「换一条路」还是「停下来问用户」：

```
用户拒绝操作：bash 未执行这条命令 —— echo hi > /home/me/x.txt
授权已超时（授权窗口内未收到确认）：bash 未执行这条命令 —— python3 -c "open('/home/me/x','w')"
```

超时文案**不带秒数**：窗口长度由实现方决定（TUI/CLI 可覆盖），闸门不知道具体是多少，
写死一个数字迟早会和真实配置对不上。

两种都是**否定结论**，模型不得重试同一条命令 —— 重试只会再弹一次窗。

---

## 6. 不可动摇的边界

1. **批准一次只生效一次。** 三个入口都**不改档位**。改档位只能由用户主动切换（`/mode`）。
2. **沙箱恒开。** 档位只决定「要不要问」，不决定「有没有隔离」。
3. **超时不等于批准。** 无人值守时必须停，不能替用户做决定。
4. **预算/审计不因此放宽。** 授权记录进审计（`GateDecision.granted` / `mode` / `outcome`）。

---

## 7. 已知取舍（诚实列出）

| 取舍 | 后果 | 为什么不换 |
| --- | --- | --- |
| 静态判定是启发式 | 漏判 → 仍是 `EROFS`；误判 → 多一次弹窗 | 唯一能做到「执行前」的机制；安全由内核兜底，不靠启发式 |
| 解释器 + 写信号就弹窗 | `python3 -c "…mkdir…"` 这种也会问 | 宁多问一次，也不静默失败；`open()` 不带模式已排除 |
| 批准后绑到祖先目录 | 一次调用内该目录整体可写 | `--bind` 要求源存在；范围写进弹窗，用户看得见 |
| `writeIntent` 只在提到 home 时放开 home | 命令写别处时批准了也仍会 `EROFS` | 判不出目标时放开范围只能靠依据，不能靠猜 |
| 联网只在静态识别得出时事前拦截 | `python -c` 里的请求仍要走一次失败 | 没有真实报错的「是否允许联网」用户没法判断 |
| `/tmp` 不算越界 | `echo x > /tmp/f` 免问 | 沙箱里 `/tmp` 是私有 tmpfs，写完就没了，拦它只是打扰 |
| `read-only` 档无条件绑工作区（只读） | 多一条 `--ro-bind` | 不绑的话工作区落在 `/tmp` 下会整个 chdir 失败（既有 bug） |
| 没有终端时立即拒绝 | `-p` / CI 下无人应答 | 等满 60 秒只是纯延迟，没人能批准 |

---

## 8. 落地对照

```text
src/permission/authorization.ts   60s 窗口 + 三态（新增）
src/permission/gate.ts            接三态；GateVerdict/GateDecision 增 refusal
src/permission/prompt.ts          CLI 走同一个窗口（readline 无内建超时）
src/sandbox/command-scan.ts       执行前越界/联网/写意图判定 + 批准范围规划（新增）
src/sandbox/bwrap.ts              本次额外可写路径 -> --bind
src/tools/bash.ts                 执行前判定 -> 弹窗 -> 按次放开；拒绝/超时回传
src/tools/types.ts                onRequestCapability 返回三态
src/tools/builtin.ts              把"工作区是否可写"传给 bash
src/core/loop.ts / runtime.ts     三态贯通
src/tui/app.ts                    三个弹窗共用 #authorize + 标题倒计时
src/index.ts                      BUGENT_AUTHORIZATION_TIMEOUT_MS（仅测试）
docs/permission-authorization-spec.md  本文
```

测试：

```text
tests/authorization.test.ts        14 例：三态 / 倒计时 / 无终端不干等
tests/command-scan.test.ts         45 例：越界 / 联网 / 反误报 / 绑定范围
tests/bash-authorization.test.ts   17 例：执行前拦、批准后真落盘、联网批准后真连上
tests/sandbox.test.ts              挂载顺序与 read-only 档的工作区存在性
tests/mode.test.ts                 事前拦截与事后兜底两条路径
tests/tui-pty.test.ts              PTY 端到端：倒计时弹窗、bash 越界弹窗
```
