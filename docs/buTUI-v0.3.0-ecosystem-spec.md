# buTUI v0.3.0 生态策略 Spec

> 状态：草案 · 待评审
> **建议落位：`buTUI/V0.3_ECOSYSTEM.md`**（本文由 bugent 侧产出，见文末说明）
> 前置：`buTUI/V0.3.md`（地基体检）、`buTUI/V0.3_HANDOFF.md`（M0–M3 完成情况）
> 外部依据：`bugent/docs/tui-port-matrix.md`（逐能力三方对照，实测 API 面）
> 定位：**给 v0.3.0 补一条 `V0.3.md` 没有的轴。** `V0.3.md` 问的是「我们写得对不对」；
> 本文问的是「这件事该不该我们写」。

---

## 0. 结论

1. **v0.3.0 尚未发布。** M0–M3 大部分完成（894 pass / 0 fail），工作区**未提交**
   （19 修改 + 9 新增），M4 工程化**全未做**，15 个包版本仍全为 `0.1.0`。
2. **`V0.3.md` 的既定方向不需要改。** §0「不做重写，不做 feature parity」、
   §0.2「迁移到 Node / 纯 TS ❌ 否决」、§4「把 Bun 的能力面吃干净」——与本文完全一致。
3. **本文补的是缺失的第三条轴：移植 vs 自研的判定政策。**
   接下来重心：**先补全已有生态，再自研；一切能力必须留在 Bun 侧，不得漂到 Node。**

---

## 1. 事实基础（全部实测，非文档声明）

### 1.1 v0.3.0 现状

| 项 | 状态 | 证据 |
| --- | --- | --- |
| `V0.3.md` | 待评审 | 文件头「状态：盘点结论 + 实施依据（待评审）」 |
| M0 基线固化 | ✅ 完成 | `scripts/bun-audit.ts` + `baseline-frame-bench.tsx` + `bench:*` 已接入 |
| M1 性能纠偏 | 🟡 §3.1/3.3/3.5 完成；§3.2 阻塞、§3.4 未做 | `V0.3_HANDOFF.md` §0.2 |
| M2 Bun 能力采纳 | 🟡 §4.1–4.4 完成；§4.5/4.6 未做 | `V0.3_HANDOFF.md` §0.3 |
| M3 可用性 | 🟡 §5.2 完成；**§5.1 最高严重度未做**、§5.3 未做 | `V0.3_HANDOFF.md` §0.4 |
| M4 工程化 | ❌ 全未做 | 见 §1.4 |
| 回归 | 894 pass / 0 fail，108 文件，12,004 断言 | `V0.3_HANDOFF.md` |
| API surface | 397 exports（v0.2 冻结 396 + `useCursorAnchor`） | 同上 |

### 1.2 生态普查：没有人在做「基于 Bun 原语的 TUI」

逐个安装后 grep `Bun.*` / `bun:*`（不是看 README 声明）：

| 包 | 上月下载 | `Bun.` 原语使用 | 架构 |
| --- | ---: | --- | --- |
| `@earendil-works/pi-tui` | 28,551,035 | **0** | 纯 TS + N-API（仅剪贴板） |
| `ink` | 24,042,359 | 0 | React + Yoga |
| `blessed` | 4,780,168 | 0 | 老 Node |
| `@opentui/core` | 3,082,743 | `bun:ffi` only | **Zig 105,827 行** + 8 平台二进制 |
| `@profullstack/hqtui` | 9,605 | 0 | 纯 TS，typed-array framebuffer |
| `@rezi-ui/core` | 18,205 | 0 | 纯 TS，声明 `engines.bun>=1.3.0` |
| `@cel-tui/core` | 97 | 0 | 纯 TS |

**buTUI 是唯一一个真正用 Bun 原语的。** 这个定位是独占的，值得守。

