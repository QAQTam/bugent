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

The local `bunfig.toml` and `tsconfig.json` exist because buTUI requires:

- `--conditions=browser`;
- `@butui/solid/plugin` preload;
- `jsxImportSource = "@butui/solid"`.

`src/butui` is excluded from the root bugent TypeScript project so the two UI
stacks can be maintained in parallel.
