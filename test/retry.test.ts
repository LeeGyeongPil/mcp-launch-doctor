// AC-4: a timeout is retried with one thing changed to tell buffering from first-run installs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ServerSpec } from '#lib/config/parse';
import { diagnoseServer, isPackageRunner, isPythonLike, retryStrategies } from '#lib/diagnose';
import type { StartupLimit } from '#lib/timeouts';
import { cleanEnv, FIXTURE, PY_FIXTURE } from './helpers.js';

const LIMIT: StartupLimit = { ms: 1500, source: 'flag', known: true };
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
  const spec: ServerSpec = { name: 'py', command: 'python3', args: [PY_FIXTURE], env: { FAULT: 'noflush' }, passThrough: [], source: 'test', unresolved: [] };
  const r = await diagnoseServer(spec, { profile: 'shell', limit: LIMIT, retry: true, baseEnv: cleanEnv() });
  assert.equal(r.verdict.kind, 'startup_timeout');
  assert.equal(r.verdict.cause, 'buffering');
  assert.deepEqual(r.retries.map((x) => [x.strategy, x.ok]), [['unbuffered', true]]);
  const fix = r.fixes.find((f) => f.forKind === 'startup_timeout');
  assert.match(fix?.code ?? '', /"PYTHONUNBUFFERED": "1"/);
});

if (!hasPython) console.log('# notice: python3 not found — the buffering case (AC-4) was skipped');

function fakeRunner(): { command: string; marker: string } {
  // "npx" 라는 이름의 작은 실행 파일 — 패키지 실행기처럼 보이지만 실제로는 첫 실행만 느린 픽스처
  const dir = tempDir();
  const command = join(dir, 'npx');
  writeFileSync(command, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}"\n`);
  chmodSync(command, 0o755);
  return { command, marker: join(dir, 'installed.marker') };
}

test('firstrun via a package-runner name: rerun answers -> cause first_run_install', { skip: !posix }, async () => {
  const { command, marker } = fakeRunner();
  const spec: ServerSpec = { name: 'runner', command, args: ['-y', 'some-mcp-server'], env: { FAULT: 'firstrun', FIRSTRUN_MARKER: marker, SLOW_MS: '4000' }, passThrough: [], source: 'test', unresolved: [] };
  const r = await diagnoseServer(spec, { profile: 'shell', limit: LIMIT, retry: true, baseEnv: cleanEnv() });
  assert.equal(r.verdict.kind, 'startup_timeout');
  assert.equal(r.verdict.cause, 'first_run_install');
  assert.deepEqual(r.retries.map((x) => [x.strategy, x.ok]), [['rerun', true]]);
  assert.ok(r.fixes.some((f) => f.forKind === 'startup_timeout'));
});

test('--no-retry -> cause unknown and no retries', { skip: !posix }, async () => {
  const { command, marker } = fakeRunner();
  const spec: ServerSpec = { name: 'runner', command, args: ['-y'], env: { FAULT: 'firstrun', FIRSTRUN_MARKER: marker, SLOW_MS: '4000' }, passThrough: [], source: 'test', unresolved: [] };
  const r = await diagnoseServer(spec, { profile: 'shell', limit: LIMIT, retry: false, baseEnv: cleanEnv() });
  assert.equal(r.verdict.kind, 'startup_timeout');
  assert.equal(r.verdict.cause, 'unknown');
  assert.equal(r.retries.length, 0);
});

test('codex first_run fix raises startup_timeout_sec in TOML', { skip: !posix }, async () => {
  const { command, marker } = fakeRunner();
  const spec: ServerSpec = { client: 'codex', name: 'runner', command, args: ['-y'], env: { FAULT: 'firstrun', FIRSTRUN_MARKER: marker, SLOW_MS: '4000' }, passThrough: [], source: 'test', unresolved: [] };
  const r = await diagnoseServer(spec, { profile: 'shell', limit: { ms: 1500, source: 'config', client: 'codex', known: true }, retry: true, baseEnv: cleanEnv() });
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