**但同时要认清：生态比我们认知的大得多。** pi-tui（28.5M/月）已经超过 ink；
维护者是 `mitsuhiko` / `badlogic` / `rwachtler`。它的 README 第一句几乎就是 buTUI 的定位：
"Minimal terminal UI framework with **differential rendering and synchronized output**"，
功能面（可互换渲染器、CSI 2026、bracketed paste、Kitty/iTerm2 图片、autocomplete）
逐条与 buTUI 重合。**它只有 2 个依赖，且不基于 Bun 原语。**

### 1.3 Bun 原语的天花板

枚举 `Bun` 的全部属性，终端/文本相关的 API：

**有** —— 格式化层（**7 个**）：`markdown` `stringWidth` `wrapAnsi` `sliceAnsi` `stripANSI` `color` `enableANSIColors`
**有** —— IO 层：`Terminal` `stdout` `stdin` `stderr` `write` `file` `Glob`
**有** —— 编码层：`Image` `deflateSync` `inflateSync` `gzipSync` `zstdCompress` `hash` `CryptoHasher` `escapeHTML`

**没有** —— 也就是 TUI 的**交互层全部**：
ANSI **parser**、布局、命中测试、焦点、键序列解析、终端能力探测、图片协议编码、
图像头部尺寸解析、OSC 11 响应解析、滚动视口、文本选择。

**量化**：`src/tui/ansi.ts` 139 行（吃 Bun）vs `pi-tui/utils.js` 1203 行（自己写）——**8.6 倍**。

> **推论：「尽可能吃包子」只覆盖格式化层。** 交互层必须移植或自研，没有第三条路。
> 这正是本文存在的理由。

### 1.4 两个 MIT 上游的可用性

| 包 | License | 版本 | 纯 JS 行数 | `node:` 依赖 |
| --- | --- | --- | ---: | --- |
| `@earendil-works/pi-tui` | **MIT** | 0.87.1 | 15,097 | `path` `url` `os` `module` `fs` |
| `@profullstack/hqtui` | **MIT**（带 LICENSE 文件） | 0.7.0 | 14,087 | `fs/promises` `os` |

**`node:` 依赖共 7 个模块，Bun 全部原生支持。零摩擦。**
没有 `node-pty`、没有 `sharp`、没有必需的原生插件。

### 1.5 M4 工程化现状（实测）

| 项 | 状态 |
| --- | --- |
| `LICENSE` / `COPYING` | ❌ **完全不存在** |
| 根 `package.json` 的 `license` 字段 | ❌ 无 |
| 15 个包的 `license` 字段 | ❌ 全空 |
| `.github/`（CI） | ❌ 无 |
| lint / format 配置 | ❌ 无 |
| 构建产物（`dist` + `exports`） | ❌ 无 |
| `CHANGELOG` | ❌ 无 |
| 包版本号 | ❌ 15 包全为 `0.1.0` |

**这里有一个硬阻塞，必须点名：**

> **移植任何 MIT 代码之前，本仓库必须先有 LICENSE。**
> 没有本仓库的许可声明，就无法正确声明衍生关系，也不能发布。
> `V0.3.md` §6 把 LICENSE 列在 M4，但 M4 的优先级被排在 M1–M3 之后 —— **本文建议提前**。

---

## 2. 政策：三层判定

### 2.1 判定树

```
这个能力 Bun 提供吗？
├─ 提供
│   → 用 Bun。门禁：bun-audit --check 必须通过。
│
└─ 不提供
    ├─ 属于「正确性沼泽」？
    │   → 移植（vendor）。这些是最不该手写的一层。
    │
    ├─ 属于本项目的架构决策？
    │   → 自研。这是 buTUI 存在的理由。
    │
    └─ 通用工具（编辑器 / 图片协议 / LaTeX / 列表）？
        → 评估后移植；不达标则不引入，不做 feature parity。
```

### 2.2 「正确性沼泽」——默认移植，不自研

判定标准：**规格明确、边界情况多、单测发现不了、写错了很难查**。

