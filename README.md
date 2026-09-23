一个最大化利用bun最新版API的AI AGENT.
小目标：bun最新版+ts 7+TUI+WEBUI
Phase 1. 确立以多provider 多endpoint的架构设计，第一阶段直接隔离agentloop不知道endpoint类型的设计
Phase 2. 确立loop的上下文注入由message（msgid）标记，msgid0为systemprompt,此后按照上下文注入顺序依次排序，确保缓存命中优先（做足测试）
Phase 3. 新增bash工具
Phase 4. 完成最小loop
Phase 5. 设计config布局以及TUI设计，用bun自己的terminal api实现更合适。或者引入Ink：无论如何都要确保O（1）性能优化。做足测试
Phase 6. 开始设计权限管理和沙箱，首轮应该测试Linux下沙箱设计
Phase 7. 拓展write_file read_file edit_file工具
Phase 8. tui支持渲染markdown和代码高亮
Phase 9. 支持多session并行对话，先做一个实例一个新对话，考虑并发锁问题
Phase 10. 消息落盘，进行第一轮安全审计。

---

## 快速开始

```bash
bun install

# 无需网络与密钥，验证链路
bun run src/index.ts --mock -p "你好"

# 接真实模型
export OPENAI_API_KEY=sk-xxx
bun run src/index.ts -p "写个 hello world"

# 交互式（自动进入 TUI，需要 TTY）
bun run src/index.ts

# 纯文本 REPL（不走 TUI）
bun run src/index.ts --plain

# 权限与沙箱
bun run src/index.ts --yes            # 跳过所有权限确认（危险）
bun run src/index.ts --no-sandbox     # 关闭 bwrap 沙箱
bun run src/index.ts --allow-network  # 沙箱内允许联网（默认断网）

# 会话持久化（默认写入 ./.bugent/bugent.db）
bun run src/index.ts --sessions       # 列出已保存的会话
bun run src/index.ts --resume <id>    # 恢复会话继续聊
bun run src/index.ts --no-persist     # 不落盘
```

TUI 内可用 `/new` 开一个全新对话（原会话仍在库里，之后可用 `--resume` 回去）。

# 测试与类型检查
bun test
bun run typecheck
```

配置：复制 `bugent.config.example.ts` 为 `bugent.config.ts`；不建配置文件时走环境变量
（`BUGENT_API_KEY` / `OPENAI_API_KEY`、`BUGENT_BASE_URL`、`BUGENT_MODEL`）。

## 当前进度

| Phase | 状态 | 说明 |
| --- | --- | --- |
| P1 多 provider / endpoint 架构 | ✅ | `src/provider/types.ts` 归一化协议；loop 层零 provider 依赖（有验收 grep） |
| P2 msgid 上下文与缓存前缀 | ✅ | msgid0 不可变、只追加、前缀指纹 + 逐字节稳定性测试 |
| P3 bash 工具 | ✅ | 管道执行（非 PTY），超时/中断/输出截断；执行层抽象为 `ShellRunner`，P6 沙箱直接替换 |
| P4 最小 loop | ✅ | `src/core/loop.ts`，含工具往返、maxSteps 防死循环 |
| P5 config + TUI | ✅ | config 可用；TUI 基于 **Bun 原生能力**自研（差分渲染 + raw mode，零第三方依赖） |
| P6 权限与沙箱 | ✅ | allow/ask/deny 三级策略；bwrap 沙箱（只读根 / 可写 cwd / 默认断网）；TUI 弹窗确认 |
| P7 文件工具 | ✅ | read_file / write_file / edit_file；路径约束挡住 `../` 与符号链接逃逸；写入是原子的 |
| P8 markdown / 高亮 | ✅ | `Bun.markdown.ansi` + `Bun.wrapAnsi` + `Bun.stringWidth`（代码高亮限 ts/js） |
| P9 多 session | ✅ | `SessionRegistry` + 并发锁：不同会话真并行，同一会话重复进入抛 `SessionBusyError`；TUI `/new` 开新对话；多进程共写同一库已回归测试 |
| P10 落盘与审计 | ✅ | bun:sqlite + WAL；消息即时落盘、`--resume` 恢复；审计流水含工具调用与权限决策 |

已实现：`openai-chat` adapter（覆盖 OpenAI 及所有兼容端点）、`mock` adapter。
待实现：`openai-responses`、`anthropic-messages`。

## 工具集

| 工具 | 说明 | 沙箱 |
| --- | --- | --- |
| `bash` | 执行 shell 命令，支持超时/中断/输出截断 | bwrap（只读根 / 可写 cwd / 默认断网） |
| `read_file` | 读文件，带行号，支持 `offset`/`limit` | 路径约束 |
| `write_file` | 原子写（临时文件 + rename），自动建父目录 | 路径约束 |
| `edit_file` | 精确字符串替换，不唯一时报错而非猜测 | 路径约束 |
| `todo_write` | 待办清单，前端以 sticky checkbox 面板实时显示 | 无副作用，默认放行 |

`todo_write` 的三态用**纯 ASCII 等宽标记**渲染，避免花体字符在不同终端里宽度不一致：

```
待办 2/4 · 进行中 1
  [x] 读 src/core/loop.ts
  [x] 重构 Transcript
  [>] 正在补单测
  [ ] 跑 typecheck
```

## 加一个新工具要改什么

普通工具（无状态、无需自定义外观）：**1 个新文件 + `builtin.ts` 加 1 行**。

core / provider / TUI / 权限 / 存储 / 沙箱全都不用动 —— 可以用
`grep -rn '"bash"' src/` 验证：工具名在 `src/` 里零硬编码。

工具可以自报两件事，避免去改公共模块：

| 声明 | 作用 |
| --- | --- |
| `describe(input)` | **必填**。告诉权限系统这次动的是什么资源（bash 报命令、文件工具报路径），否则用户的 `{tool, resource}` 规则永远匹配不上 |
| `needsSandbox` | 标记需要沙箱；组装时会检查并明确告知"哪些工具在裸奔" |
| `defaultPermission` | 自报默认权限（如 `todo_write` 无副作用 → `allow`）；**用户显式规则优先级更高** |

需要自定义外观的工具（像 `todo_write`）额外在 `src/tui/renderers-builtin.ts`
注册一个 renderer；TUI 核心依然不认识任何工具名。

> ⚠️ 组装权限策略时记得带上工具自报的规则，否则"无副作用工具自动放行"会失效：
> ```ts
> new PermissionPolicy(composePolicy(config.permissions, setup.defaultPermissionRules))
> ```

## 开发辅助

```bash
# 把 TUI 输出流还原成"最终整屏"，调试差分渲染用
# （差分渲染只重写变化的行，直接看输出是一堆碎片，看不出屏幕最终长什么样）
bun run scripts/replay-ansi.ts <捕获文件> [行数] [列数]
```

完整方案见 [PLAN.md](./PLAN.md)。