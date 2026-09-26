# TUI 移植对照矩阵

> 状态：决策依据 · 未经评审
> 目的：判断 `src/tui` 哪些能力该吃 Bun 原语、哪些该从 MIT 上游移植、哪些该自研
> 数据来源：实际安装后导出 API 面（非 README 声明）

## 0. 对照对象与规模

| 来源 | 版本 | License | 模块 | 唯一导出 | 纯 JS 行数 | `node:` 依赖 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `@earendil-works/pi-tui` | 0.87.1 | MIT | 41 | 130 | 15,097 | `path` `url` `os` `module` `fs` |
| `@profullstack/hqtui` | 0.7.0 | MIT | 44 | 265 | 14,087 | `fs/promises` `os` |
| `src/tui`（本仓库） | — | — | 36 | 261 | 11,318 | `fs` `os` `path` `crypto` |

两个上游都是 MIT，`node:` 依赖共 7 个模块，**Bun 全部原生支持**。移植到 Bun-only 无摩擦。

上游活跃度（实测 npm）：
- pi-tui：49 个版本，最后发布 2026-09-22，上月下载 28,551,035
- hqtui：23 个版本，最后发布 2026-09-24，上月下载 9,605

## 1. Bun 原语的天花板

`Bun` 上与终端/文本相关的**全部** API（枚举 `Bun` 属性得到）：

**有** —— 格式化层：`markdown` `stringWidth` `wrapAnsi` `sliceAnsi` `stripANSI` `color` `enableANSIColors`
**有** —— IO 层：`Terminal` `stdout` `stdin` `stderr` `write` `file` `Glob`
**有** —— 编码层：`Image` `deflateSync` `inflateSync` `gzipSync` `zstdCompress` `hash` `CryptoHasher` `escapeHTML`

**没有** —— 也就是 TUI 的交互层全部：
ANSI **parser**、布局、命中测试、焦点、键序列解析、终端能力探测、图片协议编码、图像头部尺寸解析、OSC 11 响应解析、滚动视口、文本选择。

**量化**：`src/tui/ansi.ts` = 139 行（吃 Bun）；`pi-tui/utils.js` = 1203 行（自己写）。**8.6 倍**，差额就是 Bun 不给的部分。

结论：**「尽可能吃包子」只覆盖格式化层**，交互层必须移植或自研。

## 2. 逐能力对照

图例：`✅ 领先` `🟡 可用` `❌ 缺` `— 不适用`

### 2.1 ANSI 解析 / 宽度 / 切片

| | pi-tui | hqtui | src/tui |
| --- | --- | --- | --- |
| 规模 | 17 个导出 | 19 个导出 | 17 个导出 |
| 可见宽度 | `visibleWidth` | `stringWidth` `charWidth` `cellWidth` `clusterWidth` `emojiWidth` `spanWidth` | `visibleWidth`（走 `Bun.stringWidth`）✅ |
| 截断 | `truncateToWidth` | `truncate` `truncateSpans` | `truncateAnsi`（保证不超宽，含宽字符修正）✅ |
| 折行 | `wrapTextWithAnsi` `wordWrapLine` | `wrap` `wrapRich` `wrapSpans` | `wrapToLines`（走 `Bun.wrapAnsi`）✅ |
| 按列切片 | `sliceByColumn` `sliceWithWidth` | — | — ❌ |
| **ANSI 解析** | **`extractAnsiCode` `getActiveBackgroundAnsi` `extractSegments` `applyBackgroundToLine`** | `stripAnsi` `stripUnsafe` | — ❌ |
| 单元格范围 | `getGraphemeCellRange` `getGraphemeSegmenter` `getWordSegmenter` | `graphemes` `clusterText` | — ❌ |
| OSC 8 超链接 | `getOsc8LinkAtColumn` `hyperlink` | — | — ❌ |

**结论：移植 `pi-tui/utils.js`。** `extractAnsiCode` + `getActiveBackgroundAnsi` 是「知道某列当前 SGR 状态」的唯一来源，也是做染色带/浮层合成的硬前提。`getGraphemeCellRange` + `applyBackgroundToLine` 直接对应波纹染色带。

### 2.2 颜色 / 主题 / 深度

