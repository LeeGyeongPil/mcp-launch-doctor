# Changelog

## 0.2.2 - 2026-11-24

### Fixed

- The `wrap` fix snippet (clone and global installs) now adds an `env.PATH` with the wrapped command's folder, its interpreter's folder and the GUI default path when the wrapped command is a bare name found on the shell PATH (such as `node`), so the app can start it. This addresses the 0.1.1 known issue below.

### Known issues

- When the wrapped command is an absolute path to a script that starts with `#!/usr/bin/env node` (or another `#!/usr/bin/env` interpreter), the `wrap` fix snippet still adds no `env.PATH`, so a GUI app may fail with `interpreter_missing` (`env: node: No such file or directory`). Add the interpreter's folder (for example the output of `dirname "$(command -v node)"`) to the entry's `env.PATH` by hand, then confirm with `check --env gui`.

## 0.2.1 - 2026-11-24

### Fixed

- Codex TOML fix snippets now keep the original entry's `cwd`, `env` (secret-looking values shown as `***`) and `env_vars`, so replacing the entry no longer breaks relative paths or drops settings. This resolves the 0.1.1 known issue below.

## 0.2.0 - 2026-11-14

### Added

- `check` now reads the default VS Code user-profile `mcp.json` (macOS `~/Library/Application Support/Code/User/`, Linux `~/.config/Code/User/`, Windows `%APPDATA%\Code\User\`), and `--config` on that file works without `--client`.

### Changed

- A `check` without arguments can find more servers (your global VS Code servers). Pin the result with `--client` or `--config` in CI.

### Fixed

- Korean output: the "client limit unknown, tool default" label is now fully in Korean.

## 0.1.1 - 2026-11-14

### Fixed

- `run` fix snippets now turn relative file arguments (such as `fixtures/fault-server.mjs`) into absolute paths, so a pasted snippet works when the app starts from another folder, and so does a relative `command` path (for example `run -- bin/my-server`).

### Known issues

- The `wrap` fix snippet does not add a `PATH` entry for the wrapped server's interpreter; set one by hand if the app cannot find it.
- Codex TOML fix snippets drop the original entry's `cwd` and `env` keys; copy them over by hand.

## 0.1.0 - 2026-11-13

First release.

- `check`, `run`, `wrap` and `demo` commands.
- Hand-written stdio client with byte-level stdout framing (non-JSON lines, BOM, CRLF, blank lines, invalid UTF-8, partial last line).
- `shell`, `gui` and `sdk` environment profiles; config readers for Claude Desktop, Claude Code, Cursor, VS Code and Codex (TOML).
- Per-client startup limits, retry on timeout to tell `buffering` from `first_run_install`, ready-to-paste fix snippets.
- `--json` output (`schemaVersion: 1`), `--fail-on`, `--dry-run`, English and Korean output.

[0.2.1]: https://github.com/LeeGyeongPil/mcp-launch-doctor/releases/tag/v0.2.1
[0.2.0]: https://github.com/LeeGyeongPil/mcp-launch-doctor/releases/tag/v0.2.0
[0.1.1]: https://github.com/LeeGyeongPil/mcp-launch-doctor/releases/tag/v0.1.1
[0.1.0]: https://github.com/LeeGyeongPil/mcp-launch-doctor/releases/tag/v0.1.0
