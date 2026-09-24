# Subagent v1 Closure

> Status: **frozen**  
> Implementation baseline: `9e20835`  
> Closure scope: local in-process subagents with Git-only isolated workers

## 1. Included

- `AgentKind / AgentAuthority / AgentCapability`
- `AgentSupervisor / AgentHandle / AgentEventBus`
- `InProcessTransport`
- read-only reviewer / explorer executor
- safe-boundary completion notifications
- Git capability probe
- Git worktree worker executor
- worker patch artifact
- model-facing subagent control tools
- deterministic patch integrator
- post-apply verification and automatic rollback
- audit and Goal Evidence persistence

## 2. Acceptance

Accepted behavior:

1. reviewer/explorer use fresh sessions and read-only tools.
2. worker runs only in a Git worktree and never writes the main workspace.
3. missing Git, non-Git repository, missing HEAD, or dirty workspace fails closed.
4. read-only sessions cannot create workers.
5. child authority and capabilities cannot exceed the parent.
6. completion notifications are developer injections at safe boundaries.
7. worker patches require ownership, digest, clean workspace and base revision checks.
8. verification failure reverses the patch and confirms a clean workspace.
9. successful integrations write audit and Goal Evidence.
10. rolled-back or failed integrations do not write Goal completion Evidence.

Verification performed:

```text
bun run typecheck                         pass
focused subagent/goal/runtime tests        pass
HOME=/tmp/bugent-test-home bun test        587 pass / 19 environment failures
git diff --check                          pass
```

The 19 failures are accepted only as environment limitations:

- local HTTP listener unavailable;
- nested bwrap unavailable;
- sandboxed local-network tests unavailable.

Any additional failure is not covered by this closure.

## 3. Explicit Non-Goals

The following are backlog items, not unfinished work in this checkpoint:

- ACP transport
- gix or libgit2 backend
- MCP per-agent grants
- Windows/macOS native sandbox
- copy-snapshot fallback
- shared-write workers
- automatic Git installation
- automatic patch apply or merge
- recursive subagent spawning
- additional AgentKind values
- new TUI/UX work
- unrelated provider/session configuration changes

## 4. Stop Rule

After this checkpoint, only P0/P1 fixes are allowed:

- security bypass;
- main workspace or data corruption;
- tool-call protocol corruption;
- broken primary flow;
- worktree/process leak;
- rollback failure;
- regression introduced by this implementation.

All P2/P3 work, optimizations, compatibility expansion and new features require
a new explicit objective. The Subagent v1 work must not continue by default.
