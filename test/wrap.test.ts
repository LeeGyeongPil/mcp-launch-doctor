// AC-7: wrap passes only JSON-RPC on stdout and is transparent for exit codes and stdin EOF.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, test } from 'node:test';
import type { ServerSpec } from '#lib/config/parse';
import { diagnoseServer, type DiagnosisResult } from '#lib/diagnose';
import { buildFixes, stableNodePath } from '#lib/fixes';
import { isTemporaryPath, SELF, withoutNpmExec } from '#lib/selfLaunch';
import { cleanEnv, CLI, FIXTURE, HANG_GUARD_MS, NODE_LIMIT_FLAG, NODE_LIMIT_MS, REPO_ROOT } from './helpers.js';

// 넉넉한 제한(helpers.ts NODE_LIMIT_MS): wrap 은 node 를 두 번(wrap·픽스처) 띄우므로 바쁜 기계에서도 ok(50% 미만)가 바뀌지 않게 둔다
const LIMIT = { ms: NODE_LIMIT_MS, source: 'flag' as const, known: true };

function wrapSpec(fault: string): ServerSpec {
  return { name: `wrapped:${fault}`, command: process.execPath, args: [CLI, 'wrap', '--', process.execPath, FIXTURE], env: { FAULT: fault }, passThrough: [], source: 'test', unresolved: [] };
}

/** Runs `wrap -- node fixture` directly, writes input, collects raw bytes. */
function rawWrap(fault: string, input: string | null): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'wrap', '--', process.execPath, FIXTURE], { env: cleanEnv({ FAULT: fault }), stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('wrap did not exit')); }, HANG_GUARD_MS);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr: err }); });
    // input === null: stdin 을 바로 닫아 EOF 가 서버까지 전달되는지 본다
    child.stdin.end(input ?? undefined);
  });
}

const handshake = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
].map((m) => JSON.stringify(m) + '\n').join('');

test('banner fixture behind wrap -> ok, 2 lines diverted to stderr', async () => {
  const r = await diagnoseServer(wrapSpec('banner'), { profile: 'shell', limit: LIMIT, retry: false, baseEnv: cleanEnv() });
  assert.equal(r.verdict.kind, 'ok');
  assert.equal(r.findings.some((f) => f.kind === 'stdout_pollution'), false);
  const diverted = (r.stderrTail ?? '').split('\n').filter((l) => l.startsWith('[wrap] diverted:'));
  assert.equal(diverted.length, 2);
  assert.match(diverted[0] ?? '', /Starting fixture server/);
});

test('BOM is stripped and CRLF becomes LF', async () => {
  for (const fault of ['bom', 'crlf']) {
    const res = await rawWrap(fault, handshake);
    assert.equal(res.code, 0);
    assert.equal(res.stdout.indexOf(Buffer.from([0xef, 0xbb, 0xbf])), -1, `${fault}: no BOM`);
    assert.equal(res.stdout.includes(0x0d), false, `${fault}: no \\r`);
    const lines = res.stdout.toString('utf8').trimEnd().split('\n');
    assert.equal(lines.length, 2);
    for (const l of lines) assert.equal((JSON.parse(l) as { jsonrpc: string }).jsonrpc, '2.0');
  }
});

test('the child exit code is passed on (FAULT=exit -> 3)', async () => {
  const res = await rawWrap('exit', handshake);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /missing or invalid API_TOKEN/);
});

test('stdin EOF reaches the server, which then exits 0', async () => {
  const res = await rawWrap('none', null);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.length, 0);
});

test('a missing command exits 127 with a message', async () => {
  const res = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, 'wrap', '--', 'mld-no-such-command-xyz'], { env: cleanEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => resolve({ code, stderr: err }));
  });
  assert.equal(res.code, 127);
  assert.match(res.stderr, /\[wrap\]/);
});

