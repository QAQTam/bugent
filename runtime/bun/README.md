# @bugent/bun-runtime

Bugent's Bun fork runtime and native sandbox-provider SDK.

This package is intentionally separate from the upstream `@types/bun` package:

- `bin/bugent-bun` is the Bun fork with `Bun.spawn({ sandbox })`.
- `lib/libbugent-sandbox.so` is the Linux Landlock/seccomp provider.
- `include/bun_spawn_sandbox.h` defines the native provider ABI.
- `src/index.ts` contains the Bugent-facing MCP spawn helpers.
- `types/bun-spawn-sandbox.d.ts` augments Bun's spawn types.

## Runtime resolution

The package resolves the binary in this order:

1. `BUGENT_BUN_BIN`
2. `runtime/bun/bin/bugent-bun`

Install the current checkout's fork with:

```bash
bun run runtime:install
# optional: replace ~/.bun/bin/bun after backing it up
bun run runtime:install -- --global
```

`--global` keeps the previous runtime as `bun-upstream-<version>` and creates
`bugent-bun` as an alias. The runtime check also accepts a byte-identical copy
of the installed fork, so a global copy is valid even though its path differs.

The packaged artifact places the binary in `bin/bugent-bun`.

## Native provider ABI

```c
void* bun_spawn_sandbox_prepare(const char* config, size_t config_len, int* errno_out);
int bun_spawn_sandbox_apply(void* state);
void bun_spawn_sandbox_destroy(void* state);
```

`prepare` runs in the Bun parent process. `apply` runs in the child immediately
before `execve` and must be async-signal-safe. `destroy` runs in the parent
after the spawn completes.

## MCP usage

```ts
import { spawnMcpServer } from "@bugent/bun-runtime";

const server = spawnMcpServer({
  cmd: ["npx", "-y", "@modelcontextprotocol/server-filesystem", workspace],
  cwd: workspace,
  sandboxLibrary: "/opt/bugent/lib/libbugent-sandbox.so",
  policy: {
    read: [workspace, "/usr", "/proc"],
    write: [],
    exec: ["/usr"],
    network: "none",
  },
});
```

For Bun-based MCP servers, `/proc` read is currently required by JSC
startup. The high-level policy compiler in `src/sandbox/policy.ts` adds it
automatically together with a private writable state directory and sanitized
environment.

The MCP server still speaks JSON-RPC over stdin/stdout. The sandbox policy is
enforced by the native provider before the server process starts.