| 能力 | 来源 | 为什么不该自研 |
| --- | --- | --- |
| ANSI 序列解析（某列当前的 SGR 状态） | `pi-tui/utils.js`：`extractAnsiCode` `getActiveBackgroundAnsi` `extractSegments` | Bun 只有 strip/slice/wrap，**没有 parse** |
| 键序列解析（Kitty protocol / release / repeat / Apple 归一化） | `pi-tui/keys.js` | 1173 行 vs 本地 289 行；终端差异是沼泽 |
| 控制符 / Bidi / 孤立代理项过滤 | `hqtui/unicode.js`：`isControl` `isBidiControl` `isLoneSurrogate` `isUnsafeCodepoint` | **安全项**，见 §2.5 |
| 色彩深度探测 + cell 像素尺寸 | `pi-tui` `getCellDimensions` / `hqtui` `cellSizeFromEnv` `queryCellSize` | 探测顺序与终端差异是沼泽 |
| 图像头部尺寸解析（PNG/JPEG/GIF/WebP） | `pi-tui` | 纯解析，规格明确 |
| 颜色插值（`blend` `alpha` `mix` `gradient`） | `hqtui/color.js` | **Bun 只给格式转换，不给插值** |
| 图片协议编码（Kitty / iTerm2） | `pi-tui/terminal-image.js` | 协议细节多，纯函数 |

### 2.3 「必须自研」——不得移植

| 能力 | 理由 |
| --- | --- |
| 布局（`layout()` / `measureNode` / 脏子树） | `V0.3.md` §3.2 的核心；形态与任何上游都不同 |
| 渲染循环 / 帧调度（`FrameClock` / `AdaptiveQuality`） | v0.2 已 API 冻结，三方最成熟 |
| 流式路径（`StreamEnvelope` / smooth / retention） | `V0.2.md` §3.5 P0-3/P0-4 的定义性能力 |
| 命中测试（`Cell.node` + 语义 hit test） | `SPEC.md` §4.2 的定义性能力 |
| 事件协议 / 可重放状态 | `SPEC.md` §2.2；终端与 WebUI 共用状态 |
| 插件 / Keymap / Slot | 上游没有等价物 |

### 2.4 明确不引入

| 项 | 理由 |
| --- | --- |
| `node-pty` | 与「零原生二进制」冲突；`Bun.Terminal` 已覆盖 |
| `sharp` | 同上；`Bun.Image` 已覆盖（缺 raw pixel 出口，见 §4.1） |
| 任何 N-API / node-gyp / prebuild 二进制 | 决定平台矩阵；参考 bugent 的 `scripts/package-platform.ts` 已经为此关掉 Windows/macOS 沙箱能力 |
| React + Yoga | 会背上 reconciler + WASM 渲染器；与 Solid 2 RC 路线冲突 |
| 全量 Rust / Zig 重写 | `V0.3.md` §0.2 已否决（瓶颈是冗余计算，不是语言） |
| 组件树形态的上游（`TuiMainScreen` / `Box` / `Stack` / `ScrollView`） | 形态冲突，移植等于换架构 |
| Emoji 子系统（hqtui 20+ 导出） | 体量大、niche，非目标 |

### 2.5 安全项必须优先（不是「按需」）

本仓库目前**对控制符 / Bidi 完全不过滤**。而 buTUI 会把模型输出、工具输出、
文件内容原样送进终端。`user<RLO>nimda` 在日志面板里显示成 `user admin` ——
Trojan Source（CVE-2021-42574）在 TUI 里是**渲染层的真实注入面**，不是理论问题。

`hqtui/unicode.js` 的修法是现成的 MIT 纯函数。**这一项应排在 M5 的第一位。**

---

## 3. 硬约束：紧扣 Bun，不漂到 Node

### 3.1 `node:` 白名单

**允许**（Bun 原生实现，零成本）：

```
node:path  node:url  node:os  node:module  node:fs  node:fs/promises
node:crypto  node:util  node:events  node:stream  node:assert  node:buffer
```

**禁止**：

- `node-pty` / `node-gyp` / `node-pre-gyp` / `prebuild` / `bindings`
- 任何 `.node` / `.so` / `.dylib` / `.dll` 二进制依赖
- `node:child_process` 里绕过 `Bun.spawn` 的用法（除兼容性 shim）
- 以「Node 也能跑」为目标的兼容分支（`process.versions.node` 判断、`isBun` 回退）