| | pi-tui | hqtui | src/tui |
| --- | --- | --- | --- |
| 规模 | 3 | 25 | 10 |
| 格式转换 | — | `rgb` `hex` `to16` `to256` `from256` `ansi256` `fg256` `bg256` | `fg`/`bg(color, depth)` 走 `Bun.color` ✅ |
| **插值/混合** | — | **`blend` `alpha` `mix` `gradient` `gradientSteps`** | — ❌ |
| 感知量 | — | `luminance` `contrast` `darken` `lighten` `SHADES` `heatColor` `shadeGlyph` | `perceivedLuminance` 🟡 |
| 主题系统 | — | `themes` `themeList` `defineTheme` `resolveTheme` | `darkTheme` `applyTheme` `buttonPalette` `tonePalette` 🟡 |
| 底色探测 | `parseOsc11BackgroundColor` `parseTerminalColorSchemeReport` | — | `detectTerminalBackground` `parseOsc11Reply` `backgroundFromColorFgbg` ✅ |

**结论：移植 hqtui 的 `blend` / `alpha` / `mix` / `gradient`。** 颜色格式转换已经由 `Bun.color` 覆盖，但**插值是纯算法，Bun 不给**——而波纹动画的核心就是 `blend(hue, band_rgb, alpha)`。

### 2.3 键 / 输入 / 鼠标解析

| | pi-tui | hqtui | src/tui |
| --- | --- | --- | --- |
| 规模 | 24 | 6 | 37 |
| 基础键解析 | `parseKey` `matchesKey` `Key` | `InputParser` | `KeyDecoder` `Key` 🟡 |
| 键绑定 | `KeybindingsManager` `getKeybindings` `setKeybindings` | — | — ❌ |
| **Kitty keyboard** | `setKittyProtocolActive` `isKittyProtocolActive` `decodeKittyPrintable` `parseKeyboardProtocolNegotiationSequence` | — | — ❌ |
| **key release/repeat** | `isKeyRelease` `isKeyRepeat` | — | — ❌ |
| 终端特例归一化 | `normalizeAppleTerminalInput` `normalizeNativeShiftEnterInput` | — | — ❌ |
| stdin 分块 | `StdinBuffer` | — | 内联在 `keys.ts` 🟡 |
| 鼠标分发 | `dispatchMouseEvent` `retargetMouseEvent` | `dispatchHit` `countClicks` `DOUBLE_CLICK_MS` | 内联在 `app.ts` 🟡 |
| **命中体系** | `isFocusable` `MouseRegion` | — | `HitRegionEntry` `HitTarget` `hitRect` `checkHitProbes` `checkVisualAnchors` ✅ |

**结论：移植 `pi-tui/keys.js`（1173 行 vs 本地 289 行）。** 命中体系是本仓库的强项（37 vs 24 vs 6，且有 hit-probe 自检），**不要动**；但键序列解析是明确短板。

### 2.4 终端能力 / 探测

| | pi-tui | hqtui | src/tui |
| --- | --- | --- | --- |
| 规模 | 28 | 8 | 17（多数是命中相关） |
| 能力注册 | `detectCapabilities` `getCapabilities` `setCapabilities` `setCapabilityOverrides` `resetCapabilitiesCache` | `detectCapabilities` | — ❌ |
| **色彩深度** | 由 capabilities 覆盖 | 由 capabilities 覆盖 | — ❌ |
| **cell 像素尺寸** | `getCellDimensions` `setCellDimensions` `calculateImageCellSize` | **`cellSizeFromEnv` `queryCellSize`** | — ❌ |
| 图像头部尺寸 | `getPngDimensions` `getJpegDimensions` `getGifDimensions` `getWebpDimensions` `getImageDimensions` | — | — ❌ |
| 终端尺寸刷新 | `refreshTerminalDimensions` | `createTerminal` | `Terminal`（含 0 兜底）✅ |
| 底色探测 | `parseOsc11BackgroundColor` | — | `detectTerminalBackground` ✅ |
| 转义超时 | `resolveEscapeTimeoutMs` | — | — ❌ |

**结论：移植色彩深度探测 + `getCellDimensions`（pi-tui）或 `cellSizeFromEnv`/`queryCellSize`（hqtui）。** 本仓库的 OSC 11 探测已经对了，缺的是深度与像素尺寸。

### 2.5 图片 / 图形协议

