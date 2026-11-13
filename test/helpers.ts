// Shared paths and a small CLI runner for the tests (compiled to dist/test/).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
export const FIXTURE = fileURLToPath(new URL('../../fixtures/fault-server.mjs', import.meta.url));
export const PY_FIXTURE = fileURLToPath(new URL('../../fixtures/fault_server.py', import.meta.url));
export const CONFIGS = fileURLToPath(new URL('../../fixtures/configs/', import.meta.url));

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
    }, opts.timeoutMs ?? 60_000);
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
