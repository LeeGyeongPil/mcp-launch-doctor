// AC-2: every fault fixture gets its own verdict through the real session code.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerSpec } from '#lib/config/parse';
import { diagnoseServer, type DiagnosisResult } from '#lib/diagnose';
import { runSession } from '#lib/session';
import type { StartupLimit } from '#lib/timeouts';
import { cleanEnv, FIXTURE, isAlive, NODE_LIMIT_FLAG, NODE_LIMIT_MS, runCli } from './helpers.js';

// 답해야 하는 픽스처용 넉넉한 제한(helpers.ts NODE_LIMIT_MS): 빨리 답하면 기다리지 않고, CPU 가 꽉 찬 기계에서
// node 기동이 수십 초 걸려도 ok 판정(제한의 50% 미만)이 바뀌지 않는다. 시간 초과를 보는 테스트는 따로 LIMIT_1S 를 쓴다.
const LIMIT_ROOMY: StartupLimit = { ms: NODE_LIMIT_MS, source: 'flag', known: true };
const LIMIT_1S: StartupLimit = { ms: 1000, source: 'flag', known: true };

function spec(fault: string, extraEnv: Record<string, string> = {}): ServerSpec {
  return { name: `fault:${fault}`, command: process.execPath, args: [FIXTURE], env: { FAULT: fault, ...extraEnv }, passThrough: [], source: 'test', unresolved: [] };
}

function run(fault: string, limit = LIMIT_ROOMY, extraEnv: Record<string, string> = {}): Promise<DiagnosisResult> {
  return diagnoseServer(spec(fault, extraEnv), { profile: 'shell', limit, retry: true, baseEnv: cleanEnv() });
}

test('none -> ok with timings, server info and tool count', async () => {
  const r = await run('none');
  assert.equal(r.verdict.kind, 'ok');
  assert.equal(r.toolCount, 1);
  assert.equal(r.serverInfo?.name, 'fault-fixture');
  assert.equal(r.serverInfo?.protocolVersion, '2025-11-25');
  assert.ok((r.timings.initializeMs ?? 0) > 0);
  assert.ok(r.timings.firstByteMs !== undefined);
});

test('banner -> stdout_pollution with 2 lines, byte offsets and previews', async () => {
  const r = await run('banner');
  assert.equal(r.verdict.kind, 'stdout_pollution');
  assert.equal(r.verdict.severity, 'error');
  assert.equal(r.verdict.data.count, 2);
  const lines = r.verdict.data.lines as Array<{ offset: number; preview: string; kind: string }>;
  assert.equal(lines[0]?.offset, 0);
  assert.equal(lines[0]?.preview, 'Starting fixture server v0.1 ...');
  assert.ok((lines[1]?.offset ?? 0) > 33);
  assert.equal(lines[1]?.preview, '[debug] initialized ok');
  assert.equal(r.toolCount, 1, 'the handshake itself still worked — SDK clients would call this a success');
});

test('slow (1 s limit) -> startup_timeout', async () => {
  const r = await run('slow', LIMIT_1S, { SLOW_MS: '3000' });
  assert.equal(r.verdict.kind, 'startup_timeout');
  assert.equal(r.verdict.data.limitMs, 1000);
  assert.equal(r.verdict.cause, 'unknown');
});

test('exit -> early_exit code 3 with stderr tail, token masked', async () => {
  const r = await run('exit');
  assert.equal(r.verdict.kind, 'early_exit');
  assert.equal(r.verdict.data.code, 3);
  assert.match(r.stderrTail ?? '', /missing or invalid API_TOKEN/);
  assert.match(r.stderrTail ?? '', /API_TOKEN=\*\*\*/);
  assert.doesNotMatch(r.stderrTail ?? '', new RegExp('sk' + '-test-123'));
});

test('version -> version_mismatch 1999-01-01', async () => {
  const r = await run('version');
  assert.equal(r.verdict.kind, 'version_mismatch');
  assert.equal(r.verdict.data.got, '1999-01-01');
});

test('crlf and bom -> framing_warning', async () => {
  const crlf = await run('crlf');
  assert.equal(crlf.verdict.kind, 'framing_warning');
  assert.equal(crlf.verdict.severity, 'warn');
  assert.equal(crlf.verdict.data.crlf, 2);
  const bom = await run('bom');
  assert.equal(bom.verdict.kind, 'framing_warning');
  assert.equal(bom.verdict.data.bom, 1);
});

test('notjsonrpc -> stdout_pollution (json_not_jsonrpc)', async () => {
  const r = await run('notjsonrpc');
  assert.equal(r.verdict.kind, 'stdout_pollution');
  const lines = r.verdict.data.lines as Array<{ kind: string }>;
  assert.equal(lines[0]?.kind, 'json_not_jsonrpc');
});

test('partial -> framing_warning (partial_line)', async () => {
  const r = await run('partial');
  assert.equal(r.verdict.kind, 'framing_warning');
  assert.equal(r.verdict.data.partial, 1);
  const lines = r.verdict.data.lines as Array<{ flags: string[] }>;
  assert.ok(lines.some((l) => l.flags.includes('partial_line')));
});

test('verdicts are all different across fixtures', async () => {
  const kinds = new Set<string>();
  for (const fault of ['none', 'banner', 'exit', 'version', 'crlf']) kinds.add((await run(fault)).verdict.kind);
  assert.equal(kinds.size, 5);
});

test('the server process is gone after a timed-out session', async () => {
  const obs = await runSession({ command: process.execPath, args: [FIXTURE], env: cleanEnv({ FAULT: 'slow', SLOW_MS: '10000' }) }, { startupTimeoutMs: 500 });
  assert.equal(obs.timedOut?.phase, 'initialize');
  assert.ok(obs.pid);
  const alive = isAlive(obs.pid);
  // 샌드박스가 프로세스 조회를 막으면(undefined) 이 확인만 건너뛴다
  if (alive !== undefined) assert.equal(alive, false);
});

test('run --json masks the token in stderrTail (CLI path)', async () => {
  const res = await runCli(['run', '--json', '--timeout', NODE_LIMIT_FLAG, '--', process.execPath, FIXTURE], { env: cleanEnv({ FAULT: 'exit' }) });
  assert.equal(res.code, 1);
  const doc = JSON.parse(res.stdout) as { results: Array<{ verdict: { kind: string }; stderrTail: string }> };
  assert.equal(doc.results[0]?.verdict.kind, 'early_exit');
  assert.ok(doc.results[0]?.stderrTail.includes('API_TOKEN=***'));
  assert.ok(!res.stdout.includes('sk' + '-test-123'));
});
