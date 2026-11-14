// Regression: `run` fix snippets use absolute paths for relative file arguments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
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
