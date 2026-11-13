// AC-5: five client formats normalize to the same ServerSpec; placeholders and remote entries.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { expandValue } from '#lib/config/expand';
import { candidatePaths, findConfigs, guessClient } from '#lib/config/locate';
import { ConfigError, parseConfigText, stripJsonComments, type ServerSpec } from '#lib/config/parse';
import type { ClientName } from '#lib/timeouts';
import { cleanEnv, CONFIGS, REPO_ROOT, runCli } from './helpers.js';

const ctx = { cwd: REPO_ROOT.replace(/\/$/, ''), env: { HOME: '/home/u' } as NodeJS.ProcessEnv, workspaceFolder: REPO_ROOT.replace(/\/$/, '') };

function load(client: ClientName, file: string, env: NodeJS.ProcessEnv = ctx.env) {
  return parseConfigText(client, readFileSync(join(CONFIGS, file), 'utf8'), file, { ...ctx, env });
}

function core(s: ServerSpec | undefined) {
  assert.ok(s, 'server present');
  return { command: s.command, script: resolve(ctx.cwd, s.cwd ?? '.', s.args[0] ?? ''), fault: s.env.FAULT };
}

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('all five sample configs give the same core ServerSpec for "fixture"', () => {
  const files: Array<[ClientName, string]> = [
    ['claude-desktop', 'claude-desktop.json'],
    ['claude-code', 'claude-code.mcp.json'],
    ['cursor', 'cursor.json'],
    ['vscode', 'vscode.json'],
    ['codex', 'codex.toml'],
  ];
  const expected = { command: 'node', script: join(ctx.cwd, 'fixtures', 'fault-server.mjs'), fault: 'none' };
  for (const [client, file] of files) {
    const parsed = load(client, file);
    const fixture = parsed.servers.find((s) => s.name === 'fixture');
    assert.deepEqual(core(fixture), expected, `${client} ${file}`);
    assert.equal(fixture?.client, client);
    assert.deepEqual(fixture?.unresolved, [], `${client}: nothing unresolved`);
  }
});

test('Codex TOML: env table, env_vars, startup_timeout_sec, cwd, url skipped', () => {
  const parsed = load('codex', 'codex.toml');
  const fixture = parsed.servers.find((s) => s.name === 'fixture');
  assert.equal(fixture?.startupTimeoutMs, 20000);
  assert.deepEqual(fixture?.passThrough, ['MLD_SAMPLE_PASSTHROUGH']);
  assert.deepEqual(fixture?.env, { FAULT: 'none' });
  const slow = parsed.servers.find((s) => s.name === 'slow-start');
  assert.equal(slow?.startupTimeoutMs, 1000);
  assert.equal(slow?.cwd, join(ctx.cwd, 'fixtures'));
  assert.deepEqual(parsed.skipped.map((s) => [s.name, s.reason]), [['remote', 'remote']]);
});

test('VS Code: servers key, ${workspaceFolder}, ${input:} is unresolved, http skipped, comments allowed', () => {
  const parsed = load('vscode', 'vscode.json');
  const fixture = parsed.servers.find((s) => s.name === 'fixture');
  assert.equal(fixture?.args[0], `${ctx.cwd}/fixtures/fault-server.mjs`);
  const input = parsed.servers.find((s) => s.name === 'needs-input');
  assert.deepEqual(input?.unresolved, ['env.API_KEY: ${input:api-key}']);
  assert.deepEqual(parsed.skipped.map((s) => s.name), ['remote']);
});

test('Claude style: ${VAR}, ${VAR:-default}, empty string counts as set, unset is unresolved', () => {
  const unset = load('claude-code', 'claude-code.mcp.json', { HOME: '/h' });
  assert.equal(unset.servers.find((s) => s.name === 'empty-is-set')?.env.MLD_LABEL, 'was-unset');
  const empty = load('claude-code', 'claude-code.mcp.json', { HOME: '/h', MLD_SAMPLE_EMPTY: '' });
  assert.equal(empty.servers.find((s) => s.name === 'empty-is-set')?.env.MLD_LABEL, '', 'empty string is used, default ignored');
  const set = load('claude-desktop', 'claude-desktop.json', { MLD_SAMPLE_FAULT: 'banner' });
  assert.equal(set.servers.find((s) => s.name === 'fixture')?.env.FAULT, 'banner');

  const token = set.servers.find((s) => s.name === 'needs-token');
  assert.deepEqual(token?.unresolved, ['env.API_TOKEN: ${MLD_SAMPLE_UNSET_TOKEN}']);
  assert.deepEqual(set.skipped.map((s) => s.reason), ['remote']);
});

test('expandValue rules', () => {
  const env = { A: 'x', E: '' };
  assert.deepEqual(expandValue('${A}/${B:-d}/${E:-no}', 'claude', { env, workspaceFolder: '/w' }), { value: 'x/d/', unresolved: [] });
  assert.deepEqual(expandValue('${MISSING}', 'claude', { env, workspaceFolder: '/w' }), { value: '${MISSING}', unresolved: ['${MISSING}'] });
  assert.deepEqual(expandValue('${workspaceFolder}/a', 'vscode', { env, workspaceFolder: '/w' }), { value: '/w/a', unresolved: [] });
  assert.deepEqual(expandValue('${A}', 'none', { env, workspaceFolder: '/w' }).unresolved, ['${A}']);
});

