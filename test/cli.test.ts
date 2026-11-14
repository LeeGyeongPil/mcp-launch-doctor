// AC-8: first run (demo) and the CI contract (--json schema, --fail-on, exit codes).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanEnv, FIXTURE, NODE_LIMIT_FLAG, NODE_LIMIT_MS, runCli } from './helpers.js';

// 실제 `demo` 명령 테스트는 시간에 기대지 않는 것만 본다: 데모 제한은 제품 상수 2500 ms 라서, CPU 가 꽉 찬
// 기계에서는 node 픽스처가 그 안에 뜨지 못해 판정이 startup_timeout 으로 바뀔 수 있다.
// 픽스처별 판정(9종)과 판정 설명 문구는 test/demo.test.ts 가 같은 데모 서버 정의(demoSpec)로 넉넉한 제한을 주입해 검사한다.
const DEMO_FAULT_NAMES = ['none', 'banner', 'slow', 'exit', 'version', 'crlf', 'bom', 'notjsonrpc', 'partial'];

test('demo prints the practice notice first and the 8-fault table', async () => {
  const res = await runCli(['demo', '--lang', 'en']);
  assert.equal(res.code, 0);
  const firstLine = res.stdout.split('\n')[0] ?? '';
  assert.match(firstLine, /practice fixtures \(mock servers\)/);
  assert.match(res.stdout, /SERVER\s+ENV\s+RESULT\s+FIRST ANSWER\s+TOOLS/);
  for (const fault of DEMO_FAULT_NAMES) {
    assert.ok(res.stdout.includes(`fault:${fault}`), `row for ${fault}`);
  }
  assert.equal(res.stderr, '', 'nothing on stderr when not a terminal');
});

test('demo --json has schemaVersion 1, practice flag, the demo limit and one result per fixture', async () => {
  const res = await runCli(['demo', '--json']);
  assert.equal(res.code, 0);
  const doc = JSON.parse(res.stdout) as { schemaVersion: number; practice: boolean; results: Array<{ server: string; verdict: { kind: string }; limit: unknown }> };
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.practice, true);
  assert.equal(doc.results.length, 9);
  assert.deepEqual(doc.results.map((r) => r.server), DEMO_FAULT_NAMES.map((f) => `fault:${f}`));
  for (const r of doc.results) {
    assert.equal(typeof r.verdict.kind, 'string', `${r.server} has a verdict kind`);
    // CLI 의 demo 는 제품 상수 DEMO_LIMIT_MS(2500 ms)를 쓴다 — 시간을 재지 않고 값만 확인
    assert.deepEqual(r.limit, { ms: 2500, source: 'demo', known: true }, `${r.server} uses the demo limit`);
  }
  // 픽스처는 파일 이름으로 띄운다: 설치 위치(npx 캐시·홈 폴더)가 출력과 고칠 조각에 찍히지 않는다
  const fixtureDir = FIXTURE.slice(0, FIXTURE.lastIndexOf('fault-server.mjs'));
  assert.equal(res.stdout.includes(fixtureDir), false, 'no fixture folder path in the demo report');
  assert.deepEqual((doc.results[0] as unknown as { args: string[] }).args, ['fault-server.mjs']);
});

test('--fail-on switches the exit code (warn-only server)', async () => {
  // 넉넉한 --timeout(helpers.ts NODE_LIMIT_MS): 판정이 node 기동 시간에 흔들리지 않게 — 이 테스트가 보는 것은 --fail-on 이다
  const run = (failOn?: string) => runCli(['run', ...(failOn ? ['--fail-on', failOn] : []), '--timeout', NODE_LIMIT_FLAG, '--json', '--', process.execPath, FIXTURE], { env: cleanEnv({ FAULT: 'crlf' }) });
  assert.equal((await run()).code, 0, 'default error: a warning passes');
  assert.equal((await run('error')).code, 0);
  assert.equal((await run('warn')).code, 1);
  assert.equal((await run('never')).code, 0);
});

test('--fail-on with an error-level server', async () => {
  const run = (failOn: string) => runCli(['run', '--fail-on', failOn, '--timeout', NODE_LIMIT_FLAG, '--', process.execPath, FIXTURE], { env: cleanEnv({ FAULT: 'banner' }) });
  assert.equal((await run('error')).code, 1);
  assert.equal((await run('never')).code, 0);
});

test('healthy server passes even with --fail-on warn and --timeout', async () => {
  // 넉넉한 --timeout: 바쁜 기계에서 node 기동이 느려도 slow_start(50% 이상) 경고로 바뀌어 --fail-on warn 에 걸리지 않게
  const res = await runCli(['run', '--json', '--fail-on', 'warn', '--timeout', NODE_LIMIT_FLAG, '--', process.execPath, FIXTURE], { env: cleanEnv({ FAULT: 'none' }) });
  assert.equal(res.code, 0);
  const doc = JSON.parse(res.stdout) as { exitCode: number; summary: { ok: number }; results: Array<{ limit: { ms: number; source: string } }> };
  assert.equal(doc.exitCode, 0);
  assert.equal(doc.summary.ok, 1);
  assert.deepEqual(doc.results[0]?.limit, { ms: NODE_LIMIT_MS, source: 'flag', known: true });
});

