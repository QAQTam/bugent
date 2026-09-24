# libbugent-sandbox

Linux native sandbox provider for the Bugent Bun fork ABI:

```c
void* bun_spawn_sandbox_prepare(const char* config, size_t config_len, int* errno_out);
int   bun_spawn_sandbox_apply(void* state);
void  bun_spawn_sandbox_destroy(void* state);
```

Build:

```bash
bun run build:sandbox
```

The output is `native/sandbox/build/libbugent-sandbox.so`.

## Policy

`prepare` parses and validates the policy, creates a Landlock ruleset, opens
path rules, and builds the seccomp program. `apply` runs in the spawned child
and only performs syscalls:

- `PR_SET_NO_NEW_PRIVS`;
- `landlock_restrict_self`;
- seccomp network filter when `network` is `none`;
- optional `prlimit64` resource limits;
- `close_range(3, ~0, CLOSE_RANGE_UNSHARE)` so only stdio survives.

The filesystem is deny-by-default. Paths listed in `read`, `write`, and `exec`
are the only paths granted to the child. A `write` rule also grants read access.
Execute rules are directory grants because Landlock may deny `execve` before a
final-file rule is consulted; the policy compiler adds runtime roots explicitly.

Network modes:

- `none`: seccomp denies socket/connect/accept/send/recv and `io_uring_setup`;
- `all`: no network restriction;
- `allowlist`: rejected by this provider. Domain allowlisting requires a proxy
  or a network namespace with an egress proxy; silently treating it as `all`
  would be a security bug.

`apply` is intentionally allocation-free and lock-free. Do not add logging,
`dlopen`, `malloc`, stdio, or JavaScript calls there.
