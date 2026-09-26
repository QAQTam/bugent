/**
 * 授权提醒自检 —— 按真实时序把提醒放一遍，用来确认硬件通道真的能响。
 *
 *   bun run scripts/alert-test.ts              # speaker + sound 全部通道
 *   bun run scripts/alert-test.ts --speaker    # 只测主板蜂鸣器（验证 udev 规则）
 *   bun run scripts/alert-test.ts --sound      # 只测声卡
 *   bun run scripts/alert-test.ts --bell       # 只测终端 BEL
 *
 * 它不启动 agent，也不碰任何授权逻辑，只驱动 src/permission/alert.ts。
 */

import {
  AuthorizationAlert,
  defaultSoundPlayer,
  findPcSpeakerDevice,
  type AlertChannel,
} from "../src/permission/alert.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const args = new Set(process.argv.slice(2));
let channels: AlertChannel[] = ["speaker", "sound"];
if (args.has("--speaker")) channels = ["speaker"];
else if (args.has("--sound")) channels = ["sound"];
else if (args.has("--bell")) channels = ["bell"];

console.log("通道:", channels.join(" + "));
console.log("PC speaker 设备:", findPcSpeakerDevice() ?? "(未找到 /sys/class/input 下的 PC Speaker)");
console.log("声卡播放器:", defaultSoundPlayer()?.join(" ") ?? "(未找到 paplay / aplay)");
console.log();

const alert = new AuthorizationAlert({ channels, urgencyWindowMs: 10_000, volume: 0.6 });

console.log("[1/4] 弹窗出现 —— 三音上行动机");
alert.begin(60_000);
await sleep(900);

console.log("[2/4] 倒计时最后 10 秒 —— 10/5/3/1 四档逐级升级");
for (const remaining of [12_000, 9_500, 8_000, 4_500, 2_500, 900]) {
  console.log(`      剩余 ${(remaining / 1000).toFixed(1)}s`);
  alert.tick(remaining);
  await sleep(800);
}

console.log("[3/4] 批准 —— 上行收尾音");
alert.end("approved");
await sleep(900);

console.log("[4/4] 拒绝 —— 下行收尾音");
alert.begin(60_000);
await sleep(600);
alert.end("denied");
await sleep(1_000);

console.log("\n完成。没听到 speaker 那一层，检查 udev 规则（docs/authorization-alert.md）。");
