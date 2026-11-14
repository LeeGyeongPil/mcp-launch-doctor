// AC-9: English and Korean output, language precedence, language-independent JSON.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LANG_ENV, MESSAGES, resolveLang, t } from '#lib/i18n';
import { cleanEnv, FIXTURE, NODE_LIMIT_FLAG, runCli } from './helpers.js';

test('en and ko have exactly the same message keys and placeholders', () => {
  const en = Object.keys(MESSAGES.en).sort();
  const ko = Object.keys(MESSAGES.ko).sort();
  assert.deepEqual(ko, en);
  const placeholders = (s: string) => [...new Set([...s.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]))].sort();
  for (const key of en) {
    const k = key as keyof typeof MESSAGES.en;
    assert.deepEqual(placeholders(MESSAGES.ko[k]), placeholders(MESSAGES.en[k]), `placeholders of ${key}`);
    assert.ok(MESSAGES.ko[k].length > 0, `${key} is not empty`);
  }
});

test('precedence: --lang > MCP_LAUNCH_DOCTOR_LANG > LC_ALL > LC_MESSAGES > LANG > English', () => {
  assert.equal(resolveLang('en', { [LANG_ENV]: 'ko', LANG: 'ko_KR.UTF-8' }), 'en');
  assert.equal(resolveLang('ko', {}), 'ko');
  assert.equal(resolveLang(undefined, { [LANG_ENV]: 'ko', LANG: 'en_US.UTF-8' }), 'ko');
  assert.equal(resolveLang(undefined, { [LANG_ENV]: 'en', LC_ALL: 'ko_KR.UTF-8' }), 'en');
  assert.equal(resolveLang(undefined, { LC_ALL: 'ko_KR.UTF-8', LANG: 'en_US' }), 'ko');
  assert.equal(resolveLang(undefined, { LC_ALL: 'C', LANG: 'ko_KR.UTF-8' }), 'en');
  assert.equal(resolveLang(undefined, { LC_MESSAGES: 'ko_KR', LANG: 'en_US' }), 'ko');
  assert.equal(resolveLang(undefined, { LANG: 'ko_KR.UTF-8' }), 'ko');
  assert.equal(resolveLang(undefined, { LANG: 'fr_FR.UTF-8' }), 'en');
  assert.equal(resolveLang(undefined, {}), 'en');
});

test('t() fills placeholders', () => {
  assert.equal(t('en', 'summary', { ok: 1, warn: 2, error: 3, total: 6 }), 'Summary: 1 ok, 2 warning, 3 error (6 run(s)).');
  assert.equal(t('ko', 'summary', { ok: 1, warn: 2, error: 3, total: 6 }), '요약: 정상 1, 경고 2, 오류 3 (실행 6회).');
});

test('--help in each language', async () => {
  const ko = await runCli(['--help', '--lang', 'ko']);
  assert.match(ko.stdout, /사용법/);
  const en = await runCli(['--help', '--lang', 'en']);
  assert.match(en.stdout, /Usage/);
  assert.doesNotMatch(en.stdout, /사용법/);
  const viaEnv = await runCli(['--help'], { env: cleanEnv({ LANG: 'ko_KR.UTF-8' }) });
  assert.match(viaEnv.stdout, /사용법/);
  const toolEnv = await runCli(['--help'], { env: cleanEnv({ MCP_LAUNCH_DOCTOR_LANG: 'ko', LANG: 'en_US.UTF-8' }) });
  assert.match(toolEnv.stdout, /사용법/);
  const flagWins = await runCli(['--help', '--lang', 'en'], { env: cleanEnv({ MCP_LAUNCH_DOCTOR_LANG: 'ko' }) });
  assert.match(flagWins.stdout, /Usage/);
});

test('demo table headers and the practice notice follow --lang', async () => {
  // 판정 설명 문구(JSON-RPC 가 아닙니다 / are not JSON-RPC)는 판정이 node 기동 시간에 흔들리지 않도록
  // test/demo.test.ts 가 넉넉한 제한으로 얻은 데모 결과를 renderHuman 으로 그려 언어별로 검사한다
  const ko = await runCli(['demo', '--lang', 'ko']);
  assert.match(ko.stdout, /서버\s+환경\s+판정\s+첫 응답\s+도구/);
  assert.match(ko.stdout, /목\(mock\) 서버/);
  const en = await runCli(['demo', '--lang', 'en']);
  assert.match(en.stdout, /SERVER\s+ENV\s+RESULT\s+FIRST ANSWER\s+TOOLS/);
  assert.match(en.stdout, /mock servers/);
});

test('JSON keys and kinds are the same in both languages; only messages change', async () => {
  const run = (lang: string) => runCli(['run', '--json', '--lang', lang, '--timeout', NODE_LIMIT_FLAG, '--', process.execPath, FIXTURE], { env: cleanEnv({ FAULT: 'banner' }) });
  const en = JSON.parse((await run('en')).stdout) as { results: Array<{ verdict: { kind: string; message: string } }> };
  const ko = JSON.parse((await run('ko')).stdout) as { results: Array<{ verdict: { kind: string; message: string } }> };
  const shape = (v: unknown): unknown => (Array.isArray(v) ? v.map(shape) : v && typeof v === 'object' ? Object.keys(v).sort() : typeof v);
  assert.deepEqual(shape(ko.results[0]), shape(en.results[0]));
  assert.equal(ko.results[0]?.verdict.kind, en.results[0]?.verdict.kind);
  assert.equal(en.results[0]?.verdict.kind, 'stdout_pollution');
  assert.notEqual(ko.results[0]?.verdict.message, en.results[0]?.verdict.message);
  assert.match(ko.results[0]?.verdict.message ?? '', /stdout/);
});
