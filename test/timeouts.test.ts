// AC-6: startup limits per client, judged against the real fixture (the slow_start pair uses a shell stub, see below).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseConfigText, type ServerSpec } from '#lib/config/parse';
import { diagnoseServer } from '#lib/diagnose';
import { describe as describeFinding } from '#lib/report';
import { CODEX_DEFAULT_STARTUP_MS, resolveStartupLimit, TOOL_DEFAULT_TIMEOUT_MS } from '#lib/timeouts';
import { cleanEnv, CONFIGS, FIXTURE, REPO_ROOT, writeShellServer } from './helpers.js';

// 셸 스크립트 서버를 쓰는 테스트는 POSIX 전용(CI 는 ubuntu·macos 라 둘 다 실제로 돈다)
const posix = process.platform !== 'win32';

test('Codex without startup_timeout_sec uses 10000 ms with its source', () => {
  const limit = resolveStartupLimit({ client: 'codex', env: {} });
  assert.equal(limit.ms, CODEX_DEFAULT_STARTUP_MS);
  assert.equal(limit.ms, 10000);
  assert.equal(limit.source, 'client_default');
  assert.equal(limit.known, true);
  assert.match(limit.ref ?? '', /learn\.chatgpt\.com/);
});

test('Claude Code uses MCP_TIMEOUT, otherwise the tool default labeled unknown', () => {
  const withEnv = resolveStartupLimit({ client: 'claude-code', env: { MCP_TIMEOUT: '45000' } });
  assert.deepEqual([withEnv.ms, withEnv.source, withEnv.known], [45000, 'env', true]);
  const without = resolveStartupLimit({ client: 'claude-code', env: {} });
  assert.deepEqual([without.ms, without.source, without.known], [TOOL_DEFAULT_TIMEOUT_MS, 'tool_default', false]);
  assert.equal(without.ms, 30000);
  const bad = resolveStartupLimit({ client: 'claude-code', env: { MCP_TIMEOUT: 'soon' } });
  assert.equal(bad.ms, 30000);
  const flag = resolveStartupLimit({ client: 'codex', configStartupMs: 20000, flagMs: 1234, env: {} });
  assert.deepEqual([flag.ms, flag.source], [1234, 'flag']);
  for (const client of ['cursor', 'vscode', 'claude-desktop'] as const) {
    assert.equal(resolveStartupLimit({ client, env: {} }).known, false, client);
  }
});

test('codex startup_timeout_sec = 1 with a 2 s slow server -> startup_timeout naming codex and 1000 ms', async () => {
  const cwd = REPO_ROOT.replace(/\/$/, '');
  const parsed = parseConfigText('codex', readFileSync(join(CONFIGS, 'codex.toml'), 'utf8'), 'codex.toml', { cwd, env: {}, workspaceFolder: cwd });
  const slow = parsed.servers.find((s) => s.name === 'slow-start');
  assert.ok(slow);
  const limit = resolveStartupLimit({ client: 'codex', configStartupMs: slow.startupTimeoutMs, env: {} });
  assert.equal(limit.ms, 1000);
  // 설정의 "node" 대신 지금 도는 node 를 써서 PATH 와 무관하게 만든다
  const r = await diagnoseServer({ ...slow, command: process.execPath }, { profile: 'shell', limit, retry: true, baseEnv: cleanEnv() });
  assert.equal(r.verdict.kind, 'startup_timeout');
  const en = describeFinding(r.verdict, r, 'en');
  assert.match(en, /codex/);
  assert.match(en, /1000 ms/);
  const ko = describeFinding(r.verdict, r, 'ko');
  assert.match(ko, /codex/);
  assert.match(ko, /1000 ms/);
});

test('Claude Code without MCP_TIMEOUT: message says client limit unknown', async () => {
  const spec: ServerSpec = { client: 'claude-code', name: 'x', command: process.execPath, args: [FIXTURE], env: { FAULT: 'slow', SLOW_MS: '3000' }, passThrough: [], source: 't', unresolved: [] };
  const limit = { ...resolveStartupLimit({ client: 'claude-code', env: {} }), ms: 800 };
  const r = await diagnoseServer(spec, { profile: 'shell', limit, retry: false, baseEnv: cleanEnv() });
  assert.equal(r.verdict.kind, 'startup_timeout');
  assert.match(describeFinding(r.verdict, r, 'en'), /client limit unknown/);
  // Claude Code 용 고칠 조각은 MCP_TIMEOUT 으로 시작 제한 시간을 늘리는 셸 명령
  assert.match(r.fixes.find((f) => f.forKind === 'startup_timeout')?.code ?? '', /^MCP_TIMEOUT=\d+ claude$/);
});

// slow_start 는 "답이 제한의 50% 와 100% 사이"일 때다. 그 구간에 들어가는 시각이 node 기동 시간(바쁜 기계에서
// 몇 초~십수 초)에 흔들리지 않도록, 이 두 테스트는 셸 내장 명령으로 답하는 작은 서버를 쓴다(helpers.ts).
const SLOW_START_LIMIT_MS = 20000;
const slowDirs: string[] = [];
after(() => { for (const d of slowDirs) rmSync(d, { recursive: true, force: true }); });

function shellServer(delaySec?: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'mld-slow-'));
  slowDirs.push(dir);
  const file = join(dir, 'server.sh');
  writeShellServer(file, { delaySec });
  return file;
}

test('answer above 50% of the limit -> slow_start warning', { skip: !posix }, async () => {
  // 10.5 s 뒤에 답한다: 50%(10 s)는 반드시 넘고(대기는 spawn 뒤에 시작), 제한(20 s)까지는 sh·sleep 기동에 9.5 s 여유가 있다
  const spec: ServerSpec = { name: 'x', command: shellServer(10.5), args: [], env: {}, passThrough: [], source: 't', unresolved: [] };
  const r = await diagnoseServer(spec, { profile: 'shell', limit: { ms: SLOW_START_LIMIT_MS, source: 'flag', known: true }, retry: false, baseEnv: cleanEnv() });
  assert.equal(r.verdict.kind, 'slow_start');
  assert.equal(r.verdict.severity, 'warn');
  assert.ok((r.timings.initializeMs ?? 0) > SLOW_START_LIMIT_MS * 0.5);
});

test('a fast server under the same limit has no slow_start', { skip: !posix }, async () => {
  const spec: ServerSpec = { name: 'x', command: shellServer(), args: [], env: {}, passThrough: [], source: 't', unresolved: [] };
  const r = await diagnoseServer(spec, { profile: 'shell', limit: { ms: SLOW_START_LIMIT_MS, source: 'flag', known: true }, retry: false, baseEnv: cleanEnv() });
  assert.equal(r.verdict.kind, 'ok');
});
