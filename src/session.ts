// A hand-written MCP stdio client session: spawn -> initialize -> notifications/initialized ->
// tools/list -> shut down. It records what really happened (timings, every stdout line, exit,
// stderr tail) and leaves the judging to diagnose.ts.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { hasFramingDefect, isPollution, LineSplitter, type JsonRpcMessage, type LineRecord } from './framing.js';
import { redactText } from './redact.js';

/** protocolVersion we ask for (MCP spec 2025-11-25). */
export const CLIENT_PROTOCOL_VERSION = '2025-11-25';
/** Versions a current client accepts back (same list as the official TypeScript SDK 1.32.2). */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

export interface LaunchSpec {
  command: string;
  args: string[];
  /** complete environment for the child (the profile already applied) */
  env: Record<string, string>;
  cwd?: string;
}

export interface SessionOptions {
  /** limit for the first answer (initialize), counted from spawn */
  startupTimeoutMs: number;
  /** limit for tools/list after initialize (defaults to startupTimeoutMs) */
  requestTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

export interface SessionObservation {
  spawnError?: { errno: string; message: string };
  cwdMissing?: string;
  /** process id of the server (also its process group id on POSIX) */
  pid?: number;
  exit?: { code: number | null; signal: string | null; atMs: number; beforeShutdown: boolean };
  firstByteMs?: number;
  initializeMs?: number;
  toolsListMs?: number;
  totalMs: number;
  timedOut?: { phase: 'initialize' | 'tools/list'; limitMs: number };
  initialize?: {
    protocolVersion?: string;
    serverName?: string;
    serverVersion?: string;
    hasTools: boolean;
    error?: { code?: number; message?: string };
  };
  toolCount?: number;
  toolsError?: { code?: number; message?: string };
  /** responses whose id matched no request we sent (for example "1" instead of 1) */
  unmatchedResponseIds: Array<string | number | null>;
  stdoutBytes: number;
  lineCount: number;
  /** stdout lines that are not MCP messages (first 20 kept) */
  pollution: LineRecord[];
  pollutionCount: number;
  /** lines with BOM / CRLF / blank / invalid UTF-8 / partial (first 20 kept) */
  framing: LineRecord[];
  framingCounts: { bom: number; crlf: number; blank: number; invalidUtf8: number; partial: number };
  /** last part of stderr, secrets masked */
  stderrTail: string;
}

const KEEP_LINES = 20;
const STDERR_TAIL_CHARS = 2000;

// 진단 중인 자식 프로세스 목록 — Ctrl-C 로 도구가 끝날 때도 남김없이 정리하기 위해 둔다
const active = new Set<ChildProcessWithoutNullStreams>();

/** Kill every server we are still diagnosing (used on SIGINT/SIGTERM). */
export function killActiveSessions(): void {
  for (const child of active) killTree(child, 'SIGKILL');
  active.clear();
}

export async function runSession(spec: LaunchSpec, opts: SessionOptions): Promise<SessionObservation> {
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const obs: SessionObservation = {
    totalMs: 0,
    unmatchedResponseIds: [],
    stdoutBytes: 0,
    lineCount: 0,
    pollution: [],
    pollutionCount: 0,
    framing: [],
    framingCounts: { bom: 0, crlf: 0, blank: 0, invalidUtf8: 0, partial: 0 },
    stderrTail: '',
  };

  // 존재하지 않는 cwd 도 spawn 에서는 ENOENT 로 보여 명령 못 찾음과 헷갈리므로 먼저 따로 확인한다
  if (spec.cwd && !(existsSync(spec.cwd) && statSync(spec.cwd).isDirectory())) {
    obs.cwdMissing = spec.cwd;
    obs.totalMs = now();
    return obs;
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(spec.command, spec.args, {
      env: spec.env,
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, // 앱처럼 셸 없이 바로 실행한다(셸 프로필·별칭이 끼어들지 않게)
      detached: process.platform !== 'win32', // 새 프로세스 그룹 → npx 하위 node 까지 한 번에 정리
      windowsHide: true,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    obs.spawnError = { errno: e.code ?? 'ERR', message: e.message };
    obs.totalMs = now();
    return obs;
  }
  active.add(child);
  obs.pid = child.pid;

  let shutdownStarted = false; // true once we close stdin ourselves
  const pending = new Map<number, (msg: JsonRpcMessage | 'gone') => void>();
  const splitter = new LineSplitter();
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((r) => (resolveClosed = r));

  const failAllPending = () => {
    for (const resolve of pending.values()) resolve('gone');
    pending.clear();
  };

  const onLine = (rec: LineRecord) => {
    obs.lineCount++;
    if (isPollution(rec)) {
      obs.pollutionCount++;
      if (obs.pollution.length < KEEP_LINES) obs.pollution.push(rec);
    }
    if (hasFramingDefect(rec)) {
      if (rec.bom) obs.framingCounts.bom++;
      if (rec.crlf) obs.framingCounts.crlf++;
      if (rec.kind === 'blank' && !rec.partial) obs.framingCounts.blank++;
      if (rec.invalidUtf8) obs.framingCounts.invalidUtf8++;
      if (rec.partial) obs.framingCounts.partial++;
      if (obs.framing.length < KEEP_LINES) obs.framing.push({ ...rec, message: undefined });
    }
    const msg = rec.message;
    if (rec.kind !== 'jsonrpc' || !msg) return;
    if (msg.method !== undefined && msg.id !== undefined) {
      // 서버가 클라이언트에 보낸 요청(ping 등) — 최소한으로 답해 서버가 멈추지 않게 한다
      const reply = msg.method === 'ping'
        ? { jsonrpc: '2.0', id: msg.id, result: {} }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not supported by mcp-launch-doctor' } };
      writeLine(reply);
      return;
    }
    if (msg.method !== undefined) return; // 서버 알림은 무시
    const resolve = typeof msg.id === 'number' ? pending.get(msg.id) : undefined;
    if (resolve && typeof msg.id === 'number') {
      pending.delete(msg.id);
      resolve(msg);
    } else {
      obs.unmatchedResponseIds.push(msg.id ?? null);
    }
  };

  const writeLine = (message: object) => {
    if (child.stdin.writable) child.stdin.write(JSON.stringify(message) + '\n');
  };

  child.stdin.on('error', () => { /* EPIPE: server already gone — the exit event tells the story */ });
  child.stdout.on('data', (chunk: Buffer) => {
    if (obs.firstByteMs === undefined) obs.firstByteMs = now();
    obs.stdoutBytes += chunk.length;
    for (const rec of splitter.push(chunk)) onLine(rec);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    obs.stderrTail = (obs.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
  });
  child.on('error', (err: NodeJS.ErrnoException) => {
    // spawn 실패(ENOENT·EACCES)는 비동기 error 이벤트로 온다
    if (!obs.exit) obs.spawnError = { errno: err.code ?? 'ERR', message: err.message };
    failAllPending();
    if (!closed) { closed = true; resolveClosed(); }
  });
  child.on('exit', (code, signal) => {
    obs.exit = { code, signal, atMs: now(), beforeShutdown: !shutdownStarted };
    failAllPending();
  });
  child.on('close', () => {
    for (const rec of splitter.end()) onLine(rec);
    if (!closed) { closed = true; resolveClosed(); }
  });

  const request = (id: number, method: string, params: object, timeoutMs: number) => {
    const answer = new Promise<JsonRpcMessage | 'gone'>((resolve) => pending.set(id, resolve));
    writeLine({ jsonrpc: '2.0', id, method, params });
    return raceTimeout(answer, Math.max(0, timeoutMs));
  };

  // 1) initialize — 제한 시간은 spawn 시점부터 센다(앱이 재는 방식과 같게)
  const init = await request(1, 'initialize', {
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: opts.clientName ?? 'mcp-launch-doctor', version: opts.clientVersion ?? '0' },
  }, opts.startupTimeoutMs - now());

  if (init === 'timeout') {
    obs.timedOut = { phase: 'initialize', limitMs: opts.startupTimeoutMs };
  } else if (init !== 'gone') {
    obs.initializeMs = now();
    const result = (init.result ?? {}) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> };
    obs.initialize = {
      protocolVersion: result.protocolVersion,
      serverName: result.serverInfo?.name,
      serverVersion: result.serverInfo?.version,
      hasTools: !!result.capabilities && typeof result.capabilities === 'object' && 'tools' in result.capabilities,
      error: init.error ? { code: init.error.code, message: init.error.message } : undefined,
    };
    const versionOk = result.protocolVersion !== undefined && SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion);
    if (!init.error && versionOk) {
      // 2) initialized 알림 → 3) tools/list (서버가 tools 기능을 알렸을 때만)
      writeLine({ jsonrpc: '2.0', method: 'notifications/initialized' });
      if (obs.initialize.hasTools) {
        const limit = opts.requestTimeoutMs ?? opts.startupTimeoutMs;
        const sentAt = now();
        const tools = await request(2, 'tools/list', {}, limit);
        if (tools === 'timeout') {
          obs.timedOut = { phase: 'tools/list', limitMs: limit };
        } else if (tools !== 'gone') {
          obs.toolsListMs = now() - sentAt;
          if (tools.error) obs.toolsError = { code: tools.error.code, message: tools.error.message };
          else obs.toolCount = Array.isArray((tools.result as { tools?: unknown[] })?.tools) ? (tools.result as { tools: unknown[] }).tools.length : 0;
        }
      }
    }
  }
  shutdownStarted = true;

  // 4) 종료: stdin 을 닫아 정상 종료를 기다리고, 안 끝나면 프로세스 그룹에 SIGTERM → SIGKILL
  await shutdown(child, closedPromise);
  active.delete(child);
  obs.stderrTail = redactText(obs.stderrTail);
  obs.totalMs = now();
  return obs;
}

async function shutdown(child: ChildProcessWithoutNullStreams, closedPromise: Promise<void>): Promise<void> {
  child.stdin.end();
  if ((await raceTimeout(closedPromise, 500)) === 'timeout') {
    killTree(child, 'SIGTERM');
    if ((await raceTimeout(closedPromise, 1500)) === 'timeout') {
      killTree(child, 'SIGKILL');
      if ((await raceTimeout(closedPromise, 1500)) === 'timeout') {
        // 손자 프로세스가 파이프를 쥐고 있어도 우리 쪽 스트림은 닫아 이벤트 루프를 풀어 준다
        child.stdout.destroy();
        child.stderr.destroy();
      }
    }
  }
  // 서버는 끝났어도 같은 그룹에 남은 손자(npx 하위 node 등)가 있으면 정리한다
  if (groupAlive(child)) {
    killTree(child, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (groupAlive(child)) killTree(child, 'SIGKILL');
  }
}

function groupAlive(child: ChildProcessWithoutNullStreams): boolean {
  if (process.platform === 'win32' || child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/** Resolves with the promise value, or 'timeout' after ms. Always clears its timer. */
export async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}