| | pi-tui | hqtui | src/tui |
| --- | --- | --- | --- |
| 规模 | 20 | 54 | 14（全是滚动条/thinking） |
| Kitty 编码 | `encodeKitty` `renderImage` `allocateImageId` `calculateImageRows` `registerKittyImageMetadata` `getKittyImagePlacement` `cropKittyImageLine` `deleteKittyImage` `deleteAllKittyImages` | `kittyImage` `artProtocol` `artSize` | — ❌ |
| iTerm2 编码 | `encodeITerm2` | `itermImage` | — ❌ |
| 降级 | `imageFallback` `isImageLine` | `artCacheDir` | — ❌ |
| **字符级图形** | — | **`BrailleCanvas` `HALF_BLOCKS` `drawCanvas` `plot` `plotPoints` `drawChart` `drawDonut` `drawGauge` `drawHeatBar` `histogram` `sparkline` `bar` `drawSparklineWidget` `drawStatusBar`** | — ❌ |
| 世界地图 | — | `WORLD_COUNTRIES` `WORLD_X` `WORLD_Y` `worldShapes` `drawWorldMap` | — ❌ |
| Emoji | — | `emoji` `emojiPng` `emojiText` `emojiWidth` `emojiSearch` `emojify` `installEmojiFont` `removeEmojiFont` `emojiFontStatus` 等 20+ | — ❌ |

**结论：两个源各管一半。** pi-tui 管**图片协议**（Kitty/iTerm2 编码 + 头部尺寸解析）；hqtui 管**字符级图形**（Braille / 半块 / canvas / chart / plot），也就是「硬算 cell 像素 + 字符级伪造」那一套。Emoji 子系统体量大且 niche，暂不移植。

### 2.6 布局 / 缓冲 / 视口

| | pi-tui | hqtui | src/tui |
| --- | --- | --- | --- |
| 规模 | 19 | 38 | 37 |
| 盒模型 | `Box` `Stack` `HStack` `VStack` `LAYOUT_NODE` `allocateStackSizes` `visibleStackEntries` | `FrameBuffer` `Surface` `GridContainer` `createSurface` `flex` `minmax` `inset` `fill` `fit` `fitSpans` `distribute` `resolveSides` | 定制（`InputLayout` `InputBoxGeometry` `DialogGeometry`）🟡 |
| 文本 span | — | `spanText` `spanStyle` `spanWidth` `toSpanLines` `truncateSpans` `wrapSpans` `dropSpanColumns` | — ❌ |
| 视口 | `ScrollView` `getScrollViewBox` `getScrollbarGeometry` `VIEWPORT_TUI` | `drawScrollbar` `drawScrollbarWidget` `resolveOffset` | `ViewportSpan` `sliceViewport` `maxScrollOffset` `assistantScrollFloor` `assistantAnchorOffset` ✅ |
| 撤销 | `UndoStack` | — | — ❌ |
| stdin 缓冲 | `StdinBuffer` | — | 内联 |

**结论：不移植。** 本仓库的布局是为 transcript 定制的（块级缓存 + 长回答锚定，见 `transcript-layout.ts`），比两边的通用盒模型更贴场景。**唯一可考虑的是 `UndoStack`**（如果要做输入框撤销）。

### 2.7 组件

| | pi-tui | hqtui | src/tui |
| --- | --- | --- | --- |
| 规模 | 24 | 3 | 28 |
| 形态 | 组件类树 | 少量 | `compose*` 纯函数 + 单类状态机 |
| 文本/布局 | `Text` `TruncatedText` `Box` `Container` `Spacer` `VStack` `HStack` `Stack` | `Container` | — |
| 输入 | `Input` **`Editor`（2041 行）** | `InputParser` | `composeInputBox` `layoutInput` 🟡 |
| Markdown | `Markdown` | `MarkdownSummary` | Lezer AST 全套 ✅ |
| 列表 | `SelectList` `SettingsList` | — | — ❌ |
| 图片 | `Image` | — | — ❌ |
| 加载 | `Loader` `CancellableLoader` | — | `composeThinkingBlock` 🟡 |
| 鼠标区域 | `MouseRegion` | — | 命中区域表 ✅ |
| 渲染器 | `TuiMainScreen` `TuiAltScreen`（可互换） | — | 单一 alt-screen |
| 编辑器工具 | `kill-ring` `undo-stack` `word-navigation` `autocomplete` `fuzzy` | — | — ❌ |

