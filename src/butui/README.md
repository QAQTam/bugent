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
- permission and mode-escalation prompts (`y` / `n` / `Esc`);
- network capability prompts;
- streamed assistant text;
- tool call/result messages;
- `Esc` aborts the current turn;
- `Ctrl+C` restores the terminal and exits.

Not yet wired:

- bugent branch / retry / undo;
- MCP context panel;
- rich tool diffs and artifacts;
- ask_user multi-page forms;
- session persistence in this experimental entry.

## v0.2 runtime tuning

The validation entry now opts into a conservative v0.2 experimental slice:

- `render: { mode: "frame", fps: 120, adaptiveQuality: true }`
- `inputRouting: "presented"`
- `waitUntilFrameFlushed(undefined, "accepted")` after each turn

This reduces terminal writes under high-frequency streaming, routes mouse
selection against the frame the user actually saw, and gives the turn a stable
paint boundary. Set `BUGENT_BUTUI_V02=0` to compare against the v0.1
`microtask + logical` behavior.

The sibling checkout is anchored to `QAQTam/buTUI@v0.2.0-exp`
(`7896dab`, `fix(layout): isolate stream tail cache from committed lines`). It
is not referenced through a GitHub package URL because `@butui/*` packages are
still private workspace packages inside a monorepo; a repository-level git
dependency cannot resolve those subpackages reliably.

The local `bunfig.toml` and `tsconfig.json` exist because buTUI requires:

- `--conditions=browser`;
- `@butui/solid/plugin` preload;
- `jsxImportSource = "@butui/solid"`.

`src/butui` is excluded from the root bugent TypeScript project so the two UI
stacks can be maintained in parallel.
