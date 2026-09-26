/**
 * 授权硬件提醒 —— 让"有个弹窗在等你"这件事离开屏幕。
 *
 * 为什么需要：授权窗口 60 秒后按超时**拒绝**（fail closed，见 authorization.ts）。
 * 但用户很可能正在别的窗口忙，等回来时模型早就按超时走了。终端 BEL 只在终端里
 * 响，TUI 全屏重绘时还常被吞掉；系统通知又依赖通知中心，勿扰模式下同样失效。
 *
 * 三个通道，按"越不容易被忽略"排序：
 *   speaker —— 主板蜂鸣器（PIT Timer2 / pcspkr 驱动）。绕过音量、绕过耳机、
 *              绕过静音，只要机器通电就能响。代价是需要对 /dev/input/eventN
 *              有写权限（一次性 udev 规则，见 docs/authorization-alert.md）。
 *   sound   —— 声卡合成音。无特权要求，但会被音量/静音影响。
 *   bell    —— 终端 BEL。兜底，等价于现有行为。
 *
 * 提醒分三级：
 *   begin()  —— 弹窗出现：三音上行动机，先把注意力拉过来。
 *   tick()   —— 最后 10 秒按 10/5/3/1 秒四档升级，越接近超时越急促。
 *   end()    —— 批准/拒绝各一个收尾音，不看屏幕也能知道结果。
 *
 * 全部 fire-and-forget：任何通道失败都静默降级并记住失败，绝不阻塞授权流程，
 * 也绝不让"提醒"本身把 agent 弄挂。
 */

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import type { AuthorizationOutcome } from "./authorization.ts";

export type AlertChannel = "speaker" | "sound" | "bell";

/** 一个音：频率 + 时长 + 与下一个音之间的静音。 */
export interface AlertNote {
  freq: number;
  ms: number;
  gapMs?: number;
}

export interface AlertConfig {
  /** 总开关。默认 **关闭** —— 提醒会发声，不能替用户默认打开。 */
  enabled?: boolean;
  /** 启用的通道，默认 ["speaker", "sound"]。 */
  channels?: readonly AlertChannel[];
  /** 倒计时告警窗口（毫秒），默认 10000 —— 即"最后 10 秒"。 */
  urgencyWindowMs?: number;
  /** sound 通道音量 0..1，默认 0.55。 */
  volume?: number;
  /** PC speaker 的 event 设备路径；默认按 /sys/class/input 自动发现。 */
  speakerDevice?: string;
  /** 自定义播放器 argv；默认自动挑 paplay / aplay，PCM 从 stdin 喂。 */
  soundPlayer?: readonly string[];
}

/** 测试注入点：接管发声，避免测试真的去响硬件。 */
export interface AlertDeps {
  emit?: (notes: readonly AlertNote[]) => void;
}

/** 弹窗出现时的"注意"动机：A5 -> D6 -> G6，上行。 */
export const ALERT_BEGIN_MOTIF: readonly AlertNote[] = [
  { freq: 880, ms: 90 },
  { freq: 1174, ms: 90 },
  { freq: 1568, ms: 140 },
];

/**
 * 倒计时档位。`at` 是 urgencyWindowMs 的比例，实际阈值 = 窗口 × at。
 * 10 秒窗口下依次是 10s / 5s / 3s / 1s，节奏越来越密。
 */
const URGENCY_STEPS: readonly { at: number; notes: readonly AlertNote[] }[] = [
  { at: 1.0, notes: [{ freq: 1046, ms: 70 }, { freq: 1046, ms: 70 }] },
  {
    at: 0.5,
    notes: [{ freq: 1318, ms: 60 }, { freq: 1318, ms: 60 }, { freq: 1318, ms: 60 }],
  },
  {
    at: 0.3,
    notes: [
      { freq: 1568, ms: 45 },
      { freq: 1568, ms: 45 },
      { freq: 1568, ms: 45 },
      { freq: 1568, ms: 45 },
    ],
  },
  {
    at: 0.1,
    notes: [
      { freq: 1760, ms: 40 },
      { freq: 1760, ms: 40 },
      { freq: 1760, ms: 40 },
      { freq: 1760, ms: 40 },
      { freq: 1760, ms: 40 },
      { freq: 1760, ms: 40 },
    ],
  },
];

