# Changelog

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

[0.1.1]: https://github.com/LeeGyeongPil/mcp-launch-doctor/releases/tag/v0.1.1
[0.1.0]: https://github.com/LeeGyeongPil/mcp-launch-doctor/releases/tag/v0.1.0