**结论：只移植 `Editor` 及其配套（`kill-ring` / `undo-stack` / `word-navigation` / `autocomplete` / `fuzzy`），且仅在要做完整编辑器时。** 其余组件形态与本仓库的纯函数风格冲突，移植等于换架构。

### 2.8 渲染 / 帧 / 差分

| | pi-tui | hqtui | src/tui |
| --- | --- | --- | --- |
| 差分渲染 | `TuiBase` `compositeTuiLine` `renderLayoutFrame` | `Encoder` `encodeFull` `encodeRows` `renderFrames` `renderRows` | `Screen`（行缓冲差分）✅ |
| 帧调度 | — | — | `FrameScheduler`（120fps 合流 + force 累积）✅ |
| 流式节奏 | — | — | `StreamPacer`（到达/显示解耦）✅ |
| **多目标渲染** | — | **`renderToAnsi` `renderToHtml` `renderToScreen` `renderToText`** | — ❌ |
| 光标标记 | `CURSOR_MARKER` | — | `#inputCursorRow` 内联 |

**结论：不移植，本仓库领先。** `Screen` + `FrameScheduler` + `StreamPacer` 是三方里最成熟的一环（同步输出、120fps 合流、force 累积）。**唯一值得注意的是 hqtui 的 `renderToHtml`** —— 它与 buTUI 的「终端/WebUI 共用状态」目标同向，可作参考实现。

### 2.9 Unicode 安全 / 文本

| | pi-tui | hqtui | src/tui |
| --- | --- | --- | --- |
| 规模 | 7 | 10 | **1**（且是语法高亮用的） |
| 空白/标点 | `isWhitespaceChar` `isPunctuationChar` `PUNCTUATION_REGEX` `cjkBreakRegex` `cjkPunctuationRegex` | — | — ❌ |
| **控制符过滤** | — | **`isControl`** | — ❌ |
| **Bidi 控制符** | — | **`isBidiControl`（Trojan Source CVE-2021-42574）** | — ❌ |
| **孤立代理项** | — | **`isLoneSurrogate`** | — ❌ |
| 码点安全 | — | `isUnsafeCodepoint` | — ❌ |
| cell 网格模型 | — | `CLUSTER_BASE` `CONTINUATION` `clusterText` `clusterWidth` `internCluster` | — ❌ |
| 输出归一化 | `normalizeTerminalOutput` | — | — ❌ |

**结论：移植 `hqtui/unicode.js` —— 这是最高优先级。** 本仓库在这块基本是空的（唯一匹配项 `normalizeLanguage` 是语法高亮用的），而 bugent 会把模型输出、工具输出、文件内容**原样打进终端**。`user<RLO>nimda` 在日志面板里会显示成 `user admin` —— 这是真实注入面，不是理论问题。

### 2.10 动画

| | pi-tui | hqtui | src/tui |
| --- | --- | --- | --- |
| 规模 | 0 | 0 | 0 |

**三方都没有通用动画原语。** 这意味着「紫色波纹」那类效果**没有现成的可移植实现** —— 要么自研（动画时钟 + `crest`/`ease_in_out`/`envelope`/`blend`，约 30 行数学 + 一个注册表），要么等 buTUI 的 `createTween`/`createSpring`/`createTimeline`。

### 2.11 Markdown / 高亮

| | pi-tui | hqtui | src/tui |
| --- | --- | --- | --- |
| 规模 | 7 | 7 | 25 |
| Markdown | `Markdown`（810 行） | `markdownText` `MarkdownSummary` | Lezer GFM AST + 表格模型 + 流式 + 缓存统计 ✅ |
| 语法高亮 | — | — | `highlightCode`（Bun 原生 + highlight.js 混合）✅ |
| **LaTeX** | **`renderLatex`（1377 行）** | — | — ❌ |

**结论：不移植 markdown，本仓库领先一个档次。** 唯一缺口是 LaTeX（niche，按需再说）。

### 2.12 剪贴板

| | pi-tui | hqtui | src/tui |
| --- | --- | --- | --- |
| 实现 | `getNativeClipboard`（N-API，仅 darwin/win32/linux-x11） | `clipboardSequence`（OSC 52，纯函数） | `copyNotice` + `app.ts` 内联 OSC 52 |

**结论：可对照 hqtui 的 `clipboardSequence` 看是否更完整**（长度上限、分块）。低优先级。

## 3. 行动清单

