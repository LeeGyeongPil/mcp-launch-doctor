// Shared paths and a small CLI runner for the tests (compiled to dist/test/).
import { spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
export const FIXTURE = fileURLToPath(new URL('../../fixtures/fault-server.mjs', import.meta.url));
export const PY_FIXTURE = fileURLToPath(new URL('../../fixtures/fault_server.py', import.meta.url));
export const CONFIGS = fileURLToPath(new URL('../../fixtures/configs/', import.meta.url));

// 테스트의 시간 값은 두 종류뿐이다(코어 수만큼 바쁜 프로세스를 띄운 맥에서 잰 기동 시간: node 12~55 s).
//  - NODE_LIMIT_MS: node 자식(픽스처·wrap)이 "제한 안에 답해야" 통과하는 테스트에 주는 시작 제한.
//    빨리 답하면 기다리지 않으므로 평소 비용은 0. node 두 번 기동(wrap → 픽스처)이 각각 55 s 걸려도
//    ok(제한의 50% = 300 s 미만)가 바뀌지 않는다. 시간 초과를 보는 테스트는 짧은 제한을 따로 쓴다.
//  - HANG_GUARD_MS: 자식 프로세스가 끝나지 않을 때 테스트를 멈추는 안전장치(판정에는 쓰지 않는다).
export const NODE_LIMIT_MS = 600_000;
export const NODE_LIMIT_FLAG = String(NODE_LIMIT_MS);
export const HANG_GUARD_MS = 15 * 60_000;

/** process.env without the variables that would change the tool's language or the fixtures. */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ['MCP_LAUNCH_DOCTOR_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'FAULT', 'SLOW_MS', 'PYTHONUNBUFFERED', 'MCP_TIMEOUT', 'FIRSTRUN_MARKER']) delete env[k];
  return { ...env, ...extra };
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI and collects its output. */
export function runCli(args: string[], opts: { env?: Record<string, string>; cwd?: string; input?: string; timeoutMs?: number } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: opts.env ?? cleanEnv(), cwd: opts.cwd ?? REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${args.join(' ')}\n${stderr}`));
    }, opts.timeoutMs ?? HANG_GUARD_MS);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Spawns the fault fixture, sends the handshake, and returns its raw stdout bytes. */
export function fixtureStdout(fault: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE], { env: cleanEnv({ FAULT: fault }), stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks)));
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
    child.stdin.end(JSON.stringify(init) + '\n' + JSON.stringify(list) + '\n');
  });
}

/**
 * Writes a tiny POSIX shell MCP server (test double) to `file` and makes it executable.
 * It answers initialize (id 1) and tools/list (id 2) — the ids session.ts sends — with shell
 * built-ins only, so its answer time does not depend on how long node takes to start on a busy
 * machine (measured with one busy loop per core: sh 0.3-0.7 s, python3 2.2-2.8 s, node 12-55 s).
 *  - firstRunMarker: the first run creates the marker at once (before anything else) and then never
 *    answers — like a package runner still downloading — until the session ends its process group.
 *    Later runs answer normally.
 *  - delaySec: wait this long (an external `sleep`) before answering initialize.
 */
export function writeShellServer(file: string, opts: { firstRunMarker?: string; delaySec?: number } = {}): void {
  const lines = ['#!/bin/sh'];
  if (opts.firstRunMarker) {
    lines.push(`if [ ! -e '${opts.firstRunMarker}' ]; then`, `  : > '${opts.firstRunMarker}'`, '  exec sleep 300', 'fi');
  }
  const wait = opts.delaySec ? `sleep ${opts.delaySec}; ` : '';
  lines.push(
    'while IFS= read -r line; do',
    '  case "$line" in',
    `    *'"id":1,"method":"initialize"'*) ${wait}echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"shell-stub","version":"0"}}}' ;;`,
    `    *'"id":2,"method":"tools/list"'*) echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}}' ;;`,
    '  esac',
    'done',
    '',
  );
  writeFileSync(file, lines.join('\n'));
  chmodSync(file, 0o755);
}

/**
 * Live process check used by cleanup tests. Linux reads /proc; elsewhere signal 0 is used.
 * Returns undefined when the sandbox forbids the check, so the caller can skip only that check.
 */
export function isAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return undefined;
    return undefined;
  }
}