test('~/.claude.json: user servers and projects[cwd] servers', () => {
  const text = JSON.stringify({ mcpServers: { u: { command: 'a' } }, projects: { [ctx.cwd]: { mcpServers: { p: { command: 'b' } } }, '/other': { mcpServers: { o: { command: 'c' } } } } });
  const parsed = parseConfigText('claude-code', text, '~/.claude.json', ctx);
  assert.deepEqual(parsed.servers.map((s) => s.name), ['u', 'p']);
});

test('invalid entries are skipped and broken files raise ConfigError', () => {
  const parsed = parseConfigText('cursor', '{"mcpServers":{"x":{"args":[]},"off":{"command":"a","disabled":true}}}', 'f', ctx);
  assert.deepEqual(parsed.skipped.map((s) => [s.name, s.reason]), [['x', 'invalid'], ['off', 'disabled']]);
  assert.throws(() => parseConfigText('cursor', '{nope', 'f', ctx), ConfigError);
  assert.throws(() => parseConfigText('codex', '[[[', 'f', ctx), ConfigError);
});

test('stripJsonComments keeps strings intact', () => {
  const text = '{"a": "http://x//y", /* c */ "b": [1,2,], // tail\n}';
  assert.deepEqual(JSON.parse(stripJsonComments(text)), { a: 'http://x//y', b: [1, 2] });
});

test('config locations per client', () => {
  const lctx = { home: '/home/u', cwd: '/proj', platform: 'linux' as NodeJS.Platform, env: {} };
  assert.deepEqual(candidatePaths('claude-desktop', lctx).map((c) => c.path), ['/home/u/.config/Claude/claude_desktop_config.json']);
  assert.deepEqual(candidatePaths('claude-desktop', { ...lctx, platform: 'darwin' }).map((c) => c.path), ['/home/u/Library/Application Support/Claude/claude_desktop_config.json']);
  assert.deepEqual(candidatePaths('claude-code', lctx).map((c) => c.path), ['/proj/.mcp.json', '/home/u/.claude.json']);
  assert.deepEqual(candidatePaths('vscode', lctx).map((c) => c.path), ['/proj/.vscode/mcp.json']);
  assert.deepEqual(candidatePaths('codex', { ...lctx, env: { CODEX_HOME: '/ch' } }).map((c) => c.path), ['/ch/config.toml']);
  assert.equal(guessClient('/x/config.toml'), 'codex');
  assert.equal(guessClient('/x/.mcp.json'), 'claude-code');

  const home = mkdtempSync(join(tmpdir(), 'mld-home-'));
  dirs.push(home);
  mkdirSync(join(home, '.cursor'));
  writeFileSync(join(home, '.cursor', 'mcp.json'), '{"mcpServers":{}}');
  assert.deepEqual(findConfigs(['cursor', 'codex'], { ...lctx, home, cwd: home }).map((c) => c.client), ['cursor']);
});

test('check --dry-run --json runs nothing and shows startupTimeoutMs 20000', async () => {
  const res = await runCli(['check', '--client', 'codex', '--config', 'fixtures/configs/codex.toml', '--dry-run', '--json'], { env: cleanEnv({ FAULT: 'should-not-matter' }) });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /"dryRun": true/);
  assert.match(res.stdout, /"startupTimeoutMs": 20000/);
  const doc = JSON.parse(res.stdout) as { servers: Array<{ server: string; willLaunch: boolean }>; skipped: unknown[] };
  assert.deepEqual(doc.servers.map((s) => s.server), ['fixture', 'slow-start']);
  assert.equal(doc.skipped.length, 1);
});

test('auto-discovery: a broken file is skipped with a warning, the others are still read', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mld-disc-'));
  dirs.push(home);
  mkdirSync(join(home, '.cursor'));
  writeFileSync(join(home, '.cursor', 'mcp.json'), '{ broken');
  mkdirSync(join(home, 'codex'));
  writeFileSync(join(home, 'codex', 'config.toml'), '[mcp_servers.one]\ncommand = "node"\n');
  const res = await runCli(['check', '--dry-run', '--json', '--lang', 'en'], { cwd: home, env: cleanEnv({ HOME: home, CODEX_HOME: join(home, 'codex') }) });
  assert.equal(res.code, 0);
  assert.match(res.stderr, /warning: skipped .*mcp\.json/);
  const doc = JSON.parse(res.stdout) as { servers: Array<{ server: string; client: string; startupTimeoutMs: number }> };
  assert.deepEqual(doc.servers.map((s) => [s.server, s.client, s.startupTimeoutMs]), [['one', 'codex', 10000]]);
});

test('check with nothing to find exits 2', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mld-empty-'));
  dirs.push(home);
  const res = await runCli(['check', '--dry-run'], { cwd: home, env: cleanEnv({ HOME: home, CODEX_HOME: join(home, 'none') }) });
  assert.equal(res.code, 2);
});

test('check runs unresolved servers as warnings without launching them', async () => {
  const res = await runCli(['check', '--client', 'vscode', '--config', 'fixtures/configs/vscode.json', '--server', 'needs-input', '--json', '--yes']);
  const doc = JSON.parse(res.stdout) as { results: Array<{ launched: boolean; verdict: { kind: string } }> };
  assert.equal(doc.results.length, 1);
  assert.equal(doc.results[0]?.verdict.kind, 'unresolved_variable');
  assert.equal(doc.results[0]?.launched, false);
  assert.equal(res.code, 0, 'a warning does not fail --fail-on error');
});