test('stdout_pollution fix puts wrap in front of command/args (JSON and Codex TOML)', async () => {
  const json = await diagnoseServer({ name: 'banner', command: process.execPath, args: [FIXTURE], env: { FAULT: 'banner' }, passThrough: [], source: 't', unresolved: [] }, { profile: 'shell', limit: LIMIT, retry: false, baseEnv: cleanEnv() });
  const jfix = json.fixes.find((f) => f.forKind === 'stdout_pollution');
  assert.equal(jfix?.format, 'json');
  const entry = (JSON.parse(jfix?.code ?? '{}') as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers.banner;
  assert.deepEqual(entry?.args.slice(0, 3), [CLI, 'wrap', '--']);
  assert.deepEqual(entry?.args.slice(3), [process.execPath, FIXTURE]);

  const toml = await diagnoseServer({ client: 'codex', name: 'banner', command: process.execPath, args: [FIXTURE], env: { FAULT: 'banner' }, passThrough: [], source: 't', unresolved: [] }, { profile: 'shell', limit: LIMIT, retry: false, baseEnv: cleanEnv() });
  const tfix = toml.fixes.find((f) => f.forKind === 'stdout_pollution');
  assert.equal(tfix?.format, 'toml');
  assert.match(tfix?.code ?? '', /\[mcp_servers\.banner\]/);
  assert.ok(tfix?.code?.includes(`"${CLI}", "wrap", "--", "${process.execPath}", "${FIXTURE}"`));
});

// ---- Q-7: the wrap fix must not point into npx's cache -------------------------------------------
// `npx mcp-launch-doctor` runs from ~/.npm/_npx/<hash>/…, a cache folder that npm may delete.
// A config entry pointing there breaks later, so then the fix starts wrap with `npx -y <name>@<version>`.

const PKG_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const NPX_CACHE_CLI = '/home/me/.npm/_npx/e2789d140c626b6c/node_modules/mcp-launch-doctor/dist/cli.js';
const GLOBAL_CLI = '/opt/homebrew/lib/node_modules/mcp-launch-doctor/dist/cli.js';
const tempDirs: string[] = [];
after(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

/** A diagnosis result that only says "stdout is polluted", to feed buildFixes directly. */
function pollutedResult(spec: ServerSpec): DiagnosisResult {
  const f = { kind: 'stdout_pollution' as const, severity: 'error' as const, data: { count: 2 } };
  return { server: spec.name, client: spec.client, source: 't', profile: 'shell', command: spec.command, args: spec.args, launched: true, limit: LIMIT, verdict: f, findings: [f], timings: {}, retries: [], fixes: [] };
}

function spec(over: Partial<ServerSpec> = {}): ServerSpec {
  return { name: 'banner', command: process.execPath, args: [FIXTURE], env: {}, passThrough: [], source: 't', unresolved: [], ...over };
}

test('isTemporaryPath: npx/dlx/bunx caches and fnm per-shell links yes; clones and global installs no', () => {
  for (const p of [
    NPX_CACHE_CLI,
    'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\mcp-launch-doctor\\dist\\cli.js',
    '/home/me/Library/Caches/pnpm/dlx/abc123/node_modules/mcp-launch-doctor/dist/cli.js',
    '/tmp/bunx-501-mcp-launch-doctor@0.1.0/node_modules/mcp-launch-doctor/dist/cli.js',
    '/home/me/Library/Caches/fnm_multishells/1234_1700000000/bin/node',
  ]) assert.equal(isTemporaryPath(p), true, p);
  for (const p of [GLOBAL_CLI, '/home/me/src/mcp-launch-doctor/dist/cli.js', '/var/tmp/ai-lab/clone/dist/cli.js', '/usr/local/bin/node']) {
    assert.equal(isTemporaryPath(p), false, p);
  }
});

test('the running copy reports the package.json version (used to pin npx)', () => {
  assert.equal(SELF.version, PKG_VERSION);
  assert.equal(SELF.cliPath, CLI);
});

test('wrap fix from an npx cache: npx -y mcp-launch-doctor@<version> wrap, no _npx path (JSON and Codex TOML)', () => {
  const self = { cliPath: NPX_CACHE_CLI, version: PKG_VERSION };
  const ctx = { baseEnv: cleanEnv(), platform: process.platform, self };

  const json = buildFixes(pollutedResult(spec()), spec(), ctx).find((f) => f.forKind === 'stdout_pollution');
  assert.equal(json?.format, 'json');
  assert.equal(json?.note, 'fix.wrap_npx');
  assert.doesNotMatch(json?.code ?? '', /_npx/);
  const entry = (JSON.parse(json?.code ?? '{}') as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers.banner;
  assert.equal(entry?.command, 'npx');
  assert.deepEqual(entry?.args, ['-y', `mcp-launch-doctor@${PKG_VERSION}`, 'wrap', '--', process.execPath, FIXTURE]);

  const codex = spec({ client: 'codex' });
  const toml = buildFixes(pollutedResult(codex), codex, ctx).find((f) => f.forKind === 'stdout_pollution');
  assert.equal(toml?.format, 'toml');
  assert.doesNotMatch(toml?.code ?? '', /_npx/);
  assert.match(toml?.code ?? '', /command = "npx"/);
  assert.ok(toml?.code?.includes(`"-y", "mcp-launch-doctor@${PKG_VERSION}", "wrap", "--", "${process.execPath}"`));
});

test('wrap fix from an npx cache keeps the server\'s own npx command (it already starts in the app)', () => {
  const npxSpec = spec({ command: '/opt/homebrew/bin/npx', args: ['-y', '@example/server'] });
  const fix = buildFixes(pollutedResult(npxSpec), npxSpec, { baseEnv: cleanEnv(), platform: process.platform, self: { cliPath: NPX_CACHE_CLI, version: PKG_VERSION } })
    .find((f) => f.forKind === 'stdout_pollution');
  const entry = (JSON.parse(fix?.code ?? '{}') as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers.banner;
  assert.equal(entry?.command, '/opt/homebrew/bin/npx');
  assert.deepEqual(entry?.args, ['-y', `mcp-launch-doctor@${PKG_VERSION}`, 'wrap', '--', '/opt/homebrew/bin/npx', '-y', '@example/server']);
});

test('wrap fix from a global install or clone: absolute node + that dist/cli.js', () => {
  const fix = buildFixes(pollutedResult(spec()), spec(), { baseEnv: cleanEnv(), platform: process.platform, self: { cliPath: GLOBAL_CLI, version: PKG_VERSION } })
    .find((f) => f.forKind === 'stdout_pollution');
  assert.equal(fix?.note, 'fix.wrap');
  const entry = (JSON.parse(fix?.code ?? '{}') as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers.banner;
  assert.ok(entry?.command.endsWith('node'), entry?.command);
  assert.deepEqual(entry?.args.slice(0, 3), [GLOBAL_CLI, 'wrap', '--']);
});

test('node for the wrap fix is never a temporary node (npx -p node@22, fnm per-shell link)', () => {
  assert.equal(stableNodePath('', '/home/me/.npm/_npx/abc/node_modules/node/bin/node'), 'node');
  assert.equal(stableNodePath('', '/opt/node-22/bin/node'), '/opt/node-22/bin/node');
});

test('withoutNpmExec drops what npx added (npm_config_yes/package, cache PATH) and nothing else', () => {
  const pathValue = ['/home/me/.npm/_npx/abc/node_modules/.bin', '/proj/node_modules/.bin', '/opt/homebrew/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin', '/usr/bin'].join(delimiter);
  const launched = { PATH: pathValue, npm_lifecycle_event: 'npx', npm_command: 'exec', npm_config_yes: 'true', npm_config_package: '/x/mcp-launch-doctor.tgz', API_HOST: 'h' };
  const out = withoutNpmExec(launched);
  assert.equal(out.PATH, ['/proj/node_modules/.bin', '/usr/bin'].join(delimiter));
  for (const k of ['npm_lifecycle_event', 'npm_command', 'npm_config_yes', 'npm_config_package']) assert.equal(out[k], undefined, k);
  assert.equal(out.API_HOST, 'h');
  // npm 이 띄운 게 아니면(사용자가 셸에서 직접 설정한 값) 건드리지 않는다
  const own = { PATH: pathValue, npm_config_yes: 'true' };
  assert.deepEqual(withoutNpmExec(own), own);
});

/** Copies the built tool into a folder laid out like npm's npx cache and returns its cli.js. */
function fakeNpxInstall(): string {
  const root = mkdtempSync(join(tmpdir(), 'mld-npxsim-'));
  tempDirs.push(root);
  const modules = join(root, '.npm', '_npx', 'e2789d140c626b6c', 'node_modules');
  const pkg = join(modules, 'mcp-launch-doctor');
  mkdirSync(pkg, { recursive: true });
  const testDir = join(REPO_ROOT, 'dist', 'test');
  cpSync(join(REPO_ROOT, 'dist'), join(pkg, 'dist'), { recursive: true, filter: (src) => !src.startsWith(testDir) });
  cpSync(join(REPO_ROOT, 'package.json'), join(pkg, 'package.json'));
  cpSync(join(REPO_ROOT, 'node_modules', 'smol-toml'), join(modules, 'smol-toml'), { recursive: true });
  return join(pkg, 'dist', 'cli.js');
}

function runNode(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: ${args.join(' ')}`)); }, HANG_GUARD_MS);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('end to end: the tool run from a simulated npx cache prints an npx wrap fix and no cache path', async () => {
  const cachedCli = fakeNpxInstall();
  // npx 가 실제로 넣는 것처럼: 캐시 .bin 을 PATH 앞에, npm_config_yes 등
  const npxEnv = cleanEnv({ FAULT: 'banner', npm_lifecycle_event: 'npx', npm_command: 'exec', npm_config_yes: 'true', PATH: `${join(cachedCli, '..', '..', '..', '.bin')}${delimiter}${process.env.PATH ?? ''}` });

  const json = await runNode([cachedCli, 'run', '--json', '--lang', 'en', '--timeout', NODE_LIMIT_FLAG, '--', process.execPath, FIXTURE], npxEnv);
  assert.equal(json.code, 1, json.stderr);
  assert.doesNotMatch(json.stdout, /_npx/);
  const doc = JSON.parse(json.stdout) as { results: Array<{ verdict: { kind: string }; fixes: Array<{ forKind: string; code: string | null }> }> };
  assert.equal(doc.results[0]?.verdict.kind, 'stdout_pollution');
  const code = doc.results[0]?.fixes.find((f) => f.forKind === 'stdout_pollution')?.code ?? '';
  const entry = Object.values((JSON.parse(code) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers)[0];
  assert.equal(entry?.command, 'npx');
  assert.deepEqual(entry?.args.slice(0, 4), ['-y', `mcp-launch-doctor@${PKG_VERSION}`, 'wrap', '--']);

  const human = await runNode([cachedCli, 'run', '--lang', 'ko', '--timeout', NODE_LIMIT_FLAG, '--', process.execPath, FIXTURE], npxEnv);
  assert.doesNotMatch(human.stdout, /_npx/);
  assert.match(human.stdout, new RegExp(`"mcp-launch-doctor@${PKG_VERSION.replace(/\./g, '\\.')}"`));
  assert.match(human.stdout, /npx 캐시 폴더/);
});

test('npx-added variables reach neither the shell profile nor the server behind wrap', async () => {
  const npxEnv = cleanEnv({ npm_lifecycle_event: 'npx', npm_command: 'exec', npm_config_yes: 'true', npm_config_package: '/x/mcp-launch-doctor.tgz' });
  const report = 'process.stderr.write("seen yes=" + process.env.npm_config_yes + " package=" + process.env.npm_config_package + "\\n")';

  // shell 프로필: 서버가 본 환경을 stderr 로 찍고 끝나게 해서 stderr 꼬리로 확인
  const run = await runNode([CLI, 'run', '--json', '--timeout', NODE_LIMIT_FLAG, '--', process.execPath, '-e', `${report}; process.exit(3)`], npxEnv);
  const doc = JSON.parse(run.stdout) as { results: Array<{ verdict: { kind: string }; stderrTail: string }> };
  assert.equal(doc.results[0]?.verdict.kind, 'early_exit');
  assert.match(doc.results[0]?.stderrTail ?? '', /seen yes=undefined package=undefined/);

  // wrap: 서버 stderr 는 wrap 의 stderr 로 그대로 나온다
  const wrapped = await runNode([CLI, 'wrap', '--', process.execPath, '-e', report], npxEnv);
  assert.equal(wrapped.code, 0);
  assert.match(wrapped.stderr, /seen yes=undefined package=undefined/);
});
