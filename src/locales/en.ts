// English messages. Keys must match src/locales/ko.ts exactly (the compiler and test/i18n.test.ts check).
// Placeholders look like {name}. Verdict kinds and JSON keys are never translated.

export const en = {
  'help': `mcp-launch-doctor {version} — launch stdio MCP servers the way your apps do and see why they fail.

Usage:
  mcp-launch-doctor check [options]                       diagnose the servers in your client config files
  mcp-launch-doctor run [options] -- <command> [args...]  diagnose one server command (handy in CI)
  mcp-launch-doctor wrap -- <command> [args...]           run a server, moving non-JSON-RPC stdout lines to stderr
  mcp-launch-doctor demo [--json] [--lang <lang>]         practice run against bundled mock servers

Options:
  --client <name>     {clients}, or all (check default: all; run: limits and fix format of that client)
  --config <path>     read this config file instead of the default locations (.toml = codex)
  --server <name>     only check this server
  --env <profiles>    {profiles}, comma separated, or all (check default: gui,shell; run default: shell)
  --timeout <ms>      startup limit for every server, overrides the client limits
  --no-retry          do not retry a timeout to find its cause
  --dry-run           show what would be launched and launch nothing
  --yes               do not ask before launching (check)
  --json              machine-readable output (schemaVersion 1)
  --fail-on <level>   {failOn} (default: error)
  --lang <lang>       {langs} (also MCP_LAUNCH_DOCTOR_LANG, LC_ALL, LC_MESSAGES, LANG)
  -h, --help          show this help
  -v, --version       show the version

Exit codes: 0 passed, 1 findings at or above --fail-on, 2 usage or config error.
Safety: check and run start the commands written in your config. Use --dry-run first if unsure.`,

  'err.unknown_command': 'Unknown command "{command}". Commands: {commands}.',
  'err.unexpected_argument': 'Unexpected argument "{value}". Put the server command after "--".',
  'err.help_hint': 'Help: mcp-launch-doctor --help',
  'err.bad_option': '{message}',
  'err.unknown_option': 'Unknown option "{option}".',
  'err.option_value': 'Option {option} needs a value.',
  'err.no_servers_in_config': 'No stdio servers in {path} (expected the key mcpServers, servers or [mcp_servers.*]).',
  'fix.masked_note': 'Values shown as *** are masked: keep your existing value there.',
  'err.bad_choice': 'Invalid value "{value}" for {option}. Choose one of: {choices}.',
  'err.missing_command': 'Give the server command after "--", for example: mcp-launch-doctor {sub} -- node server.js',
  'err.bad_timeout': 'Invalid --timeout "{value}". Use a positive number of milliseconds.',
  'err.config_parse': 'Could not read {source}: {message}',
  'err.config_missing': 'Config file not found: {path}',
  'err.client_required': 'Cannot tell which client "{path}" belongs to. Add --client ({clients}).',
  'err.no_configs': 'No stdio MCP servers found in the default config locations of: {clients}. Use --config <path> --client <name>.',
  'err.no_server_match': 'No stdio server named "{name}" in the config files.',
  'warn.config_skipped': 'warning: skipped {source}: {message}',

  'demo.notice': 'Practice mode: these are bundled practice fixtures (mock servers), not real MCP servers. Each one breaks the stdio rules on purpose.',
  'demo.next': 'Next: mcp-launch-doctor check  (diagnoses the servers in your own config files)',

  'table.server': 'SERVER',
  'table.env': 'ENV',
  'table.result': 'RESULT',
  'table.time': 'FIRST ANSWER',
  'table.tools': 'TOOLS',
  'summary': 'Summary: {ok} ok, {warn} warning, {error} error ({total} run(s)).',
  'progress': 'checking {server} [{profile}] ...',

  'confirm.header': 'mcp-launch-doctor will start these {count} command(s) exactly as written in your config:',
  'confirm.question': 'Run them now? [y/N] ',
  'confirm.aborted': 'Cancelled. Nothing was launched.',

  'dryrun.header': 'Dry run — nothing is launched. Servers found:',
  'dryrun.limit': 'startup limit',
  'dryrun.not_launched': 'would NOT be launched',
  'skipped.header': 'Skipped:',
  'skipped.remote': '{name} ({client}): not a stdio server ({detail})',
  'skipped.disabled': '{name} ({client}): disabled in the config',
  'skipped.invalid': '{name} ({client}): invalid entry (missing "command")',

  'section.details': 'Details for {server} [{profile}]',
  'section.fix': 'Fix',
  'section.stderr': 'stderr (last lines, secrets masked):',
  'section.source': 'config: {source}',

  'limit.flag': '--timeout',
  'limit.config': '{client} config',
  'limit.client_default': '{client} default',
  'limit.env': 'MCP_TIMEOUT',
  'limit.tool_default': 'client limit unknown, tool default',
  'limit.demo': 'practice limit',

  'phase.initialize': 'initialize',
  'phase.tools/list': 'tools/list',
  'phase.after_handshake': 'after the handshake',

  'verdict.ok': 'Handshake OK: {name} {version} speaks {protocol}, answered initialize in {initMs} ms, {tools} tool(s).',
  'verdict.not_found': 'Command not found: "{command}" ({errno}). With this PATH the app cannot start it.',
  'verdict.not_found_cwd': 'Working directory does not exist: {path}',
  'verdict.interpreter_missing': 'The command was found but its interpreter "{interpreter}" is not on PATH (exit {code}). A script starting with #!/usr/bin/env {interpreter} needs it on PATH, even when the command itself is an absolute path.',
  'verdict.early_exit': 'The server exited (code {code}) during {phase} before the handshake finished. The stderr tail below usually says why.',
  'verdict.startup_timeout': 'No answer to {phase} within {limitMs} ms ({limitLabel}).',
  'verdict.protocol_error_id': 'A response came back with id {ids}, which matches no request. The response id must equal the request id exactly.',
  'verdict.protocol_error_init': 'initialize returned an error: {message} (code {code}).',
  'verdict.protocol_error_noversion': 'The initialize result has no protocolVersion.',
  'verdict.protocol_error_tools': 'tools/list returned an error: {message} (code {code}).',
  'verdict.version_mismatch': 'The server answered protocolVersion {got}; current clients accept {supported} and disconnect otherwise.',
  'verdict.stdout_pollution': '{count} stdout line(s) are not JSON-RPC. stdout may carry MCP messages only; write logs to stderr.',
  'verdict.framing_warning': 'Framing problems: {details}. Some clients reject or drop these lines.',
  'verdict.unresolved_variable': 'Not launched: these placeholders could not be resolved: {placeholders}.',
  'verdict.npx_prompt_risk': 'npx without -y can stop at an "Ok to proceed?" install prompt.',
  'verdict.slow_start': 'The first answer took {initMs} ms, more than half of the {limitMs} ms limit ({limitLabel}).',
  'verdict.unsupported': 'This environment profile is not supported on {platform} yet; only shell is.',

  'framing.bom': 'byte order mark ×{n}',
  'framing.crlf': 'CRLF line ending ×{n}',
  'framing.blank': 'blank line ×{n}',
  'framing.invalid_utf8': 'invalid UTF-8 ×{n}',
  'framing.partial': 'last line without newline (partial_line) ×{n}',
  'lines.item': 'line {line} @ byte {offset} [{kind}{flags}] {preview}',

  'cause.buffering': 'Cause: output buffering — with PYTHONUNBUFFERED=1 the same server answered in {ms} ms.',
  'cause.first_run_install': 'Cause: first-run install — running the same command again answered in {ms} ms.',
  'cause.unknown': 'Cause: unknown (no retry helped, or retries were off).',

  'fix.not_found': 'Use the absolute path ({absolute}) and give the server a PATH that includes its folder. Merge into your existing entry:',
  'fix.not_found_script': 'Use the absolute path ({absolute}) and give the server a PATH that also holds "{interpreter}": the file starts with #!/usr/bin/env {interpreter}, so changing only the command fails again. Merge into your existing entry:',
  'fix.not_found_anywhere': '"{command}" is not on your shell PATH either. Install it, or use the full path to it.',
  'fix.cwd_missing': 'Create {path} or fix "cwd" in the config.',
  'fix.interpreter_missing': 'Add the folder of "{interpreter}" ({absolute}) to the server env PATH. Merge into your existing entry (keep your other env values):',
  'fix.buffering': 'Turn off Python output buffering (or run python3 -u). Merge into your existing entry:',
  'fix.first_run_codex': 'The first launch downloads the package. Give Codex more time, or install the package once beforehand:',
  'fix.timeout_codex': 'Give Codex more time to start this server:',
  'fix.first_run_claude_code': 'The first launch downloads the package. Start Claude Code with a longer limit, or install the package once beforehand:',
  'fix.timeout_claude_code': 'Start Claude Code with a longer startup limit:',
  'fix.first_run_generic': 'The first launch downloads the package. Install it once beforehand (for example npm install -g <package>) and point the config at the installed command.',
  'fix.timeout_generic': 'The server did not answer within {limitMs} ms. Check the stderr tail and make it answer initialize sooner (do slow setup after the handshake), or raise the client startup limit if it has one.',
  'fix.wrap': 'Best fix: make the server write logs to stderr. Until then, put wrap in front of the command — it passes only JSON-RPC lines to stdout and moves the rest to stderr:',
  'fix.wrap_npx': 'Best fix: make the server write logs to stderr. Until then, put wrap in front of the command — it passes only JSON-RPC lines to stdout and moves the rest to stderr. You ran this tool through npx, and its npx cache folder can be deleted at any time, so the entry starts wrap with npx and a pinned version ({version}). For a fixed file path instead, install it once with npm i -g mcp-launch-doctor and run the check again:',
  'fix.npx_yes': 'Add -y so npx never waits for an install prompt:',
  'fix.version': 'Update the server (or its MCP SDK) so it answers a current protocol version instead of {got}.',
  'fix.early_exit': 'Fix what stderr reports (often a missing env value or dependency) and run again.',
  'fix.unresolved': 'Set the variables in your shell, or replace the placeholders. ${input:...} and envFile are not read by mcp-launch-doctor yet.',
  'fix.framing': 'Write each message as one UTF-8 line ending in \\n only: no BOM, no \\r, no blank lines.',

  'retry.rerun': 'retry (same command again): {result}',
  'retry.unbuffered': 'retry (PYTHONUNBUFFERED=1): {result}',
  'retry.ok': 'answered in {ms} ms',
  'retry.failed': 'still no answer',

  'wrap.spawn_failed': '[wrap] could not start {command}: {message}',
} as const;

export type MessageKey = keyof typeof en;
