# @bugent/bun-runtime

Bugent's Bun fork runtime and native sandbox-provider SDK.

This package is intentionally separate from the upstream `@types/bun` package:

- `bin/bugent-bun` is the Bun fork with `Bun.spawn({ sandbox })`.
- `include/bun_spawn_sandbox.h` defines the native provider ABI.
- `src/index.ts` contains the Bugent-facing MCP spawn helpers.
- `types/bun-spawn-sandbox.d.ts` augments Bun's spawn types.

## Runtime resolution

The package resolves the binary in this order:

1. `BUGENT_BUN_BIN`
2. `runtime/bun/bin/bugent-bun`

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
  sandboxLibrary: "/opt/bugent/libbugent-sandbox.so",
  policy: {
    read: [workspace, "/usr", "/lib"],
    write: [],
    network: "none",
  },
});
```

The MCP server still speaks JSON-RPC over stdin/stdout. The sandbox policy is
enforced by the native provider before the server process starts.
