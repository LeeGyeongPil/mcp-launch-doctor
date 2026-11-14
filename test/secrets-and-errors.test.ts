// Regression tests for masked server args, translated usage errors and empty config files.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { redactArgs } from '#lib/redact';
import { cleanEnv, FIXTURE, NODE_LIMIT_FLAG, runCli } from './helpers.js';

// Fake secrets are assembled from pieces so secret scanners do not flag this file.
const SK = ['sk', 'proj', 'abcdef123456'].join('-');
const GHP = ['gh', 'p_', 'abcdefABCDEF1234567890'].join('');
const PLAIN = ['hunter', '2', 'plain'].join('');

function tmpConfig(doc: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mld-sec-'));
  const path = join(dir, 'mcp.json');
  writeFileSync(path, JSON.stringify(doc));
  return { dir, path };
}

test('redactArgs masks token shapes and the value after a secret-looking flag', () => {
  assert.deepEqual(redactArgs(['--api-key', PLAIN, '--name', 'x']), ['--api-key', '***', '--name', 'x']);
  assert.deepEqual(redactArgs([`--token=${PLAIN}`]), ['--token=***']);
  assert.deepEqual(redactArgs([SK]), ['sk-***']);
  assert.deepEqual(redactArgs([GHP]), ['gh*_***']);
});

test('secrets in server args never appear in dry-run, --json or fix snippets', async () => {
  const { dir, path } = tmpConfig({
    mcpServers: {
      s: { command: 'node', args: [FIXTURE, '--api-key', SK, '--token', GHP, '--password', PLAIN], env: { FAULT: 'banner' } },
    },
  });
  try {
    const secrets = [SK, GHP, PLAIN];
    const runs = [
      ['check', '--client', 'cursor', '--config', path, '--dry-run'],
      ['check', '--client', 'cursor', '--config', path, '--dry-run', '--json'],
      ['check', '--client', 'cursor', '--config', path, '--env', 'shell', '--timeout', NODE_LIMIT_FLAG],
      ['check', '--client', 'cursor', '--config', path, '--env', 'shell', '--timeout', NODE_LIMIT_FLAG, '--json'],
    ];
    for (const args of runs) {
      const res = await runCli(args);
      for (const secret of secrets) {
        assert.ok(!res.stdout.includes(secret), `${args.join(' ')} leaked ${secret.slice(0, 6)}...`);
        assert.ok(!res.stderr.includes(secret), `${args.join(' ')} leaked on stderr`);
      }
    }
    // 넉넉한 --timeout(helpers.ts NODE_LIMIT_MS): 판정이 stdout_pollution 으로 나와야 wrap 고칠 조각(가려진 값 안내)이 붙는다
    const human = await runCli(['check', '--client', 'cursor', '--config', path, '--env', 'shell', '--timeout', NODE_LIMIT_FLAG]);
    assert.match(human.stdout, /masked/, 'the fix snippet explains the masked values');
    const ko = await runCli(['check', '--client', 'cursor', '--config', path, '--env', 'shell', '--timeout', NODE_LIMIT_FLAG, '--lang', 'ko']);
    assert.match(ko.stdout, /가려진/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run --dry-run masks secrets given on the command line', async () => {
  const res = await runCli(['run', '--dry-run', '--', 'node', FIXTURE, '--token', PLAIN, SK]);
  assert.ok(!res.stdout.includes(PLAIN) && !res.stdout.includes(SK));
  assert.match(res.stdout, /\*\*\*/);
});

test('unknown option is translated in both languages', async () => {
  const en = await runCli(['check', '--bogus'], { env: cleanEnv() });
  assert.equal(en.code, 2);
  assert.match(en.stderr, /Unknown option "--bogus"/);
  assert.ok(!en.stderr.includes('place it at the end'), 'no raw node hint');
  const ko = await runCli(['check', '--lang', 'ko', '--bogus']);
  assert.equal(ko.code, 2);
  assert.match(ko.stderr, /알 수 없는 옵션 "--bogus"/);
  assert.ok(!/Unknown option|positional/.test(ko.stderr), 'no English sentence in ko output');
  const val = await runCli(['check', '--lang', 'ko', '--timeout']);
  assert.equal(val.code, 2);
  assert.match(val.stderr, /값이 필요/);
  assert.ok(!/argument missing|requires/i.test(val.stderr));
});

test('invalid entry detail is translated', async () => {
  const { dir, path } = tmpConfig({ mcpServers: { a: { command: 123 } } });
  try {
    const ko = await runCli(['check', '--client', 'cursor', '--config', path, '--dry-run', '--lang', 'ko']);
    assert.match(ko.stdout, /잘못된 항목/);
    assert.ok(!ko.stdout.includes('missing'), 'no English detail in ko output');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit --config without any server explains what was expected', async () => {
  const { dir, path } = tmpConfig({ mcpServers: {} });
  try {
    const en = await runCli(['check', '--client', 'cursor', '--config', path, '--dry-run']);
    assert.equal(en.code, 2);
    assert.match(en.stderr, /No stdio servers in/);
    const ko = await runCli(['check', '--client', 'cursor', '--config', path, '--dry-run', '--lang', 'ko']);
    assert.equal(ko.code, 2);
    assert.match(ko.stderr, /stdio 서버가 없습니다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run server names skip eval code and follow wrap chains', async () => {
  const code = await runCli(['run', '--dry-run', '--json', '--', 'node', '-e', 'console.log("a very long piece of inline code that is not a name")']);
  assert.equal((JSON.parse(code.stdout) as { servers: Array<{ server: string }> }).servers[0]?.server, 'node');
  const wrapped = await runCli(['run', '--dry-run', '--json', '--', 'node', 'dist/src/cli.js', 'wrap', '--', 'node', 'fixtures/fault-server.mjs']);
  assert.equal((JSON.parse(wrapped.stdout) as { servers: Array<{ server: string }> }).servers[0]?.server, 'fault-server.mjs');
});