**边界情况**（需在评审中明确，不得默认放行）：

- `process.env` / `process.stdout` / `process.argv` —— 允许（Bun 也实现），
  但 `process.stdout` 的写路径应优先用 `Bun.stdout.writer()`（`V0.3.md` §3.4）
- `Intl.Segmenter` —— 允许，但只作复杂序列回退，快路径走 `Bun.stringWidth`（§3.1 已完成）
- `import { X } from "bun"` —— 允许且**优先于** `Bun.X`

### 3.2 可执行门禁：扩展 `bun-audit.ts`

`scripts/bun-audit.ts` 现在只做一件事：从 `bun-types` 提取 API 清单、扫描使用、
与 `HAND_ROLLED_EXCEPTIONS` diff。**它检查的是「Bun 提供了但我们没用」。**
补两个正交的检查：

| 新模式 | 作用 | 失败条件 |
| --- | --- | --- |
| `--node-drift` | 扫全部 `from "node:*"` / `require("node:*")` | 命中 §3.1 白名单之外 |
| `--native` | 扫 `.node` / `node-gyp` / `prebuild` / `bindings` 引用与 `*.node` 文件 | 命中任意一条 |
| `VENDOR_MANIFEST`（与 `HAND_ROLLED_EXCEPTIONS` 同构） | 登记移植来源 | 「有 vendor 文件但未登记」或「登记的上游版本已过期」 |

建议把三者一起挂进 `bun run check`：

```
check = typecheck && test && api:check && audit:bun:check && audit:node-drift && audit:vendor:check
```

### 3.3 为什么这是硬约束而不是偏好

1. **保住 Bun 原语。** `V0.3.md` §0.2 已否决 Node 迁移，理由是「会失去
   `Bun.stringWidth` / `wrapAnsi` / `sliceAnsi` / `Bun.Terminal` / `Bun.Image`」。
   漂移是渐进的，不是一次决定——门禁是唯一能防住渐进的方式。
2. **保住零原生二进制。** 这直接决定平台矩阵。一旦引入一个 `.node`，
   Windows/macOS/Linux × x64/arm64 × glibc/musl 的组合就会爆炸。
3. **保住独占定位。** §1.2 已证明「基于 Bun 原语的 TUI」是空的，
   而这是 buTUI 相对于 pi-tui / opentui / ink 唯一的不可替代性。

---

## 4. 移植纪律

### 4.1 前置条件（硬阻塞）

- [ ] **本仓库 LICENSE 存在**（当前完全没有）
- [ ] 根 `package.json` 与 15 个包补 `license` 字段
- [ ] 选定许可（建议 MIT，与两个上游一致，避免兼容性讨论）

**在这三项完成前，不得移植任何第三方代码。**

### 4.2 目录与标注

```
src/vendor/
  README.md            # 来源、版本、上游地址、改动理由、许可
  pi-tui/ansi-parse.ts # 文件头见下
  hqtui/unicode.ts
```

每个文件头必须写：

```ts
// ported from @earendil-works/pi-tui@0.87.1 (MIT) — dist/utils.js
// 改动：只保留纯函数；去掉 Buffer 依赖，改 Uint8Array；补 TS 类型
// 上游：https://github.com/earendil-works/pi
```

### 4.3 只移植纯函数

有状态的（`TuiAltScreen`、`Editor`、`FrameBuffer`、`Surface`）一律不搬 —— 那是架构，不是工具。
**移植边界 = 函数签名不依赖上游的节点树 / 生命周期 / 全局单例。**

### 4.4 写自己的测试

上游测试依赖它们的测试框架和内部结构。本仓库已有 894 个用例的基础设施，
按本地风格钉住移植来的函数（尤其是边界：宽字符、组合字符、孤立代理项、超长输入）。

### 4.5 升级流程

两个上游都还在活跃发版（pi-tui 一周前还在发）。升级时必须：
1. 更新 `VENDOR_MANIFEST` 里的版本号
2. 记录 diff 摘要（改了什么、为什么）
3. 重跑本地测试

