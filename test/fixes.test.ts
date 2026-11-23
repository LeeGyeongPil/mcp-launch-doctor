// Regression: `run` fix snippets use absolute paths for relative file arguments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAbsolute, join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import type { ServerSpec } from '#lib/config/parse';
import type { DiagnosisResult, Finding } from '#lib/diagnose';
import { buildFixes, fixArgs, fixCommand } from '#lib/fixes';
import { cleanEnv, NODE_LIMIT_FLAG, REPO_ROOT, runCli } from './helpers.js';

const spec = (args: string[], command = 'node', argBase: string | null = REPO_ROOT): ServerSpec => ({ name: 'x', command, args, env: {}, passThrough: [], source: 'command line', unresolved: [], ...(argBase ? { argBase } : {}) });

function result(finding: Finding): DiagnosisResult {
  return { server: 'x', source: 'command line', profile: 'shell', command: 'node', args: [], launched: true, limit: { ms: 60000 } as DiagnosisResult['limit'], verdict: finding, findings: [finding], timings: {}, retries: [], fixes: [] };
}
const ctx = (self?: { cliPath: string; version: string }) => ({ baseEnv: { PATH: process.env.PATH ?? '' }, platform: process.platform, ...(self ? { self } : {}) }) as Parameters<typeof buildFixes>[2];

test('fixArgs absolutizes only existing relative files', () => {
  const out = fixArgs(spec(['fixtures/fault-server.mjs', 'no/such/file.js', '-y', '/abs/path.js', '--flag=fixtures/fault-server.mjs']));
  assert.ok(isAbsolute(out[0] ?? '') && existsSync(out[0] ?? ''));
  assert.deepEqual(out.slice(1), ['no/such/file.js', '-y', '/abs/path.js', '--flag=fixtures/fault-server.mjs']);
});

test('fixArgs leaves args alone without argBase', () => {
  assert.deepEqual(fixArgs(spec(['fixtures/fault-server.mjs'], 'node', null)), ['fixtures/fault-server.mjs']);
});

test('not_found snippet has an absolute script path', () => {
  const fixes = buildFixes(result({ kind: 'not_found', severity: 'error', data: {} }), spec(['fixtures/fault-server.mjs']), ctx());
  const json = fixes.find((f) => f.format === 'json');
  assert.ok(json?.code, 'expected a json snippet');
  const args = (JSON.parse(json.code) as { mcpServers: { x: { args: string[] } } }).mcpServers.x.args;
  assert.ok(isAbsolute(args[0] ?? '') && existsSync(args[0] ?? ''));
});

test('stdout_pollution wrap snippet (node and npx forms) has an absolute script path', () => {
  const finding: Finding = { kind: 'stdout_pollution', severity: 'error', data: {} };
  for (const cliPath of ['/opt/mld/dist/cli.js', '/srv/npx-cache/_npx/abc/node_modules/mcp-launch-doctor/dist/cli.js']) {
    const fixes = buildFixes(result(finding), spec(['fixtures/fault-server.mjs']), ctx({ cliPath, version: '0.1.1' }));
    const code = fixes.find((f) => f.format === 'json')?.code ?? '';
    const args = (JSON.parse(code) as { mcpServers: { x: { args: string[] } } }).mcpServers.x.args;
    const i = args.indexOf('--');
    assert.equal(args[i + 1], 'node');
    assert.ok(isAbsolute(args[i + 2] ?? ''), `${cliPath}: ${args.join(' ')}`);
  }
});

test('end to end: run wrap snippet carries an absolute path; demo shows no install path', async () => {
  // 넉넉한 --timeout(helpers.ts NODE_LIMIT_MS): stdout_pollution 판정(wrap 고칠 조각)이 node 기동 시간에 흔들리지 않게
  const res = await runCli(['run', '--json', '--env', 'shell', '--timeout', NODE_LIMIT_FLAG, '--', 'env', 'FAULT=banner', 'node', 'fixtures/fault-server.mjs'], { env: cleanEnv() });
  const doc = JSON.parse(res.stdout) as { results: Array<{ fixes?: Array<{ code?: string }> }> };
  const codes = doc.results.flatMap((r) => r.fixes ?? []).map((f) => f.code ?? '').join('\n');
  assert.ok(codes.includes(REPO_ROOT + 'fixtures/fault-server.mjs'), codes);
  const demo = await runCli(['demo', '--json']);
  // the wrap snippet names this tool's own dist/cli.js, but the fixture itself stays a bare file name
  assert.ok(!demo.stdout.includes(REPO_ROOT + 'fixtures'), 'demo must not print the fixtures install path');
  assert.match(demo.stdout, /"fault-server\.mjs"/);
});

test('fixCommand absolutizes an existing relative command path, keeps bare names', () => {
  const out = fixCommand(spec([], 'fixtures/fault-server.mjs'));
  assert.ok(isAbsolute(out) && existsSync(out));
  assert.equal(fixCommand(spec([], 'node')), 'node');
  assert.equal(fixCommand(spec([], 'bin/no-such-server')), 'bin/no-such-server');
  assert.equal(fixCommand(spec([], 'fixtures/fault-server.mjs', null)), 'fixtures/fault-server.mjs');
});

