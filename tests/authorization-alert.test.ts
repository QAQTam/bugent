import { describe, expect, test } from "bun:test";
import {
  ALERT_APPROVED_MOTIF,
  ALERT_BEGIN_MOTIF,
  ALERT_REFUSED_MOTIF,
  AuthorizationAlert,
  createAuthorizationAlert,
  synthesizePcm,
  type AlertNote,
} from "../src/permission/alert.ts";
import { withAuthorizationWindow } from "../src/permission/authorization.ts";
import { parseConfigToml } from "../src/config/toml.ts";

/** 记录每一次发声；测试绝不真的去响硬件。 */
function recorder(): { cues: AlertNote[][]; emit: (notes: readonly AlertNote[]) => void } {
  const cues: AlertNote[][] = [];
  return {
    cues,
    emit: (notes) => {
      cues.push(notes.map((note) => ({ ...note })));
    },
  };
}

describe("授权提醒 · 开关", () => {
  test("未配置 / enabled=false 一律不构造", () => {
    expect(createAuthorizationAlert(undefined)).toBeUndefined();
    expect(createAuthorizationAlert({ enabled: false })).toBeUndefined();
    expect(createAuthorizationAlert({})).toBeUndefined();
  });

  test("enabled=true 才生效", () => {
    const alert = createAuthorizationAlert({ enabled: true });
    expect(alert).toBeDefined();
    expect(alert?.enabled).toBe(true);
  });

  test("通道全关时视为不可用", () => {
    expect(createAuthorizationAlert({ enabled: true, channels: [] })).toBeUndefined();
  });
});

describe("授权提醒 · 时序", () => {
  test("弹窗出现 -> 四档升级 -> 批准收尾", () => {
    const { cues, emit } = recorder();
    const alert = new AuthorizationAlert({ urgencyWindowMs: 10_000 }, { emit });

    alert.begin(60_000);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual(ALERT_BEGIN_MOTIF.map((note) => ({ ...note })));

    // 还早：不响
    alert.tick(30_000);
    alert.tick(12_000);
    expect(cues).toHaveLength(1);

    alert.tick(9_800); // 第 1 档：<=10s
    expect(cues).toHaveLength(2);
    expect(cues[1]).toHaveLength(2);

    alert.tick(9_000); // 同一档不重复
    alert.tick(8_000);
    expect(cues).toHaveLength(2);

    alert.tick(4_900); // 第 2 档：<=5s
    expect(cues).toHaveLength(3);
    expect(cues[2]).toHaveLength(3);

    alert.tick(2_900); // 第 3 档：<=3s
    expect(cues).toHaveLength(4);
    expect(cues[3]).toHaveLength(4);

    alert.tick(900); // 第 4 档：<=1s
    expect(cues).toHaveLength(5);
    expect(cues[4]).toHaveLength(6);

    alert.end("approved");
    expect(cues).toHaveLength(6);
    expect(cues[5]).toEqual(ALERT_APPROVED_MOTIF.map((note) => ({ ...note })));
  });

  test("超时与拒绝都用下行收尾音", () => {
    const { cues, emit } = recorder();
    const alert = new AuthorizationAlert({ urgencyWindowMs: 10_000 }, { emit });
    alert.begin(60_000);
    alert.end("timeout");
    expect(cues[1]).toEqual(ALERT_REFUSED_MOTIF.map((note) => ({ ...note })));

    const other = recorder();
    const second = new AuthorizationAlert({}, { emit: other.emit });
    second.begin(60_000);
    second.end("denied");
    expect(other.cues[1]).toEqual(ALERT_REFUSED_MOTIF.map((note) => ({ ...note })));
  });

  test("没 begin 就不该 tick/end 出声；end 只结算一次", () => {
    const { cues, emit } = recorder();
    const alert = new AuthorizationAlert({}, { emit });
    alert.tick(1_000);
    alert.end("approved");
    expect(cues).toHaveLength(0);

    alert.begin(60_000);
    alert.end("approved");
    alert.end("denied");
    expect(cues).toHaveLength(2);
  });

  test("urgencyWindowMs 可调，且 0 表示不做倒计时升级", () => {
    const { cues, emit } = recorder();
    const alert = new AuthorizationAlert({ urgencyWindowMs: 4_000 }, { emit });
    alert.begin(60_000);
    alert.tick(3_900);
    expect(cues).toHaveLength(2);
    alert.tick(1_900);
    expect(cues).toHaveLength(3);

    const quiet = recorder();
    const noUrgency = new AuthorizationAlert({ urgencyWindowMs: 0 }, { emit: quiet.emit });
    noUrgency.begin(60_000);
    noUrgency.tick(500);
    noUrgency.tick(1);
    expect(quiet.cues).toHaveLength(1);
  });

  test("同一个实例可以反复用于多次授权", () => {
    const { cues, emit } = recorder();
    const alert = new AuthorizationAlert({}, { emit });
    alert.begin(60_000);
    alert.end("approved");
    alert.begin(60_000);
    alert.tick(9_000);
    alert.end("denied");
    // begin + end(approved) + begin + 倒计时档位 + end(denied)
    expect(cues).toHaveLength(5);
  });
});

