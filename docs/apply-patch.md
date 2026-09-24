# apply_patch Compatibility

bugent implements a Codex-compatible `apply_patch` format.

## Grammar

```text
*** Begin Patch
*** Add File: path
+line

*** Delete File: path

*** Update File: path
*** Move to: new-path
@@ context
-old line
+new line
 context line
*** End of File
*** End Patch
```

## Matching

Update hunks use the same matching ladder as Codex:

1. exact line sequence;
2. ignore trailing whitespace;
3. ignore leading and trailing whitespace;
4. normalize common Unicode dashes, quotes and spaces.

`*** End of File` prefers an end-of-file match.

## Application

- All hunks are parsed and staged before any write.
- Context mismatch rejects the entire patch.
- Paths are constrained to the session workspace.
- Writes preserve existing file mode where possible.
- Binary files are rejected.
- `WorkspaceFileEdit` is emitted for every affected path, so undo/replay uses
  the existing workspace transaction system.
- Update line endings can be normalized to LF or preserved.

## Intentionally Not Ported Yet

- Codex exec-server / PathUri integration;
- shell/heredoc invocation parsing beyond lenient wrapper support;
- multi-environment IDs;
- Codex partial-prefix commit semantics;
- streaming `+N -M` UI events.

bugent deliberately uses stricter all-or-nothing workspace application.
