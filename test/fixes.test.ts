// Regression: `run` fix snippets use absolute paths for relative file arguments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAbsolute, join } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import type { ServerSpec } from '#lib/config/parse';
import type { DiagnosisResult, Finding } from '#lib/diagnose';
import { guiDefaultPath } from '#lib/envProfiles';
import { buildFixes, findForFix, fixArgs, fixCommand } from '#lib/fixes';
import { cleanEnv, FIXTURE, NODE_LIMIT_FLAG, REPO_ROOT, runCli } from './helpers.js';

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

test('wrap snippet for a bare command carries env.PATH with its folder and the gui default path (JSON and Codex TOML)', () => {
  const finding: Finding = { kind: 'stdout_pollution', severity: 'error', data: {} };
  const nodeDir = join(process.execPath, '..');
  const c = { baseEnv: { PATH: nodeDir }, platform: 'darwin', self: { cliPath: '/opt/mld/dist/cli.js', version: '0.2.1' } } as Parameters<typeof buildFixes>[2];
  const json = buildFixes(result(finding), spec(['fixtures/fault-server.mjs']), c).find((f) => f.format === 'json')?.code ?? '';
  const envPath = (JSON.parse(json) as { mcpServers: { x: { env: { PATH: string } } } }).mcpServers.x.env.PATH;
  assert.ok(envPath.split(':').includes(nodeDir), envPath);
  assert.ok(envPath.split(':').includes('/usr/bin'), envPath);
  const codex = { ...spec(['fixtures/fault-server.mjs']), client: 'codex', cwd: '/work', env: { FOO: 'bar' }, passThrough: ['HOME'] } as ServerSpec;
  const toml = parseToml(buildFixes(result(finding), codex, c).find((f) => f.format === 'toml')?.code ?? '') as { mcp_servers: { x: { cwd: string; env: Record<string, string>; env_vars: string[] } } };
  assert.equal(toml.mcp_servers.x.cwd, '/work');
  assert.equal(toml.mcp_servers.x.env.FOO, 'bar');
  assert.ok(toml.mcp_servers.x.env.PATH?.includes(nodeDir));
  assert.deepEqual(toml.mcp_servers.x.env_vars, ['HOME']);
});

test('wrap snippet from a stdout_pollution run starts under the gui profile; without env.PATH it does not', { skip: process.platform === 'win32' }, async () => {
  const run = await runCli(['run', '--json', '--timeout', NODE_LIMIT_FLAG, '--', 'node', FIXTURE], { env: cleanEnv({ FAULT: 'banner' }) });
  const doc = JSON.parse(run.stdout) as { results: Array<{ verdict: { kind: string }; fixes: Array<{ forKind: string; format: string; code?: string }> }> };
  assert.equal(doc.results[0]?.verdict.kind, 'stdout_pollution');
  const code = doc.results[0]?.fixes.find((f) => f.forKind === 'stdout_pollution' && f.format === 'json')?.code ?? '';
  type Entry = { command: string; args: string[]; env?: Record<string, string> };
  const snippet = JSON.parse(code) as { mcpServers: Record<string, Entry> };
  const name = Object.keys(snippet.mcpServers)[0] ?? '';
  const entry = snippet.mcpServers[name] as Entry;
  assert.ok(entry.env?.PATH, 'the snippet carries env.PATH');
  const dir = mkdtempSync(join(tmpdir(), 'mld-wrap-gui-'));
  const verdictFor = async (env: Record<string, string>): Promise<{ kind: string; code?: string }> => {
    const file = join(dir, `claude_desktop_config.${Object.keys(env).length}.json`);
    writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { ...entry, env } } }));
    const res = await runCli(['check', '--client', 'claude-desktop', '--config', file, '--env', 'gui', '--json', '--timeout', NODE_LIMIT_FLAG], { env: cleanEnv() });
    return (JSON.parse(res.stdout) as { results: Array<{ verdict: { kind: string } }> }).results[0]?.verdict ?? { kind: 'none' };
  };
  try {
    // 조각 그대로(+ 서버 결함 FAULT): 앱의 기본 PATH 에서도 안쪽 node 를 찾아 wrap 이 뜬다
    assert.equal((await verdictFor({ ...entry.env, FAULT: 'banner' })).kind, 'ok');
    // env.PATH 를 뺀 대조: 앱 기본 PATH 에서 node 를 못 찾는 컴퓨터에서만 실패해야 한다
    // (리눅스 CI 러너처럼 /usr/local/bin 에 다른 node 가 따로 있으면 그 node 로 wrap 이 떠서 ok 가 된다)
    if (!findForFix('node', guiDefaultPath(process.platform) ?? '')) {
      assert.notEqual((await verdictFor({ FAULT: 'banner' })).kind, 'ok');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