describe("授权提醒 · 与授权窗口同生命周期", () => {
  test("窗口超时 -> 提醒以 timeout 收尾", async () => {
    const { cues, emit } = recorder();
    const alert = new AuthorizationAlert({ urgencyWindowMs: 1_000 }, { emit });
    alert.begin(1_100);
    const outcome = await withAuthorizationWindow({
      timeoutMs: 1_100,
      onTick: (remaining) => alert.tick(remaining),
      request: () => new Promise<boolean>(() => {}),
    });
    alert.end(outcome);

    expect(outcome).toBe("timeout");
    // begin + 至少一次倒计时档位 + 收尾
    expect(cues.length).toBeGreaterThanOrEqual(3);
    expect(cues.at(-1)).toEqual(ALERT_REFUSED_MOTIF.map((note) => ({ ...note })));
  });
});

describe("授权提醒 · 声卡 PCM", () => {
  test("长度按音序时长算，且不是静音", () => {
    const notes: AlertNote[] = [
      { freq: 880, ms: 100, gapMs: 0 },
      { freq: 1320, ms: 50, gapMs: 0 },
    ];
    const pcm = synthesizePcm(notes, 0.5, 48_000);
    // 150ms 音 + 60ms 尾巴 = 210ms -> 10080 帧 -> 20160 字节
    expect(pcm.byteLength).toBe(10_080 * 2);

    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    const peak = Math.max(...Array.from(samples, (value) => Math.abs(value)));
    expect(peak).toBeGreaterThan(1_000);
    expect(peak).toBeLessThanOrEqual(32_767);
  });

  test("音量 0 时输出全静音", () => {
    const pcm = synthesizePcm([{ freq: 880, ms: 50 }], 0, 48_000);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    expect(Array.from(samples).every((value) => value === 0)).toBe(true);
  });
});

describe("授权提醒 · 配置解析", () => {
  const base = `
model = "test-model"
provider = "openai"

[[providers]]
id = "openai"
endpoint = "openai-chat"
`;

  test("解析 [alert] 段", () => {
    const config = parseConfigToml(
      `${base}
[alert]
enabled = true
channels = ["speaker", "bell"]
urgency_window_ms = 8000
volume = 0.4
speaker_device = "/dev/input/event17"
sound_player = ["paplay", "--raw"]
`,
    );
    expect(config.alert).toEqual({
      enabled: true,
      channels: ["speaker", "bell"],
      urgencyWindowMs: 8_000,
      volume: 0.4,
      speakerDevice: "/dev/input/event17",
      soundPlayer: ["paplay", "--raw"],
    });
  });

  test("没写 [alert] 时字段缺席（默认关闭）", () => {
    expect(parseConfigToml(base).alert).toBeUndefined();
  });

  test("非法通道 / 越界音量被拒绝", () => {
    expect(() => parseConfigToml(`${base}\n[alert]\nchannels = ["loud"]\n`)).toThrow(/alert.channels/);
    expect(() => parseConfigToml(`${base}\n[alert]\nvolume = 2\n`)).toThrow(/alert.volume/);
    expect(() => parseConfigToml(`${base}\n[alert]\nenabled = "yes"\n`)).toThrow(/alert.enabled/);
  });
});