否则半年后没人知道哪些行是改过的。

---

## 5. 对 v0.3.0 里程碑的修订建议

| 里程碑 | 现状 | 建议 |
| --- | --- | --- |
| M0 基线固化 | ✅ | 保持 |
| M1 性能纠偏 | 🟡 §3.2 阻塞、§3.4 未做 | 保持 |
| M2 Bun 能力采纳 | 🟡 §4.5/4.6 未做 | 保持 |
| M3 可用性 | 🟡 **§5.1 最高严重度未做** | 保持最高优先级，不动 |
| M4 工程化 | ❌ 全未做 | **提前 LICENSE + 版本号对齐**（§4.1 的硬阻塞） |
| **M5 生态补全（新增）** | — | 见下 |

### M5 生态补全（新增）

**P0 —— 补真实缺口**

| 项 | 来源 | 理由 |
| --- | --- | --- |
| 控制符 / Bidi / 孤立代理项过滤 | hqtui `unicode.js` | **安全项**，见 §2.5 |
| ANSI 序列解析 | pi-tui `utils.js` | Bun 没有 parser；合成/染色带的硬前提 |
| 颜色插值 `blend`/`alpha`/`mix`/`gradient` | hqtui `color.js` | Bun 只给格式转换 |

**P1 —— 功能缺口**

| 项 | 来源 |
| --- | --- |
| 键序列解析全套 | pi-tui `keys.js` |
| 色彩深度探测 + `getCellDimensions` / `cellSizeFromEnv` | pi-tui / hqtui |
| 图像头部尺寸解析 | pi-tui |
| Kitty / iTerm2 编码 | pi-tui `terminal-image.js` |

**P2 —— 按需**

`BrailleCanvas` / `HALF_BLOCKS` / `drawCanvas` / `plot`（hqtui `graphics/`）、
`Editor` + `kill-ring` + `undo-stack` + `word-navigation` + `autocomplete`（pi-tui）、
`renderLatex`（pi-tui）、`clipboardSequence`（hqtui）。

---

## 6. 验收标准（v0.3.0 增补）

### 6.1 硬性门禁

- [ ] `bun run audit:bun:check` 通过（已有）
- [ ] `bun run audit:node-drift` 通过（**新增**，§3.2）
- [ ] `bun run audit:vendor:check` 通过（**新增**，§3.2）
- [ ] `LICENSE` 存在，且与所有 vendor 来源许可兼容
- [ ] 15 个包版本号已对齐（当前全为 `0.1.0`）

### 6.2 非目标（重申 `V0.3.md` §9 并补充）

- 不做 ratatui / ink / OpenTUI 的 feature parity
- 不引入任何原生二进制、React/Yoga、WASM 渲染器
- **不为「自研率」自研** —— 能移植的正确性沼泽不自研，能吃的包子不手写

---

## 7. 待确认

1. **许可证选型**：MIT 与两个上游一致，是否接受？（影响 §4.1 的阻塞解除时间）
2. **`--node-drift` 白名单**：§3.1 的 12 个模块是否够？`node:child_process` 如何界定？
3. **M4 提前的范围**：只提前 LICENSE + 版本号，还是整个 M4 一起前移？
4. **M5 是否并入 0.3.0**：P0 三项约 400–500 行纯函数 + 测试，会推迟发布；是否拆到 0.3.1？
5. **`VENDOR_MANIFEST` 的过期判定**：按上游发版时间、还是按 semver minor/major？

---

## 附：本文的产出位置

本文由 bugent 侧的 agent 产出，**建议移动到 `buTUI/V0.3_ECOSYSTEM.md`**，
与 `V0.3.md` / `V0.3_HANDOFF.md` 同级。

产出时的写边界限制：agent 的工具层只允许写 `bugent/` 工作区，因此落在
`bugent/docs/buTUI-v0.3.0-ecosystem-spec.md`。移动命令：

```bash
mv docs/buTUI-v0.3.0-ecosystem-spec.md ../buTUI/V0.3_ECOSYSTEM.md
```