/** 批准：两个上行音。拒绝/超时：两个下行音。 */
export const ALERT_APPROVED_MOTIF: readonly AlertNote[] = [
  { freq: 880, ms: 70 },
  { freq: 1320, ms: 130 },
];
export const ALERT_REFUSED_MOTIF: readonly AlertNote[] = [
  { freq: 392, ms: 140 },
  { freq: 262, ms: 220 },
];

const EV_SND = 0x12;
const SND_TONE = 0x02;
const INPUT_EVENT_BYTES = 24; // timeval(16) + type(2) + code(2) + value(4)，x86_64
const PCM_RATE = 48_000;

function unrefTimer(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}

/** struct input_event，小端。pcspkr 驱动只看 EV_SND/SND_TONE 的 value。 */
function inputEvent(code: number, value: number): Buffer {
  const buf = Buffer.alloc(INPUT_EVENT_BYTES);
  buf.writeBigInt64LE(0n, 0);
  buf.writeBigInt64LE(0n, 8);
  buf.writeUInt16LE(EV_SND, 16);
  buf.writeUInt16LE(code, 18);
  buf.writeInt32LE(value, 20);
  return buf;
}

/** 扫 /sys/class/input 找名字叫 "PC Speaker" 的设备，拿到它的 /dev/input/eventN。 */
export function findPcSpeakerDevice(): string | undefined {
  const base = "/sys/class/input";
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.startsWith("input")) continue;
    try {
      const name = readFileSync(`${base}/${entry}/name`, "utf8").trim();
      if (name !== "PC Speaker") continue;
      const events = readdirSync(`${base}/${entry}`).filter((file) => file.startsWith("event"));
      if (events.length > 0) return `/dev/input/${events[0]}`;
    } catch {
      // 设备树里偶尔有读不到的条目，跳过就好
    }
  }
  return undefined;
}

/** 默认播放器：都要能读裸 PCM 的 stdin。 */
export function defaultSoundPlayer(): string[] | undefined {
  if (Bun.which("paplay")) {
    return ["paplay", "--raw", "--format=s16le", `--rate=${PCM_RATE}`, "--channels=1"];
  }
  if (Bun.which("aplay")) {
    return ["aplay", "-q", "-t", "raw", "-f", "S16_LE", "-r", String(PCM_RATE), "-c", "1"];
  }
  return undefined;
}

