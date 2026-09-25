# 提示词实验台（prompt-lab）

改提示词最容易变成玄学：换两句措辞、看两条输出，就宣布"这样更好"。这个实验台
把它变成可复现的对照实验 —— 每个变体跑 N 次同一道题，统计推理里出现
`We need` / `Let me` 的比例，原始推理全量落盘，小样本用 Wilson 区间 + Fisher
精确检验。

## 怎么跑

```bash
# 1) 冻结当前仓库的提示词（改之前先存一份，否则改完就没法对照了）
bun run scripts/dump-tools.ts zh-baseline --system

# 2) 跑实验（默认 debug 题；--task study 是 study 里那道 Python 并发题）
bun run scripts/prompt-lab.ts --task study --trials 24 --concurrency 3

# 3) 只重算统计（不重跑模型）
bun run scripts/prompt-lab-analyze.ts .prompt-lab/runs/<...>/results.jsonl --baseline baseline-zh
```

环境变量：`PROMPT_LAB_BASE_URL`（默认本地网关 `http://127.0.0.1:8787/v1`）、
`PROMPT_LAB_MODEL`（默认 `deepseek-v4.1-flash`）、`PROMPT_LAB_EFFORT`（默认 `high`）。

快照放在 `.prompt-lab/snapshots/`（已 gitignore），所以"改前 / 改后"永远是同一把尺子。

## 结论（224 次真实运行，`deepseek-v4.1-flash` / effort=high）

主任务用 study 里那道 Python `TaskQueue` 并发题（够复杂，模型会真的规划）：

| 变体 | `We need` | 推理长度 | vs baseline |
|---|---:|---:|---:|
| baseline：中文工具描述 + 旧 system.md | 11/52 = 21% | 6.9k chars | — |
| 只换工具 schema（短 + 纯英文） | 2/16 = 13% | 6.6k chars | p=0.72 |
| 只换 system prompt（纪律搬进来） | 7/16 = 44% | 15.2k chars | p=0.11 |
| 两者都换 | 15/44 = 34% | 13.8k chars | p=0.17 |
| 无工具 | 5/28 = 18% | 12.1k chars | p=0.78 |
| 软措辞（"陈述需求时用 We need to ..."） | 3/16 = 19% | 13.4k chars | p=1.00 |
| 更软（"先说要做什么再决定怎么做"） | 5/16 = 31% | 18.1k chars | p=0.50 |
| **显式要求句式**（"Start every reasoning paragraph with \"We need\""） | **27/36 = 75%** | 16.9k chars | **p<0.001** |

另外还有 144 次跑在"简单题"（`find(...)!.toUpperCase()` 那种一眼能答完的 TS bug）
上的对照：**所有变体 0/144**，连显式要求句式的变体也只有 1-2/16。

### 四条能用的结论

1. **任务实质是前提，提示词只是放大器。**
   简单题 144 次一次 `We need` 都没有 —— 模型不需要规划时，怎么措辞都没用。
   要观察这个指标，题目得真的需要多步推理。

2. **唯一稳的杠杆是显式要求句式**（21% → 75%，p<0.001）。
   软措辞（"用 We need to 陈述需求"）几乎没有效果（19%）—— 模型不会从
   "要求用某种句式"推断出"整段推理都用这个句式"，得直接说清楚。

3. **把纪律从工具描述搬进 system prompt，让推理变长了。**
   推理长度 6.9k → 15.2k 字符，`We need` 从 21% → 34-44%。方向对，但 n=16
   时还在噪声里（p≈0.11），要下定论得跑到每组 60+ 次。

4. **工具 schema 的语言与长度，对推理风格没有可测出的影响**（13% vs 21%，
   p=0.72）。它的收益在别处：24 个工具的 schema 从 ~3951 tok 降到 ~2998 tok
   （省 24%），而且纪律从"只在模型决定调这个工具时才读到"变成"每轮都在"。

### 机制上的一个重要事实

我们能看到的"CoT"是上游的 **reasoning summary**（网关会补
`reasoning_summary: "auto"`），不是模型内部原始推理。这解释了为什么：
措辞类指令效果弱、软措辞几乎无效、同一变体两轮之间波动大（`both` 先 58%
后 19%）。**能改的是摘要的风格，不是推理本身。**

另外网关是按账号池负载均衡的，同一变体跨轮次的方差里，有一部分可能来自
上游路由到了不同后端 —— 要更干净的数据得按账号分层统计。

## 还没有验证的

- `reasoning_summary` 显式设成 `concise` / `detailed`：在简单题上无差异
  （0/12），复杂题还没跑。
- 每组 60+ 次的功效验证（现在的结论区间还很宽）。
- 中文注入指令（`GOAL_INITIALIZATION_INSTRUCTION`、goal 状态注入、工具报错）
  与英文 system prompt 混用的影响 —— 目前模型可见面里只剩这几处中文。