test('usage errors exit 2', async () => {
  const cases: string[][] = [
    ['frobnicate'],
    ['run'],
    ['run', '--fail-on', 'sometimes', '--', 'node'],
    ['run', '--timeout', '-5', '--', 'node'],
    ['run', '--env', 'desktop', '--', 'node'],
    ['check', '--client', 'netscape'],
    ['check', '--bogus'],
    ['--lang', 'fr', '--help'],
    ['check', '--client', 'codex', '--config', 'fixtures/configs/missing.toml'],
    ['check', '--config', 'fixtures/configs/cursor.json'],
    [],
  ];
  for (const args of cases) {
    const res = await runCli(args);
    assert.equal(res.code, 2, `exit 2 for: ${args.join(' ')}`);
    if (args.length > 0) assert.ok(res.stderr.includes('mcp-launch-doctor:'), `message on stderr for: ${args.join(' ')}`);
  }
});

test('choice lists in errors come from the same constants as the help', async () => {
  const res = await runCli(['check', '--client', 'netscape', '--lang', 'en']);
  assert.match(res.stderr, /claude-desktop, claude-code, cursor, vscode, codex, all/);
  const help = await runCli(['--help', '--lang', 'en']);
  assert.match(help.stdout, /claude-desktop\|claude-code\|cursor\|vscode\|codex/);
  assert.match(help.stdout, /error\|warn\|never/);
});

test('--version and --help exit 0', async () => {
  assert.match((await runCli(['--version'])).stdout, /^\d+\.\d+\.\d+\n$/);
  assert.equal((await runCli(['--help'])).code, 0);
  assert.equal((await runCli(['run', '--help'])).code, 0);
});

test('run --dry-run launches nothing', async () => {
  const res = await runCli(['run', '--dry-run', '--json', '--', 'mld-no-such-command-xyz', '--flag']);
  assert.equal(res.code, 0);
  const doc = JSON.parse(res.stdout) as { dryRun: boolean; servers: Array<{ command: string; args: string[] }> };
  assert.equal(doc.dryRun, true);
  assert.deepEqual(doc.servers[0]?.args, ['--flag']);
});

test('run names a wrapped server after the server, also in the pinned npx form of the wrap fix', async () => {
  // 고칠 조각을 붙여 넣은 그대로(npx -y mcp-launch-doctor@<버전> wrap -- …) 다시 검사해도 이름은 감싼 서버 — dry-run 이라 npx 는 실행되지 않는다
  const pinned = await runCli(['run', '--dry-run', '--json', '--', 'npx', '-y', 'mcp-launch-doctor@0.1.0', 'wrap', '--', 'node', 'fixtures/fault-server.mjs']);
  assert.equal(pinned.code, 0);
  const doc = JSON.parse(pinned.stdout) as { servers: Array<{ server: string }> };
  assert.equal(doc.servers[0]?.server, 'fault-server.mjs');
  const plain = await runCli(['run', '--dry-run', '--json', '--', 'npx', '-y', 'mcp-launch-doctor', 'wrap', '--', 'node', 'fixtures/fault-server.mjs']);
  assert.equal((JSON.parse(plain.stdout) as { servers: Array<{ server: string }> }).servers[0]?.server, 'fault-server.mjs');
  // 전역 설치 이름을 바로 쓴 형태(mcp-launch-doctor wrap -- …)도 감싼 서버 이름으로 풀린다
  const bare = await runCli(['run', '--dry-run', '--json', '--', 'mcp-launch-doctor', 'wrap', '--', 'node', 'fixtures/fault-server.mjs']);
  assert.equal(bare.code, 0);
  assert.equal((JSON.parse(bare.stdout) as { servers: Array<{ server: string }> }).servers[0]?.server, 'fault-server.mjs');
});

test('npx without -y gets a prompt-risk warning (dry check via a missing npx)', async () => {
  // PATH 에 npx 가 없게 만들어 실제 설치는 일어나지 않는다 — not_found 와 함께 npx_prompt_risk 경고가 붙는지만 본다
  const res = await runCli(['run', '--json', '--', 'npx', 'some-server'], { env: cleanEnv({ PATH: '/nonexistent-mld' }) });
  const doc = JSON.parse(res.stdout) as { results: Array<{ findings: Array<{ kind: string }> }> };
  const kinds = doc.results[0]?.findings.map((f) => f.kind) ?? [];
  assert.ok(kinds.includes('not_found'));
  assert.ok(kinds.includes('npx_prompt_risk'));
});

test('--version matches package.json', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal((await runCli(['--version'])).stdout.trim(), pkg.version);
});
