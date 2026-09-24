#ifndef BUN_SPAWN_SANDBOX_ABI_H
#define BUN_SPAWN_SANDBOX_ABI_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Bun.spawn({ sandbox: { library, config } }) loads a native provider and calls
 * these symbols in the following order:
 *
 *   1. bun_spawn_sandbox_prepare: parent process, before fork/vfork.
 *   2. bun_spawn_sandbox_apply: child process, after uid/gid setup and final fd
 *      cleanup, immediately before execve.
 *   3. bun_spawn_sandbox_destroy: parent process, after spawn completes.
 *
 * `apply` must be async-signal-safe. On Linux it runs in a vfork child sharing
 * the parent's address space, so it must not allocate, take locks, call
 * dlopen, use stdio, or enter the JavaScript runtime. It must allow the final
 * execve to succeed.
 */

void* bun_spawn_sandbox_prepare(const char* config, size_t config_len, int* errno_out);
int bun_spawn_sandbox_apply(void* state);
void bun_spawn_sandbox_destroy(void* state);

#ifdef __cplusplus
}
#endif

#endif
