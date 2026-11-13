# Changelog

## 0.1.0 - 2026-11-13

First release.

- `check`, `run`, `wrap` and `demo` commands.
- Hand-written stdio client with byte-level stdout framing (non-JSON lines, BOM, CRLF, blank lines, invalid UTF-8, partial last line).
- `shell`, `gui` and `sdk` environment profiles; config readers for Claude Desktop, Claude Code, Cursor, VS Code and Codex (TOML).
- Per-client startup limits, retry on timeout to tell `buffering` from `first_run_install`, ready-to-paste fix snippets.
- `--json` output (`schemaVersion: 1`), `--fail-on`, `--dry-run`, English and Korean output.

[0.1.0]: https://github.com/LeeGyeongPil/mcp-launch-doctor/releases/tag/v0.1.0
