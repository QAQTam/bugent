# `bash` → `exec` 工具改造设计

状态：提案（未实现）

## 1. 目标

- 工具改名 `bash` → `exec`，参数只有 `command`（必选）、`shell`（可选）、`timeoutMs`（沿用）。
- 工具描述与 schema **不透露默认 shell 是什么**——模型第一次跑错语法、从报错里自己认出 shell（"碰壁学习"）。
- shell 解析优先级：
  - Linux：`bash > zsh > fish > sh > pwsh`
  - Windows：`pwsh > powershell 5.1 > bash > cmd`
- 用户可用配置文件或环境变量显式钉死 shell。

## 2. 类型与解析管线

```ts
type ShellKind = "posix" | "fish" | "pwsh" | "powershell" | "cmd";

interface ShellCandidate {
  path: string;     // 可执行文件
  kind: ShellKind;  // 决定 argv 模式
  origin: "config" | "env" | "param" | "auto";
}
```

解析顺序（结果按进程缓存）：

```
config 里钉死的 shell  →  BUGENT_SHELL  →  per-call shell 参数  →  平台自动探测链
```

- **config/env 压过 per-call**：用户显式钉死的意图不能被模型覆盖。
  此时模型传 `shell` 参数返回明确报错（"user pinned the shell"）——这本身就是一面墙，模型能学到原因。
- 自动探测链每个候选用 `Bun.which()` 或显式路径探测，**逐个验证，取第一个活的**。
- Windows 链以 `cmd.exe` 收尾（System32 恒在），所以 Windows 上解析**永不失败**；Linux 以 `/bin/sh` 收尾，维持现有"不抛错"语义。

## 3. argv 模式（核心改动点）

现在 `createShellRunner` 和 `buildSandboxArgv` 两处硬编码 `[shell, "-lc", cmd]`，
而 `-lc` 只对 bash/zsh/sh 成立。改成按 `ShellKind` 映射：

| kind | argv |
| --- | --- |
| posix | `[shell, "-l", "-c", cmd]`（拆开写，dash 也认） |
| fish | `[shell, "-c", cmd]`（fish 不支持组合短标志；且不需要 login shell 读配置） |
| pwsh / powershell | `[shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", b64(cmd)]` |
| cmd | `[shell, "/d", "/s", "/c", cmd]` |

**PowerShell 用 `-EncodedCommand`（UTF-16LE base64）是关键决定**：`-Command`
直接传字符串时，PowerShell 的引号剥离规则和 CreateProcess 的引号规则互相作用，
嵌套引号/`$` 变量极易碎；base64 编码让命令字节级保真，彻底绕开 quoting 问题。
TUI 展示的仍是模型输入的原文（presentation 从 input 取，不从 argv 取）。

## 4. Windows 下 pwsh 的路径问题（本设计的重点）

pwsh 在 Windows 上有至少四类落点：

| 来源 | 路径 | 特征 |
| --- | --- | --- |
| MSI（机器级） | `%ProgramFiles%\PowerShell\7\pwsh.exe`（及 `7-preview`、x86 变体） | 会加 PATH，是真 exe（>100KB） |
| Scoop / Chocolatey / winget portable | 各自 shim 目录，均在 PATH 上 | `which("pwsh")` 能找到，shim 转发到真 exe |
| **MSIX / 商店** | `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` | **0 字节 reparse point（appexec link）**，不是真文件 |
|DotNet global tool 等边缘 | PATH 上 | 同 portable |

### 4.1 问题本质

`WindowsApps\pwsh.exe` 这个"文件"：

1. **大小为 0 字节**——`fs.stat` 看不出它能不能跑；
2. 用户可以在 设置 → 应用 → 高级应用设置 → **应用执行别名** 里把它关掉。
   关掉后 reparse point 还在，但 `CreateProcess` 会失败；
3. 所以"`which()` 找到了"≠"能跑"，必须验证。

### 4.2 候选收集与验证策略

```
candidates（去重后按序）:
  1. Bun.which("pwsh")            // 覆盖 MSI-on-PATH、scoop、choco、portable
  2. %ProgramFiles%\PowerShell\7\pwsh.exe
     %ProgramFiles%\PowerShell\7-preview\pwsh.exe
     %ProgramFiles(x86)%\PowerShell\7\pwsh.exe
  3. %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe   // MSIX 别名，放最后
```

验证分两层，从便宜到贵：

1. **stat 粗筛**：真 pwsh.exe 体积 >100KB；0 字节 ⇒ 它是 MSIX 别名（关没关不知道，
   但能确定不是普通 exe）。这一步**只做分类，不做淘汰**——别名放行进入第二层。
2. **spawn 探活**（仅对 0 字节候选）：`pwsh -NoProfile -NonInteractive -EncodedCommand <b64("exit 0")>`，
   2 秒超时。成功 ⇒ 可用；失败（别名被关、MSIX 处于 staged 态等）⇒ 划掉，
   落到下一个候选（PowerShell 5.1）。**结果按路径缓存，进程内只探一次。**