### P0 —— 补真实缺口

| 项 | 来源 | 理由 |
| --- | --- | --- |
| `unicode.js` 的控制符 / Bidi / 孤立代理项过滤 | hqtui | 真实注入面，本仓库完全没有 |
| `extractAnsiCode` + `getActiveBackgroundAnsi` + `extractSegments` | pi-tui `utils.js` | 知道某列当前 SGR 状态；染色带/浮层合成的硬前提 |
| `blend` + `alpha` + `mix` + `gradient` | hqtui `color.js` | Bun 只给格式转换，不给插值 |

### P1 —— 功能缺口

| 项 | 来源 | 理由 |
| --- | --- | --- |
| `keys.js` 全套（Kitty protocol / release / repeat / Apple 归一化） | pi-tui | 289 行 → 1173 行的差距 |
| 色彩深度探测 + `getCellDimensions` / `cellSizeFromEnv` | pi-tui / hqtui | 现在完全不做深度降级 |
| `getPngDimensions` / `getJpegDimensions` / `getGifDimensions` / `getWebpDimensions` | pi-tui | 纯解析，零依赖 |
| `getGraphemeCellRange` + `applyBackgroundToLine` | pi-tui | 波纹染色带直接需要 |
| Kitty / iTerm2 编码 | pi-tui | 若要做图片 |

### P2 —— 按需

| 项 | 来源 |
| --- | --- |
| `BrailleCanvas` / `HALF_BLOCKS` / `drawCanvas` / `plot` / `chart` | hqtui `graphics/` |
| `Editor` + `kill-ring` + `undo-stack` + `word-navigation` + `autocomplete` + `fuzzy` | pi-tui |
| `renderLatex` | pi-tui |
| `clipboardSequence` | hqtui |
| `UndoStack`（输入框撤销） | pi-tui |

### 明确不移植

| 项 | 理由 |
| --- | --- |
| Markdown / 高亮 | 本仓库 Lezer AST 版领先 |
| 布局 / 视口 / 滚动 | 本仓库为 transcript 定制，更贴场景 |
| 渲染 / 帧调度 / 流式节奏 | `Screen` + `FrameScheduler` + `StreamPacer` 三方最成熟 |
| 组件树（`TuiMainScreen` / `TuiAltScreen` / `Box` / `Stack` / `ScrollView`） | 形态冲突，移植等于换架构 |
| Emoji 子系统（20+ 导出） | 体量大、niche |
| 图片协议的 N-API 部分（`getNativeClipboard`） | 引入原生插件，与「零原生二进制」冲突 |

## 4. 移植纪律

1. **只移植纯函数。** 有状态的（`TuiAltScreen`、`Editor`、`FrameBuffer`）一律不搬 —— 那是架构，不是工具。
2. **落到 `src/vendor/<pkg>/`，不散进 `src/tui/`。** 每个文件头写：
   `// ported from @earendil-works/pi-tui@0.87.1 (MIT) — dist/utils.js — <改动说明>`
3. **保留 MIT 版权声明。** 两个上游都要求。
4. **`src/vendor/README.md` 记来源、版本、上游地址、改动理由、许可。** 与 `docs/` 现有「每个决定都有出处」的纪律一致。
5. **写自己的测试。** 上游测试依赖它们的框架和内部结构；本仓库已有 985 个用例的基础设施，按本地风格钉住移植来的函数。
6. **升级上游时留 diff 记录。** pi-tui 一周内还在发版，否则半年后没人知道哪些行改过。

## 5. 结论

「吃包子」和「移植」不是二选一，是**分层**：

| 层 | 策略 | 依据 |
| --- | --- | --- |
| 格式化（宽度、折行、切片、颜色格式） | **吃 Bun** | 7 个 API 覆盖，Bun 的实现是原生/SIMD |
| 正确性沼泽（ANSI 解析、键解析、色彩深度、图片协议、Unicode 安全） | **移植** | 最不该手写；已有 MIT 纯函数实现；`node:` 零摩擦 |
| 架构（布局、渲染循环、命中、状态、事件协议） | **自研** | 本仓库在这三块已领先；也是 buTUI 的定位 |

两个最该立刻做的动作：**移植 `hqtui/unicode.js` 的安全过滤**（补注入面），**移植 `pi-tui/utils.js` 的 ANSI 解析**（补染色带/浮层合成的硬前提）。
