#ifndef BUGENT_BUN_SPAWN_SANDBOX_H
#define BUGENT_BUN_SPAWN_SANDBOX_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Bugent's Bun fork calls these symbols when Bun.spawn is given:
 *
 *   sandbox: { library: "<path>", config: "<utf8>" }
 *
 * prepare runs in the Bun parent process before fork/vfork.
 * apply runs in the child immediately before execve.
 * destroy runs in the parent after spawn completes.
 *
 * apply must be async-signal-safe. On Linux it runs in a vfork child sharing
 * the parent's address space: no allocation, locks, dlopen, stdio, or JS.
 */
void* bun_spawn_sandbox_prepare(const char* config, size_t config_len, int* errno_out);
int bun_spawn_sandbox_apply(void* state);
void bun_spawn_sandbox_destroy(void* state);

#ifdef __cplusplus
}
#endif

#endif
