// `demo`: runs the bundled practice fixtures (mock MCP servers, fixtures/fault-server.mjs).
// They are real child processes that really misbehave, and they go through exactly the same
// session/diagnosis code as your own servers — only the servers are fake.

import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerSpec } from './config/parse.js';
import { diagnoseServer, type DiagnosisResult } from './diagnose.js';
import { which } from './fixes.js';
import type { StartupLimit } from './timeouts.js';

export const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/fault-server.mjs', import.meta.url));
const FIXTURE_DIR = dirname(FIXTURE_PATH);

/** healthy baseline + 8 faults */
export const DEMO_FAULTS = ['none', 'banner', 'slow', 'exit', 'version', 'crlf', 'bom', 'notjsonrpc', 'partial'] as const;

// 데모 제한 시간: 정상 픽스처는 넉넉히 통과하고, slow 픽스처(4초)는 확실히 넘는 값
export const DEMO_LIMIT_MS = 2500;
const DEMO_SLOW_MS = '4000';

// 픽스처는 그 폴더(cwd)에서 파일 이름으로 띄운다 — 출력·고칠 조각에 설치 위치(npx 캐시·홈 폴더)가 찍히지 않게
export function demoSpec(fault: string, node: string = process.execPath): ServerSpec {
  return {
    name: `fault:${fault}`,
    command: node,
    args: ['fault-server.mjs'],
    cwd: FIXTURE_DIR,
    env: { FAULT: fault, SLOW_MS: DEMO_SLOW_MS },
    passThrough: [],
    source: 'practice fixture',
    unresolved: [],
  };
}

/** "node" when the node on PATH is the one running this tool (short output), else this node's own path. */
function demoNode(pathValue: string): string {
  const onPath = which('node', pathValue);
  try {
    if (onPath && realpathSync(onPath) === realpathSync(process.execPath)) return 'node';
  } catch {
    /* fall through */
  }
  return process.execPath;
}

export async function runDemo(baseEnv: NodeJS.ProcessEnv, onProgress?: (name: string) => void): Promise<DiagnosisResult[]> {
  const limit: StartupLimit = { ms: DEMO_LIMIT_MS, source: 'demo', known: true };
  const node = demoNode(baseEnv.PATH ?? '');
  const results: DiagnosisResult[] = [];
  for (const fault of DEMO_FAULTS) {
    const spec = demoSpec(fault, node);
    onProgress?.(spec.name);
    results.push(await diagnoseServer(spec, { profile: 'shell', limit, retry: true, baseEnv }));
  }
  return results;
}