/** 把音序合成成单声道 s16le PCM。基频 + 一点二次谐波 + 指数衰减，听起来像"叮"。 */
export function synthesizePcm(
  notes: readonly AlertNote[],
  volume: number,
  rate: number = PCM_RATE,
): Buffer {
  const totalMs = notes.reduce((sum, note) => sum + note.ms + (note.gapMs ?? 12), 0) + 60;
  const frames = Math.max(1, Math.ceil((totalMs / 1000) * rate));
  const pcm = new Int16Array(frames);
  let cursor = 0;
  for (const note of notes) {
    const length = Math.max(1, Math.round((note.ms / 1000) * rate));
    const attack = Math.max(1, Math.round(0.003 * rate));
    for (let i = 0; i < length && cursor + i < frames; i += 1) {
      const decay =
        i < attack
          ? i / attack
          : Math.pow(1 - (i - attack) / Math.max(1, length - attack), 1.6);
      const phase = (2 * Math.PI * note.freq * i) / rate;
      const sample = (Math.sin(phase) * 0.82 + Math.sin(2 * phase) * 0.18) * decay * volume;
      pcm[cursor + i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }
    cursor += length + Math.round(((note.gapMs ?? 12) / 1000) * rate);
  }
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

/**
 * 授权提醒器。生命周期由调用方驱动：
 *   begin(timeoutMs) -> tick(remainingMs)... -> end(outcome)
 *
 * 同一个实例可以复用（多次授权请求），内部状态在 begin 时重置。
 */
export class AuthorizationAlert {
  readonly #channels: ReadonlySet<AlertChannel>;
  readonly #urgencyWindowMs: number;
  readonly #volume: number;
  readonly #speakerDevice: string | undefined;
  readonly #soundPlayer: readonly string[] | undefined;
  readonly #deps: AlertDeps;
  #speakerUsable: boolean;
  #soundUsable: boolean;
  #level = -1;
  #active = false;

  constructor(config: AlertConfig = {}, deps: AlertDeps = {}) {
    this.#channels = new Set(config.channels ?? ["speaker", "sound"]);
    this.#urgencyWindowMs = Math.max(0, config.urgencyWindowMs ?? 10_000);
    this.#volume = Math.min(1, Math.max(0, config.volume ?? 0.55));
    this.#speakerDevice = config.speakerDevice;
    this.#soundPlayer = config.soundPlayer;
    this.#deps = deps;
    this.#speakerUsable = this.#channels.has("speaker");
    this.#soundUsable = this.#channels.has("sound");
  }

  /** 有通道可用才值得接线。 */
  get enabled(): boolean {
    return this.#channels.size > 0;
  }

  /** 弹窗出现：响一次"注意"动机。 */
  begin(_timeoutMs: number): void {
    this.#active = true;
    this.#level = -1;
    this.#emit(ALERT_BEGIN_MOTIF);
  }

  /** 每秒调用一次：进入最后 N 秒后按档位升级，同一档只响一次。 */
  tick(remainingMs: number): void {
    if (!this.#active || this.#urgencyWindowMs <= 0) return;
    let level = 0;
    for (const step of URGENCY_STEPS) {
      if (remainingMs <= this.#urgencyWindowMs * step.at) level += 1;
    }
    if (level <= this.#level) return;
    this.#level = level;
    if (level > 0) this.#emit(URGENCY_STEPS[level - 1]!.notes);
  }

  /** 有结论了：批准/拒绝各一个收尾音。 */
  end(outcome: AuthorizationOutcome): void {
    if (!this.#active) return;
    this.#active = false;
    this.#emit(outcome === "approved" ? ALERT_APPROVED_MOTIF : ALERT_REFUSED_MOTIF);
  }

  #emit(notes: readonly AlertNote[]): void {
    if (notes.length === 0) return;
    if (this.#deps.emit !== undefined) {
      this.#deps.emit(notes);
      return;
    }
    if (this.#channels.has("bell")) this.#ringBell(notes.length);
    if (this.#speakerUsable) this.#playSpeaker(notes);
    if (this.#soundUsable) this.#playSound(notes);
  }

  #ringBell(times: number): void {
    try {
      process.stderr.write("\x07".repeat(Math.min(times, 6)));
    } catch {
      // stderr 被关掉是常态（管道/CI），忽略
    }
  }

  #playSpeaker(notes: readonly AlertNote[]): void {
    const path = this.#speakerDevice ?? findPcSpeakerDevice();
    if (path === undefined) {
      this.#speakerUsable = false;
      return;
    }
    let fd: number;
    try {
      fd = openSync(path, "w");
    } catch {
      // 没有写权限（没装 udev 规则）或设备不存在：记下来，别再反复试
      this.#speakerUsable = false;
      return;
    }

    const jobs: { at: number; buf: Buffer }[] = [];
    let cursor = 0;
    for (const note of notes) {
      jobs.push({ at: cursor, buf: inputEvent(SND_TONE, note.freq) });
      cursor += note.ms;
      jobs.push({ at: cursor, buf: inputEvent(SND_TONE, 0) });
      cursor += note.gapMs ?? 12;
    }
    for (const job of jobs) {
      unrefTimer(
        setTimeout(() => {
          try {
            writeSync(fd, job.buf);
          } catch {
            // 设备中途消失：这次就算了
          }
        }, job.at),
      );
    }
    unrefTimer(
      setTimeout(() => {
        try {
          closeSync(fd);
        } catch {
          // 已经关了
        }
      }, cursor + 60),
    );
  }

  #playSound(notes: readonly AlertNote[]): void {
    const player = this.#soundPlayer ?? defaultSoundPlayer();
    if (player === undefined || player.length === 0) {
      this.#soundUsable = false;
      return;
    }
    const pcm = synthesizePcm(notes, this.#volume);
    try {
      const child = spawn(player[0]!, player.slice(1), {
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", () => {
        this.#soundUsable = false;
      });
      child.stdin?.on("error", () => {
        // 播放器提前退出（没有音频服务）时会 EPIPE，静默即可
      });
      child.stdin?.end(pcm);
      child.unref();
    } catch {
      this.#soundUsable = false;
    }
  }
}

/**
 * 从配置构造提醒器。**默认返回 undefined** —— 发声必须显式打开，
 * 否则每次跑测试/CI 都会响，那是灾难。
 */
export function createAuthorizationAlert(
  config: AlertConfig | undefined,
  deps: AlertDeps = {},
): AuthorizationAlert | undefined {
  if (config?.enabled !== true) return undefined;
  const alert = new AuthorizationAlert(config, deps);
  return alert.enabled ? alert : undefined;
}
