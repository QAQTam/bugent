/**
 * 一次性探针：验证 bwrap 沙箱下"跨区写"的边界。
 * 跑完即删。
 */
import { createSandboxedShellRunner } from "../src/sandbox/bwrap.ts";
import { mkdir, rm } from "node:fs/promises";

const base = `${import.meta.dir}/.xw-probe`;
const cwd = `${base}/wd`;
const other = `${base}/other`;
await rm(base, { recursive: true, force: true });
await mkdir(cwd, { recursive: true });
await mkdir(other, { recursive: true });

type Case = [label: string, target: string, sandbox: Parameters<typeof createSandboxedShellRunner>[0]];
const cases: Case[] = [
  ["A 工作区内", `${cwd}/in.txt`, { workspaceWrite: true }],
  ["B 工作区外·同盘同级目录", `${other}/out.txt`, { workspaceWrite: true }],
  ["C 工作区外 + writablePaths 放行", `${other}/out.txt`, { workspaceWrite: true, writablePaths: [other] }],
  ["D read-only 档写工作区", `${cwd}/ro.txt`, { workspaceWrite: false }],
  ["E /root", `/root/x.txt`, { workspaceWrite: true }],
  ["F /usr/lib", `/usr/lib/x.txt`, { workspaceWrite: true }],
  ["G /etc", `/etc/x.txt`, { workspaceWrite: true }],
  ["H 沙箱内 /tmp", `/tmp/xw-tmp.txt`, { workspaceWrite: true }],
  ["I $HOME", `${process.env.HOME}/xw-probe.txt`, { workspaceWrite: true }],
  ["J /dev/shm", `/dev/shm/xw.txt`, { workspaceWrite: true }],
  ["K 父目录（项目根）", `${import.meta.dir}/xw-root.txt`, { workspaceWrite: true }],
  ["L /var/tmp", `/var/tmp/xw.txt`, { workspaceWrite: true }],
];

for (const [label, target, sandbox] of cases) {
  const runner = createSandboxedShellRunner(sandbox);
  const r = await runner.run({
    command: `printf hi > ${target} && echo WROTE || echo BLOCKED`,
    cwd,
    timeoutMs: 15000,
    maxOutputBytes: 8192,
    signal: new AbortController().signal,
  });
  const msg = (r.stdout + r.stderr).trim().replace(/\s+/g, " ").slice(0, 100);
  console.log(`${label.padEnd(34)} exit=${String(r.exitCode).padStart(3)}  ${msg}`);
}

// 宿主机侧复核：哪些文件真的落盘了
console.log("\n--- 宿主机复核（沙箱外）---");
for (const [label, target] of [
  ["A", `${cwd}/in.txt`],
  ["B/C", `${other}/out.txt`],
  ["H /tmp", `/tmp/xw-tmp.txt`],
  ["I $HOME", `${process.env.HOME}/xw-probe.txt`],
] as Array<[string, string]>) {
  console.log(`${label.padEnd(10)} ${(await Bun.file(target).exists()) ? "存在" : "不存在"}  ${target}`);
}

await rm(base, { recursive: true, force: true });
