// AC-4: a timeout is retried with one thing changed to tell buffering from first-run installs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ServerSpec } from '#lib/config/parse';
import { diagnoseServer, isPackageRunner, isPythonLike, retryStrategies } from '#lib/diagnose';
import type { StartupLimit } from '#lib/timeouts';
import { cleanEnv, PY_FIXTURE, writeShellServer } from './helpers.js';

// 이 파일의 테스트는 시간 경주에 기대지 않는다:
//  - "제한을 넘겨야 하는" 첫 실행은 느리게 만드는 대신 아예 답하지 않는다(진단이 끝낼 때까지 기다린다).
//  - "제한 안에 답해야 하는" 재실행은 CPU 가 꽉 찬 기계에서도 들어오도록 제한을 넉넉히 둔다.
//    (코어 수만큼 바쁜 프로세스를 띄운 맥에서 잰 기동 시간: sh 0.3~0.7 s, python3 2.2~2.8 s, node 12~55 s)
// 8 s 는 Codex 고칠 조각의 최솟값(30 s = max(30, 3 × 8))도 그대로 둔다.
const ROOMY_LIMIT_MS = 8000;
const LIMIT: StartupLimit = { ms: ROOMY_LIMIT_MS, source: 'flag', known: true };
// python 재실행은 python 기동(포화 시 2.2~2.8 s)만 필요하다 — 셸(0.3~0.7 s)보다 느려서 따로 7배 여유를 준다.
// 첫 실행은 이 제한까지 기다리므로(noflush 는 답이 없다) 더 키우면 매 실행이 그만큼 길어진다.
const PYTHON_LIMIT: StartupLimit = { ms: 20000, source: 'flag', known: true };
const posix = process.platform !== 'win32';
const hasPython = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mld-retry-'));
  dirs.push(d);
  return d;
}

test('python noflush: timeout, then PYTHONUNBUFFERED=1 answers -> cause buffering', { skip: hasPython ? false : 'python3 not found — buffering case skipped' }, async () => {
  // 첫 실행: noflush 픽스처는 stdout 을 비우지 않으므로 제한이 얼마든 답이 나오지 않는다.
  // 재실행: PYTHONUNBUFFERED=1 이면 python 이 뜨자마자 답한다 — 넉넉한 제한이 느린 기동을 흡수한다.
  const spec: ServerSpec = { name: 'py', command: 'python3', args: [PY_FIXTURE], env: { FAULT: 'noflush' }, passThrough: [], source: 'test', unresolved: [] };
  const r = await diagnoseServer(spec, { profile: 'shell', limit: PYTHON_LIMIT, retry: true, baseEnv: cleanEnv() });
  assert.equal(r.verdict.kind, 'startup_timeout');
  assert.equal(r.verdict.cause, 'buffering');
  assert.deepEqual(r.retries.map((x) => [x.strategy, x.ok]), [['unbuffered', true]]);
  const fix = r.fixes.find((f) => f.forKind === 'startup_timeout');
  assert.match(fix?.code ?? '', /"PYTHONUNBUFFERED": "1"/);
});

if (!hasPython) console.log('# notice: python3 not found — the buffering case (AC-4) was skipped');

/**
 * "npx" 라는 이름의 작은 셸 스크립트 — 패키지 실행기처럼 보이는 가짜(helpers.ts writeShellServer).
 * 첫 실행: 표시 파일을 셸이 맨 먼저 만들고, "패키지를 내려받는 중"처럼 답 없이 기다린다.
 *         진단이 제한 시간 뒤 프로세스 그룹을 끝내므로 sleep 은 끝까지 가지 않는다.
 * 그다음 실행: 셸 내장 명령만으로 initialize·tools/list 에 바로 답한다.
 *         node 를 띄우지 않으므로 CPU 가 바빠 node 기동이 몇 초씩 걸려도 결과가 바뀌지 않는다.
 */
function fakeRunner(): string {
  const dir = tempDir();
  const command = join(dir, 'npx');
  writeShellServer(command, { firstRunMarker: join(dir, 'installed.marker') });
  return command;
}

test('firstrun via a package-runner name: rerun answers -> cause first_run_install', { skip: !posix }, async () => {
  const command = fakeRunner();
  const spec: ServerSpec = { name: 'runner', command, args: ['-y', 'some-mcp-server'], env: {}, passThrough: [], source: 'test', unresolved: [] };
  const r = await diagnoseServer(spec, { profile: 'shell', limit: LIMIT, retry: true, baseEnv: cleanEnv() });
  assert.equal(r.verdict.kind, 'startup_timeout');
  assert.equal(r.verdict.cause, 'first_run_install');
  assert.deepEqual(r.retries.map((x) => [x.strategy, x.ok]), [['rerun', true]]);
  assert.ok(r.fixes.some((f) => f.forKind === 'startup_timeout'));
});

test('--no-retry -> cause unknown and no retries', { skip: !posix }, async () => {
  const command = fakeRunner();
  const spec: ServerSpec = { name: 'runner', command, args: ['-y'], env: {}, passThrough: [], source: 'test', unresolved: [] };
  const r = await diagnoseServer(spec, { profile: 'shell', limit: LIMIT, retry: false, baseEnv: cleanEnv() });
  assert.equal(r.verdict.kind, 'startup_timeout');
  assert.equal(r.verdict.cause, 'unknown');
  assert.equal(r.retries.length, 0);
});

test('codex first_run fix raises startup_timeout_sec in TOML', { skip: !posix }, async () => {
  const command = fakeRunner();
  const spec: ServerSpec = { client: 'codex', name: 'runner', command, args: ['-y'], env: {}, passThrough: [], source: 'test', unresolved: [] };
  const r = await diagnoseServer(spec, { profile: 'shell', limit: { ms: ROOMY_LIMIT_MS, source: 'config', client: 'codex', known: true }, retry: true, baseEnv: cleanEnv() });
  assert.equal(r.verdict.cause, 'first_run_install');
  const fix = r.fixes.find((f) => f.forKind === 'startup_timeout');
  assert.equal(fix?.format, 'toml');
  assert.match(fix?.code ?? '', /startup_timeout_sec = 30/);
});

test('retry strategy rules', () => {
  const s = (command: string, ...args: string[]) => ({ command, args });
  assert.ok(isPackageRunner(s('npx', '-y', 'pkg')));
  assert.ok(isPackageRunner(s('/usr/local/bin/uvx', 'pkg')));
  assert.ok(isPackageRunner(s('pnpm', 'dlx', 'pkg')));
  assert.ok(!isPackageRunner(s('pnpm', 'run', 'x')));
  assert.ok(isPythonLike(s('python3.12', 'x.py')));
  assert.ok(isPythonLike(s('node', 'server.py')));
  assert.ok(!isPythonLike(s('node', 'server.js')));
  assert.deepEqual(retryStrategies(s('uvx', 'pkg')), ['rerun', 'unbuffered']);
  assert.deepEqual(retryStrategies(s('python3', 'a.py')), ['unbuffered']);
  assert.deepEqual(retryStrategies(s('node', 'a.js')), []);
});
