// AC-8/AC-9: the demo's 9 practice fixtures get their own verdicts, and the explanations follow the language.
// Same server definitions as `demo` (demoSpec), same session/diagnosis code — only the start-up limit is
// injected: the fixtures that must answer get a roomy limit (NODE_LIMIT_MS), so a busy machine where node
// needs many seconds to start cannot turn `ok` into `slow_start` or `startup_timeout`.
// The `slow` fixture keeps the real demo limit (DEMO_LIMIT_MS 2500 ms against its 4000 ms delay): a slower
// start only makes that timeout more certain.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DEMO_FAULTS, DEMO_LIMIT_MS, demoSpec } from '#lib/demo';
import { diagnoseServer, type DiagnosisResult } from '#lib/diagnose';
import { renderHuman } from '#lib/report';
import type { StartupLimit } from '#lib/timeouts';
import { cleanEnv, NODE_LIMIT_MS } from './helpers.js';

const ROOMY: StartupLimit = { ms: NODE_LIMIT_MS, source: 'demo', known: true };
const DEMO: StartupLimit = { ms: DEMO_LIMIT_MS, source: 'demo', known: true };

// 픽스처마다 한 번씩만 띄우고, 아래 테스트들이 같은 결과를 나눠 본다
const results: DiagnosisResult[] = [];
before(async () => {
  for (const fault of DEMO_FAULTS) {
    const limit = fault === 'slow' ? DEMO : ROOMY;
    results.push(await diagnoseServer(demoSpec(fault), { profile: 'shell', limit, retry: true, baseEnv: cleanEnv() }));
  }
});

test('each demo fixture gets its own verdict kind', () => {
  assert.equal(results.length, 9);
  const kinds = Object.fromEntries(results.map((r) => [r.server, r.verdict.kind]));
  assert.deepEqual(kinds, {
    'fault:none': 'ok',
    'fault:banner': 'stdout_pollution',
    'fault:slow': 'startup_timeout',
    'fault:exit': 'early_exit',
    'fault:version': 'version_mismatch',
    'fault:crlf': 'framing_warning',
    'fault:bom': 'framing_warning',
    'fault:notjsonrpc': 'stdout_pollution',
    'fault:partial': 'framing_warning',
  });
  // slow 는 실제 데모 제한으로 판정됐다
  assert.equal(results.find((r) => r.server === 'fault:slow')?.verdict.data.limitMs, DEMO_LIMIT_MS);
});

test('the English demo report names every verdict kind and explains stdout pollution', () => {
  const en = renderHuman(results, [], { lang: 'en', command: 'demo', version: '0', practice: true, exitCode: 0 });
  assert.match(en.split('\n')[0] ?? '', /practice fixtures \(mock servers\)/);
  assert.match(en, /SERVER\s+ENV\s+RESULT\s+FIRST ANSWER\s+TOOLS/);
  for (const kind of ['stdout_pollution', 'startup_timeout', 'early_exit', 'version_mismatch', 'framing_warning', 'ok']) {
    assert.ok(en.includes(kind), `demo report mentions ${kind}`);
  }
  assert.match(en, /are not JSON-RPC/);
  assert.doesNotMatch(en, /JSON-RPC 가 아닙니다/);
});

test('the Korean demo report has Korean headers and explanations', () => {
  const ko = renderHuman(results, [], { lang: 'ko', command: 'demo', version: '0', practice: true, exitCode: 0 });
  assert.match(ko, /목\(mock\) 서버/);
  assert.match(ko, /서버\s+환경\s+판정\s+첫 응답\s+도구/);
  assert.match(ko, /JSON-RPC 가 아닙니다/);
  assert.doesNotMatch(ko, /are not JSON-RPC/);
});
