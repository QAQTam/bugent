# 授权硬件提醒

授权窗口是 **60 秒**，到点按**拒绝**收口（fail closed，见 `src/permission/authorization.ts`）。
问题是用户很可能正在别的窗口忙 —— 终端 BEL 只在终端里响，TUI 全屏重绘时还常被
吞掉；系统通知又依赖通知中心，勿扰模式下同样失效。等回来时模型早就按超时走了。

这个能力让"有个授权在等你"这件事离开屏幕，走硬件。

## 时序

```
授权请求出现 ──► 三音上行动机 (A5 → D6 → G6)
                    │
                    │  60 秒窗口
                    │
   剩余 10s ────────┼──► 两短音   (1046Hz ×2)
   剩余  5s ────────┼──► 三短音   (1318Hz ×3)
   剩余  3s ────────┼──► 四急音   (1568Hz ×4)
   剩余  1s ────────┼──► 六急音   (1760Hz ×6)
                    │
结论 ───────────────┴──► 批准：上行两音 / 拒绝·超时：下行两音
```

四档阈值是 `urgencyWindowMs` 的 100% / 50% / 30% / 10%，所以把窗口改成
20 秒，档位就落在 20/10/6/2 秒。同一档只响一次，不会每秒都叫。

## 三个通道

| 通道 | 硬件 | 优点 | 代价 |
|---|---|---|---|
| `speaker` | 主板蜂鸣器（PIT Timer2 / `pcspkr`） | 绕过音量、耳机、静音；只要机器通电就响 | 需要 `/dev/input/eventN` 写权限 |
| `sound` | 声卡合成音（`paplay --raw` 喂 PCM） | 无特权要求，任何机器都能用 | 会被音量/静音影响 |
| `bell` | 终端 BEL | 零依赖兜底 | 只在终端里响，可能被吞 |

默认 `["speaker", "sound"]`：能响蜂鸣器就响，响不了自动降级到声卡。
任何通道失败都会**静默降级并记住失败**，不会反复重试，更不会阻塞授权流程。

## 配置

`~/.bugent/config.toml`：

```toml
[alert]
enabled = true
channels = ["speaker", "sound"]
urgency_window_ms = 10000
volume = 0.55
# speaker_device = "/dev/input/event17"
# sound_player = ["paplay", "--raw", "--format=s16le", "--rate=48000", "--channels=1"]
```

或项目级 `bugent.config.ts`：

```ts
export default defineConfig({
  // ...
  alert: {
    enabled: true,
    channels: ["speaker", "sound"],
    urgencyWindowMs: 10_000,
    volume: 0.55,
  },
});
```

**默认关闭。** 这个开关会真的让机器发声，不能替用户默认打开 —— 否则跑测试、
CI、批量任务时会满屋响。

## 让主板蜂鸣器免 sudo（一次性）

`/dev/input/eventN` 是 `root:input 0660`，而 systemd 的 `70-uaccess.rules`
只给手柄之类打 `uaccess` 标签，PC Speaker 不在其中。所以要么每次提权，要么
装一条 udev 规则把设备 ACL 授给当前登录会话：

```udev
# /etc/udev/rules.d/70-bugent-pcspkr.rules
ACTION=="add|change", SUBSYSTEM=="input", KERNEL=="event*", ATTRS{name}=="PC Speaker", TAG+="uaccess"
```

安装：

```bash
sudo install -m 0644 /dev/stdin /etc/udev/rules.d/70-bugent-pcspkr.rules <<'EOF'
ACTION=="add|change", SUBSYSTEM=="input", KERNEL=="event*", ATTRS{name}=="PC Speaker", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=input
getfacl /dev/input/event17   # 应该看到 user:你的用户名:rw-
```

`TAG+="uaccess"` 由 systemd-logind 处理：ACL 只授给**当前活动会话**的用户，
注销即失效，比把用户加进 `input` 组安全得多（后者等于给了键盘记录权限）。

不想装规则也行 —— 把 `channels` 里的 `speaker` 去掉，只用声卡通道。

## 自检

```bash
bun run scripts/alert-test.ts            # 全部通道，完整时序
bun run scripts/alert-test.ts --speaker  # 只测蜂鸣器（验证 udev 规则）
bun run scripts/alert-test.ts --sound    # 只测声卡
```

## 排查

| 现象 | 原因 |
|---|---|
| 只有声卡响，蜂鸣器不响 | udev 规则没装或没 reload；`getfacl /dev/input/event17` 看有没有你的 ACL |
| 两个都不响 | `enabled = false`，或 `channels` 为空；跑自检脚本看通道探测结果 |
| 声卡通道报 EPIPE | 没有音频服务（无 PipeWire/PulseAudio），或 `paplay` 不存在 |
| 笔记本完全没反应 | 很多笔记本没有主板蜂鸣器，`speaker` 通道会自动降级 |
| 想临时关掉 | 把 `enabled` 改成 `false`，不必删配置 |

## 实现位置

- `src/permission/alert.ts` —— 提醒引擎（通道探测、PCM 合成、分级节奏）
- `src/permission/authorization.ts` —— 授权窗口，提供 `onTick(remainingMs)`
- `src/tui/app.ts` `#authorize()` —— TUI 弹窗路径接线
- `src/permission/prompt.ts` `#withAlert()` —— CLI 问答路径接线
- `src/config/toml.ts` `parseAlert()` —— `[alert]` 配置解析
- `tests/authorization-alert.test.ts` —— 时序与配置的回归测试