要点：

- `which("pwsh")` 命中的也可能是 WindowsApps 别名（商店版装了又没别的安装时，
  别名目录常被加进 PATH）——所以验证按"文件是不是 0 字节"统一判断，
  **不按路径特判**。
- 探活只在自动探测链走到 MSIX 候选时发生，正常 MSI 用户零开销。
- 探活失败不抛错，静默滑向 PowerShell 5.1：
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
  ——这个路径是确定性的，只需 `exists`，同样支持 `-EncodedCommand`（PS 2.0+ 就有）。
- 用户在 config/env 里显式钉死 MSIX 别名路径时不做探活拦截，跑失败时把
  CreateProcess 的真实报错回给模型/用户（与"按次授权拿真实报错"同一哲学）。

### 4.3 为什么 MSIX 放最后而不是禁掉

商店版 pwsh 本身完全可用（spawn 别名后跑的就是真 7.x，工作目录、stdin/stdout
管道都正常）。它只是**失败模式更多**（别名开关、staged 态）。排序把"必活的"
MSI/PATH 装法放前面，别名做兜底 + 探活把关，兼顾覆盖面和确定性。

## 5. bash / cmd（Windows 链后两位）

- bash：Windows 上有两个 bash，处理不同：
  - **WSL bash**：`System32\bash.exe` 是 WSL 入口，跑进去就是另一套文件系统，
    `isWslLauncher()` 识别路径并跳过——沿用现有逻辑。
  - **Git for Windows bash**：`which("bash")` 命中（Git 装机通常加了 PATH）；
    没命中时显式探测 `%ProgramFiles%\Git\bin\bash.exe` 与
    `%ProgramFiles(x86)%\Git\bin\bash.exe`。走 argv 模式 `posix`。
- cmd：`%SystemRoot%\System32\cmd.exe`，恒存在，解析链的兜底。
  注意 `cmd /c` 的返回码语义（`errorlevel`）与 POSIX 一致地透传即可。

## 6. Linux 链

`bash > zsh > fish > sh > pwsh`，全部 `which()` 探测，无 reparse 问题，不需要
spawn 探活。fish 用 `fish -c`。pwsh 在 Linux 是 MSIX 无关的普通二进制，
走 argv 模式 `pwsh`。

## 7. 工具定义

```jsonc
// 给模型看到的 schema（刻意不解释 shell 语义）
{
  "command":  { "type": "string", "description": "Command to run in the workspace root." },
  "shell":    { "type": "string" },   // 可选；名称或绝对路径
  "timeoutMs": { "type": "number" }
}
```

- description 保持中性的 "Run a command in the workspace and return its output."。
- per-call `shell` 的解析复用同一条管线（origin = "param"）：接受 shell 名
  （经候选表 + which）或绝对路径；解析失败回报错误——又是一面墙。
- 只读扫描（`command-scan.ts` / `bashResourceClaims`）**本阶段不改**：它对
  POSIX 语法的假设在 PowerShell 下仍大体成立（`$()`、`>`、`|`），不确定时
  一律给写锁，本来就保守；Windows 无内核沙箱、靠逐条询问兜底。 pwsh 反引号
  转义、cmd 的 `&` 分隔属已知盲区，在 `command-scan.ts` 注释里文档化。

## 8. 波及面与迁移

| 位置 | 改动 |
| --- | --- |
| `src/tools/bash.ts` | `resolveShell` 重写为异步 + 候选验证；argv 映射；tool 改名 `exec` |
| `src/sandbox/bwrap.ts` | `buildSandboxArgv` 接受 `ShellCandidate`，去掉硬编码 `-lc` |
| `src/tools/builtin.ts` | 启动时 await 解析；note 文案改中性 |
| `src/config/schema.ts` + `bugent.config.example.ts` | 新增 `agent.shell` |
| `src/permission/*`、`src/config/toml.ts` | 规则匹配时 `"bash"` → `"exec"` 别名映射，老配置不炸 |
| `src/prompts/system.md` | 第 33/63 行 `bash` 字样改中性（否则泄漏） |
| `src/tui/renderers-builtin.ts`、`presentation.ts` | 注册名/kind 加 `exec`（`bash` 保留做会话回放兼容） |
| `tests/bash.test.ts` 等 | 现有测试用注入 `which` 的写法，直接扩展；探活逻辑注入 stat/spawn 做矩阵测试（别名开/关、仅 5.1、仅 cmd） |

## 9. 开放问题

1. **优先级已定**：config/env > per-call > 自动。若希望模型能临时换 shell（用户
   未钉死时），维持此序即可；要不要允许 config 里写 `allowModelOverride: true`
   反转，留待实现时定。
2. posix 模式是否保留 `-l`（login）：现状带 `-l`；fish 不带。改动最小化考虑，
   bash/zsh/sh 维持 `-l -c`。
3. `exec` 是否在第一版就支持 per-call `shell`，还是先只做默认链（字段先占位、
   传入即报错）——建议一次做完，探活代码横竖要写。
