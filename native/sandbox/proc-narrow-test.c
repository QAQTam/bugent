/*
 * /proc 窄化授权的回归验证工具（BUG-005）。
 *
 * 用法：bun run build:sandbox 后
 *   cc -o native/sandbox/build/proc-narrow-test native/sandbox/proc-narrow-test.c \
 *      -Lnative/sandbox/build -lbugent-sandbox -Wl,-rpath,$PWD/native/sandbox/build
 *   native/sandbox/build/proc-narrow-test
 *
 * 预期输出：
 *   self/status:    OK        —— 子进程自己的 proc 条目可读（Bun/JSC 启动探测需要）
 *   parent environ: DENIED    —— 父进程环境变量（含 API key）不可读
 *   parent maps:    DENIED    —— 父进程内存映射不可读
 *
 * 若 "parent environ: LEAKED" 出现，说明 /proc 授权被放宽回了整体放行。
 */

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

void *bun_spawn_sandbox_prepare(const char *config_data, size_t config_len, int *errno_out);
int bun_spawn_sandbox_apply(void *opaque);
void bun_spawn_sandbox_destroy(void *opaque);

int main(int argc, char **argv) {
  const int allow_network = argc > 1 && strcmp(argv[1], "all") == 0;
  const char *config = allow_network
      ? "{\"version\":1,\"kind\":\"bash\",\"read\":[\"/proc\",\"/usr\"],"
        "\"write\":[],\"exec\":[],\"network\":\"all\",\"allow\":[]}"
      : "{\"version\":1,\"kind\":\"bash\",\"read\":[\"/proc\",\"/usr\"],"
        "\"write\":[],\"exec\":[],\"network\":\"none\",\"allow\":[]}";
  int err = 0;

  printf("network mode:   %s\n", allow_network ? "all" : "none");
  fflush(stdout);
  void *state = bun_spawn_sandbox_prepare(config, strlen(config), &err);
  if (state == NULL) {
    fprintf(stderr, "prepare failed: errno=%d (%s)\n", err, strerror(err));
    return 1;
  }

  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    bun_spawn_sandbox_destroy(state);
    return 1;
  }

  if (pid == 0) {
    const int rc = bun_spawn_sandbox_apply(state);
    if (rc != 0) {
      fprintf(stderr, "apply failed: %d\n", rc);
      _exit(9);
    }

    int fd = open("/proc/self/status", O_RDONLY);
    printf("self/status:    %s\n", fd >= 0 ? "OK" : "DENIED");
    if (fd >= 0) close(fd);

    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/environ", getppid());
    fd = open(path, O_RDONLY);
    if (fd >= 0) {
      char probe[16];
      const ssize_t n = read(fd, probe, sizeof(probe));
      printf("parent environ: %s\n", n > 0 ? "LEAKED" : "DENIED");
      close(fd);
    } else {
      printf("parent environ: DENIED (%s)\n", strerror(errno));
    }

    snprintf(path, sizeof(path), "/proc/%d/maps", getppid());
    fd = open(path, O_RDONLY);
    printf("parent maps:    %s\n", fd >= 0 ? "LEAKED" : "DENIED");
    if (fd >= 0) close(fd);

    /*
     * BUG-017：seccomp 进程加固段常开 —— 即使 network=all（本测试的配置
     * 是 none，但断言与模式无关），ptrace 家族也必须被拒绝。
     * process_vm_readv 正常路径对无效 pid 返回 ESRCH，被 filter 拦下时
     * 返回 EPERM —— 用它区分"没装 filter"和"装了"。
     */
    struct iovec local = {0};
    struct iovec remote = {0};
    long rv = syscall(SYS_process_vm_readv, getppid(), &local, 1, &remote, 1, 0);
    printf("process_vm_readv: %s\n",
           rv == -1 && errno == EPERM ? "DENIED" : (rv == -1 ? "UNEXPECTED-ERRNO" : "LEAKED"));

    fflush(stdout);
    _exit(0);
  }

  int status = 0;
  waitpid(pid, &status, 0);
  bun_spawn_sandbox_destroy(state);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
