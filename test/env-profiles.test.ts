// AC-3: the same server under shell / gui / sdk profiles.
// A temp folder holds `mld-sample-server` (shebang: #!/usr/bin/env mld-fake-node) and `mld-fake-node`
// (a link to this node). Only the shell profile has that folder on PATH, so the gui profile really fails.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parseMissingInterpreter } from '#lib/diagnose';
import { buildProfileEnv, LINUX_GUI_PATH, MACOS_GUI_PATH, parseProfiles, SDK_DEFAULT_VARS } from '#lib/envProfiles';
import { cleanEnv, FIXTURE, runCli } from './helpers.js';

const posix = process.platform !== 'win32';
let dir = '';
let serverPath = '';

before(() => {
  if (!posix) return;
  dir = mkdtempSync(join(tmpdir(), 'mld-env-'));
  symlinkSync(process.execPath, join(dir, 'mld-fake-node'));
  serverPath = join(dir, 'mld-sample-server');
  // 셔뱅이 PATH 의 mld-fake-node 를 찾는 실행 파일 — 실제 서버 코드는 연습용 픽스처를 불러온다
  writeFileSync(serverPath, `#!/usr/bin/env mld-fake-node\nprocess.env.FAULT = 'none';\nimport(${JSON.stringify(pathToFileURL(FIXTURE).href)});\n`);
  chmodSync(serverPath, 0o755);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function shellEnvWithDir(): Record<string, string> {
  const env = cleanEnv();
  return { ...env, PATH: `${dir}${delimiter}${env.PATH ?? ''}` };
}

interface JsonDoc {
  results: Array<{ profile: string; verdict: { kind: string; data: Record<string, unknown> }; fixes: Array<{ forKind: string; format: string; code: string | null }> }>;
}

test('--env all: shell ok, gui not_found, sdk ok; fix has absolute path and interpreter PATH', { skip: !posix }, async () => {
  const res = await runCli(['run', '--env', 'all', '--json', '--', 'mld-sample-server'], { env: shellEnvWithDir() });
  const doc = JSON.parse(res.stdout) as JsonDoc;
  const byProfile = Object.fromEntries(doc.results.map((r) => [r.profile, r]));
  assert.equal(byProfile.shell?.verdict.kind, 'ok');
  assert.equal(byProfile.gui?.verdict.kind, 'not_found');
  assert.equal(byProfile.sdk?.verdict.kind, 'ok', 'the SDK profile keeps PATH');
  assert.equal(res.code, 1, 'gui failure fails the run');

  const fix = byProfile.gui?.fixes.find((f) => f.forKind === 'not_found');
  assert.ok(fix?.code, 'a snippet is offered');
  const snippet = JSON.parse(fix.code) as { mcpServers: Record<string, { command: string; env: { PATH: string } }> };
  const entry = snippet.mcpServers['mld-sample-server'];
  assert.equal(entry?.command, serverPath);
  assert.ok(entry?.env.PATH.split(delimiter).includes(dir), 'PATH holds the interpreter folder');
});

test('absolute path under gui: interpreter_missing with an env.PATH fix', { skip: !posix }, async () => {
  const res = await runCli(['run', '--env', 'gui', '--json', '--', serverPath], { env: shellEnvWithDir() });
  const doc = JSON.parse(res.stdout) as JsonDoc;
  const r = doc.results[0];
  assert.equal(r?.verdict.kind, 'interpreter_missing');
  assert.equal(r?.verdict.data.interpreter, 'mld-fake-node');
  const fix = r?.fixes.find((f) => f.forKind === 'interpreter_missing');
  const snippet = JSON.parse(fix?.code ?? '{}') as { mcpServers: Record<string, { command: string; env: { PATH: string } }> };
  const entry = Object.values(snippet.mcpServers)[0];
  assert.equal(entry?.command, serverPath);
  assert.equal(entry?.env.PATH.split(delimiter)[0], dir);
});

test('Codex TOML fix format for not_found', { skip: !posix }, async () => {
  const res = await runCli(['run', '--client', 'codex', '--env', 'gui', '--json', '--', 'mld-sample-server'], { env: shellEnvWithDir() });
  const doc = JSON.parse(res.stdout) as JsonDoc;
  const fix = doc.results[0]?.fixes.find((f) => f.forKind === 'not_found');
  assert.equal(fix?.format, 'toml');
  assert.match(fix?.code ?? '', /\[mcp_servers\.mld-sample-server\]/);
  assert.match(fix?.code ?? '', /\[mcp_servers\.mld-sample-server\.env\]/);
  assert.ok(fix?.code?.includes(`command = "${serverPath}"`));
});

test('recognizes macOS and Linux "env: X: No such file" messages', () => {
  assert.equal(parseMissingInterpreter('env: node: No such file or directory\n'), 'node');
  assert.equal(parseMissingInterpreter("/usr/bin/env: 'node': No such file or directory\n"), 'node');
  assert.equal(parseMissingInterpreter('/usr/bin/env: ‘python3’: No such file or directory\n'), 'python3');
  assert.equal(parseMissingInterpreter("env: 'uv': No such file or directory"), 'uv');
  assert.equal(parseMissingInterpreter('Error: something else'), undefined);
});

test('profile environments', () => {
  const base = { PATH: '/custom/bin:/usr/bin', HOME: '/home/u', USER: 'u', LOGNAME: 'u', SHELL: '/bin/zsh', TERM: 'xterm', SECRET_THING: 'x', TMPDIR: '/tmp/x', CODEX_ONLY: 'pass' };
  const mac = buildProfileEnv({ profile: 'gui', baseEnv: base, configEnv: { A: '1' }, platform: 'darwin' });
  assert.equal(mac.env?.PATH, MACOS_GUI_PATH);
  assert.equal(mac.env?.HOME, '/home/u');
  assert.equal(mac.env?.SECRET_THING, undefined);
  assert.equal(mac.env?.A, '1');
  const linux = buildProfileEnv({ profile: 'gui', baseEnv: base, configEnv: {}, platform: 'linux' });
  assert.equal(linux.env?.PATH, LINUX_GUI_PATH);
  const sdk = buildProfileEnv({ profile: 'sdk', baseEnv: base, configEnv: { PATH: '/override' }, platform: 'linux' });
  assert.deepEqual(Object.keys(sdk.env ?? {}).sort(), [...SDK_DEFAULT_VARS].sort());
  assert.equal(sdk.env?.PATH, '/override', 'config env wins');
  const shell = buildProfileEnv({ profile: 'shell', baseEnv: base, configEnv: {}, platform: 'linux' });
  assert.equal(shell.env?.SECRET_THING, 'x');
  const passthrough = buildProfileEnv({ profile: 'gui', baseEnv: base, configEnv: {}, passThrough: ['CODEX_ONLY'], platform: 'linux' });
  assert.equal(passthrough.env?.CODEX_ONLY, 'pass');
  const win = buildProfileEnv({ profile: 'gui', baseEnv: base, configEnv: {}, platform: 'win32' });
  assert.equal(win.unsupported, 'win32');
});

test('parseProfiles', () => {
  assert.deepEqual(parseProfiles('all'), ['shell', 'gui', 'sdk']);
  assert.deepEqual(parseProfiles('gui,shell'), ['gui', 'shell']);
  assert.equal(parseProfiles('desktop'), undefined);
});
