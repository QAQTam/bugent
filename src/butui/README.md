# bugent × buTUI experiment

This directory is an isolated experimental UI entry. It does not replace the
default `src/tui` implementation and must not share terminal lifecycle with it.

Run:

```bash
# real configured provider/session/tools
bun run butui

# no-key smoke path
bun run butui -- --mock

# bypass permission prompts
bun run butui -- --yes

# both
bun run butui -- --mock --yes
```

Minimal working state:

- real bugent config/provider resolution;
- `AgentSession` + `runUserTurn`;
- real `ToolRegistry`;
- ledger-backed `StreamWindow` transcript with file spill/retention;
- automatic bottom follow, PgUp/PgDn, and controller-driven redraw;
- streaming assistant text and tool summaries;
- live `apply_patch` Diff cards;
- permission, mode-escalation, and network prompts in a focus-trapped Modal;
- `Esc` aborts the current turn;
- `Ctrl+C` restores the terminal and exits.

Not yet wired:

- bugent branch / retry / undo;
- MCP context panel;
- ask_user multi-page forms;
- session persistence in this experimental entry.

## v0.2 runtime tuning

The validation entry now opts into a conservative v0.2 experimental slice:

- `render: { mode: "frame", fps: 120, adaptiveQuality: true }`
- `inputRouting: "presented"`
- `waitUntilFrameFlushed(undefined, "accepted")` after each turn

This reduces terminal writes under high-frequency streaming, routes mouse
selection against the frame the user actually saw, and gives the turn a stable
paint boundary. The transcript deliberately does not stack `smooth` on top of
`frame` mode; buTUI documents that combination as swallowing reveal frames.
Set `BUGENT_BUTUI_V02=0` to compare against the v0.1 `microtask + logical`
behavior.

The transcript is projected through `StreamLedger` + `StreamWindow`; stable
history can spill to `~/.bugent/butui/<session>/`. The experimental entry keeps
the sidecars during the process and attempts cleanup on normal disposal.

The sibling checkout is anchored to `QAQTam/buTUI@v0.2.2-exp`
(`7d83210`, `fix(stream): reset smooth when window lines are replaced`). It is
not referenced through a GitHub package URL because `@butui/*` packages are
still private workspace packages inside a monorepo; a repository-level git
dependency cannot resolve those subpackages reliably.

The local `bunfig.toml` and `tsconfig.json` exist because buTUI requires:

- `--conditions=browser`;
- `@butui/solid/plugin` preload;
- `jsxImportSource = "@butui/solid"`.

`src/butui` is excluded from the root bugent TypeScript project so the two UI
stacks can be maintained in parallel.