test('interpreter_missing snippet keeps command absolute for a relative script', () => {
  const finding: Finding = { kind: 'interpreter_missing', severity: 'error', data: { interpreter: 'node' } };
  const fixes = buildFixes(result(finding), spec([], 'fixtures/fault-server.mjs'), ctx());
  const code = fixes.find((f) => f.format === 'json')?.code ?? '';
  const command = (JSON.parse(code) as { mcpServers: { x: { command: string } } }).mcpServers.x.command;
  assert.ok(isAbsolute(command) && existsSync(command), command);
});

// ---- Codex TOML snippets keep cwd / env / env_vars (the entry is replaced as a whole) ----

const codexSpec = (extra: Partial<ServerSpec> = {}): ServerSpec => ({ client: 'codex', name: 'srv', command: 'node', args: ['s.mjs'], env: {}, passThrough: [], source: 'config.toml', unresolved: [], ...extra });
const timeoutResult = () => result({ kind: 'startup_timeout', severity: 'error', cause: 'unknown', data: {} });

test('Codex fix snippet keeps cwd, env and env_vars of the original entry', () => {
  const s = codexSpec({ cwd: '/work/fixtures', env: { FAULT: 'slow', SLOW_MS: '2000' }, passThrough: ['MY_VAR'] });
  const code = buildFixes(timeoutResult(), s, ctx()).find((f) => f.format === 'toml')?.code ?? '';
  const parsed = parseToml(code) as { mcp_servers: Record<string, Record<string, unknown>> };
  const entry = parsed.mcp_servers.srv;
  assert.equal(entry?.cwd, '/work/fixtures');
  assert.deepEqual({ ...(entry?.env as object) }, { FAULT: 'slow', SLOW_MS: '2000' });
  assert.deepEqual(entry?.env_vars, ['MY_VAR']);
  assert.equal(entry?.startup_timeout_sec, 180);
  assert.match(code, /\[mcp_servers\.srv\.env\]/);
});

test('Codex fix snippet merges patch.env over the original env and masks secret names', () => {
  const s = codexSpec({ env: { FAULT: 'slow', PATH: '/old', API_TOKEN: 'abc123' } });
  const fixes = buildFixes(result({ kind: 'startup_timeout', severity: 'error', cause: 'buffering', data: {} }), { ...s, command: 'python3' }, ctx());
  const entry = (parseToml(fixes.find((f) => f.format === 'toml')?.code ?? '') as { mcp_servers: Record<string, Record<string, Record<string, string>>> }).mcp_servers.srv;
  assert.equal(entry?.env?.PYTHONUNBUFFERED, '1');
  assert.equal(entry?.env?.FAULT, 'slow');
  assert.equal(entry?.env?.PATH, '/old');
  assert.equal(entry?.env?.API_TOKEN, '***');
});

test('Codex fix snippet without cwd or env stays minimal; JSON snippets are unchanged', () => {
  const code = buildFixes(timeoutResult(), codexSpec(), ctx()).find((f) => f.format === 'toml')?.code ?? '';
  assert.ok(!/cwd|env/.test(code));
  const json = buildFixes(result({ kind: 'npx_prompt_risk', severity: 'warn', data: {} }), { ...codexSpec({ client: 'cursor', cwd: '/x', env: { A: 'b' } }), command: 'npx' }, ctx()).find((f) => f.format === 'json')?.code ?? '';
  assert.ok(!json.includes('"cwd"') && !json.includes('"A"'));
});

test('check --client codex on the sample config: the slow-start snippet restarts the same server (cwd + env)', async () => {
  const res = await runCli(['check', '--client', 'codex', '--config', 'fixtures/configs/codex.toml', '--server', 'slow-start', '--env', 'shell', '--json']);
  const out = JSON.parse(res.stdout) as { results: Array<{ fixes: Array<{ format: string; code?: string }> }> };
  const code = out.results[0]?.fixes.find((f) => f.format === 'toml')?.code ?? '';
  assert.match(code, /cwd = ".*fixtures"/);
  assert.match(code, /\[mcp_servers\.slow-start\.env\]/);
  assert.match(code, /FAULT = "slow"/);
  assert.match(code, /SLOW_MS = "2000"/);
  // 조각만으로 만든 설정을 다시 진단하면 서버가 뜬다 (AC b)
  const dir = mkdtempSync(join(tmpdir(), 'mld-fix-'));
  try {
    const file = join(dir, 'fixed.toml');
    writeFileSync(file, code);
    const again = await runCli(['check', '--client', 'codex', '--config', file, '--env', 'shell', '--json']);
    const verdict = (JSON.parse(again.stdout) as { results: Array<{ verdict: { kind: string } }> }).results[0]?.verdict.kind;
    assert.equal(verdict, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
