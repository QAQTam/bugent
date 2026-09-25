/** 探针 2：/tmp 上的工作区、符号链接逃逸、mount 顺序。 */
import { createSandboxedShellRunner } from "../src/sandbox/bwrap.ts";
import { mkdir, rm, symlink, readdir } from "node:fs/promises";

const run = async (label: string, cwd: string, command: string, sandbox: object = { workspaceWrite: true }) => {
  const runner = createSandboxedShellRunner(sandbox);
  const r = await runner.run({
    command,
    cwd,
    timeoutMs: 15000,
    maxOutputBytes: 8192,
    signal: new AbortController().signal,
  });
  const msg = (r.stdout + r.stderr).trim().replace(/\s+/g, " ").slice(0, 140);
  console.log(`${label.padEnd(30)} exit=${String(r.exitCode).padStart(3)}  ${msg}`);
};

// 场景 1：工作目录在 /tmp 下（--tmpfs /tmp 先执行，再 --bind cwd）
const tmpWd = "/tmp/bugent-xw/wd";
await rm("/tmp/bugent-xw", { recursive: true, force: true });
await mkdir(tmpWd, { recursive: true });
await run("cwd 在 /tmp 下·写文件", tmpWd, "pwd && echo hi > a.txt && ls -1 && echo WROTE");
console.log("   宿主机 /tmp/bugent-xw/wd:", await readdir(tmpWd));

// 场景 2：cwd 经符号链接（/home 下的软链指向 /tmp）
const realDir = "/tmp/bugent-xw/real";
await mkdir(realDir, { recursive: true });
await rm("/tmp/bugent-xw/link", { recursive: true, force: true });
await symlink(realDir, "/tmp/bugent-xw/link");
await run("cwd 是符号链接", "/tmp/bugent-xw/link", "pwd; echo hi > b.txt && echo WROTE");

// 场景 3：工作区内的符号链接指向工作区外
const proj = "/tmp/bugent-xw/proj";
await mkdir(proj, { recursive: true });
await symlink("/etc", `${proj}/etclink`);
await symlink("/home", `${proj}/homelink`);
await run("经 symlink 写 /etc", proj, "echo x > etclink/pwned && echo WROTE || echo BLOCKED");
await run("经 symlink 写 /home", proj, "echo x > homelink/pwned && echo WROTE || echo BLOCKED");
await run("symlink 读 /etc/passwd", proj, "head -1 etclink/passwd");
await run("symlink 删 /etc/passwd", proj, "rm etclink/passwd && echo REMOVED || echo BLOCKED");

// 场景 4：硬链接跨区
await run("硬链接 /etc/hostname", proj, "ln /etc/hostname ./hl && echo LINKED || echo BLOCKED");

// 场景 5：写祖先目录的元数据（改 mtime）
await run("touch 工作区父目录", proj, "touch .. && echo TOUCHED || echo BLOCKED");

// 场景 6：read-only 档下 /tmp 是否仍可写
await run("read-only 档写 /tmp", proj, "echo x > /tmp/ro-probe && echo WROTE || echo BLOCKED", {
  workspaceWrite: false,
});

await rm("/tmp/bugent-xw", { recursive: true, force: true });
