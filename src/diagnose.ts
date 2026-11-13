// Turns what a session observed into verdicts, and retries timeouts to find out why.

import { basename } from 'node:path';
import type { ServerSpec } from './config/parse.js';
import { buildProfileEnv, type ProfileName } from './envProfiles.js';
import { buildFixes, type FixSnippet } from './fixes.js';
import type { LineRecord } from './framing.js';
import { runSession, SUPPORTED_PROTOCOL_VERSIONS, type SessionObservation } from './session.js';
import { SLOW_START_RATIO, type ClientName, type StartupLimit } from './timeouts.js';

// 등급별 판정 종류 — 앞에 있을수록 대표 판정으로 먼저 고른다
export const ERROR_KINDS = ['not_found', 'interpreter_missing', 'early_exit', 'startup_timeout', 'protocol_error', 'version_mismatch', 'stdout_pollution'] as const;
export const WARN_KINDS = ['framing_warning', 'unresolved_variable', 'npx_prompt_risk', 'slow_start'] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];
export type WarnKind = (typeof WARN_KINDS)[number];
export type VerdictKind = ErrorKind | WarnKind | 'ok' | 'unsupported';
export type Severity = 'error' | 'warn' | 'ok' | 'info';
export type TimeoutCause = 'buffering' | 'first_run_install' | 'unknown';

export interface Finding {
  kind: VerdictKind;
  severity: Severity;
  cause?: TimeoutCause;
  /** facts used by the message and the fix (language independent) */
  data: Record<string, unknown>;
}

export interface RetryInfo {
  strategy: 'rerun' | 'unbuffered';
  ok: boolean;
  initializeMs?: number;
}

export interface DiagnosisResult {
  server: string;
  client?: ClientName;
  source: string;
  profile: ProfileName | null;
  command: string;
  args: string[];
  launched: boolean;
  limit: StartupLimit;
  verdict: Finding;
  findings: Finding[];
  timings: { firstByteMs?: number; initializeMs?: number; toolsListMs?: number; totalMs?: number };
  serverInfo?: { name?: string; version?: string; protocolVersion?: string };
  toolCount?: number;
  stderrTail?: string;
  retries: RetryInfo[];
  fixes: FixSnippet[];
}

export interface DiagnoseOptions {
  profile: ProfileName;
  limit: StartupLimit;
  retry: boolean;
  baseEnv: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function severityOf(kind: VerdictKind): Severity {
  if ((ERROR_KINDS as readonly string[]).includes(kind)) return 'error';
  if ((WARN_KINDS as readonly string[]).includes(kind)) return 'warn';
  if (kind === 'unsupported') return 'info';
  return 'ok';
}

function finding(kind: VerdictKind, data: Record<string, unknown> = {}, cause?: TimeoutCause): Finding {
  return cause ? { kind, severity: severityOf(kind), cause, data } : { kind, severity: severityOf(kind), data };
}

/** Launches one server under one profile and judges the result (with retries on timeout). */
export async function diagnoseServer(spec: ServerSpec, opts: DiagnoseOptions): Promise<DiagnosisResult> {
  const result = baseResult(spec, opts.profile, opts.limit);

  if (spec.unresolved.length > 0) {
    // 확장 못 한 ${...} 가 남은 서버는 엉뚱한 값으로 띄우지 않고 실행 전 경고만 낸다
    return finish(result, [finding('unresolved_variable', { placeholders: spec.unresolved })], spec, opts);
  }

  const built = buildProfileEnv({ profile: opts.profile, baseEnv: opts.baseEnv, configEnv: spec.env, passThrough: spec.passThrough, platform: opts.platform });
  if (built.env === undefined) {
    return finish(result, [finding('unsupported', { platform: built.unsupported })], spec, opts);
  }

  const launch = { command: spec.command, args: spec.args, env: built.env, cwd: spec.cwd };
  const sessionOpts = { startupTimeoutMs: opts.limit.ms };
  const obs = await runSession(launch, sessionOpts);
  result.launched = true;
  const findings = analyze(obs, opts.limit);
  if (isNpxWithoutYes(spec)) findings.push(finding('npx_prompt_risk', {}));
  recordObservation(result, obs);

  const timeout = findings.find((f) => f.kind === 'startup_timeout');
  if (timeout && obs.timedOut?.phase === 'initialize') {
    timeout.cause = 'unknown';
    if (opts.retry) {
      // 같은 조건에서 원인 하나만 바꿔 다시 띄운다: 재실행(설치 캐시) → 버퍼링 해제 순서
      for (const strategy of retryStrategies(spec)) {
        const env = strategy === 'unbuffered' ? { ...launch.env, PYTHONUNBUFFERED: '1' } : launch.env;
        const again = await runSession({ ...launch, env }, sessionOpts);
        const ok = again.initializeMs !== undefined && !again.timedOut;
        result.retries.push({ strategy, ok, initializeMs: again.initializeMs });
        if (ok) {
          timeout.cause = strategy === 'rerun' ? 'first_run_install' : 'buffering';
          timeout.data.retryInitializeMs = again.initializeMs;
          break;
        }
      }
    }
  }
  return finish(result, findings, spec, opts);
}

function baseResult(spec: ServerSpec, profile: ProfileName, limit: StartupLimit): DiagnosisResult {
  return {
    server: spec.name,
    client: spec.client,
    source: spec.source,
    profile,
    command: spec.command,
    args: spec.args,
    launched: false,
    limit,
    verdict: finding('ok'),
    findings: [],
    timings: {},
    retries: [],
    fixes: [],
  };
}

function recordObservation(result: DiagnosisResult, obs: SessionObservation): void {
  result.timings = { firstByteMs: obs.firstByteMs, initializeMs: obs.initializeMs, toolsListMs: obs.toolsListMs, totalMs: obs.totalMs };
  if (obs.initialize) result.serverInfo = { name: obs.initialize.serverName, version: obs.initialize.serverVersion, protocolVersion: obs.initialize.protocolVersion };
  result.toolCount = obs.toolCount;
  result.stderrTail = obs.stderrTail;
}

function finish(result: DiagnosisResult, findings: Finding[], spec: ServerSpec, opts: DiagnoseOptions): DiagnosisResult {
  const all = findings.length > 0 ? findings : [finding('ok')];
  result.findings = all;
  result.verdict = pickPrimary(all);
  result.fixes = buildFixes(result, spec, { baseEnv: opts.baseEnv, platform: opts.platform ?? process.platform });
  return result;
}

const ORDER: VerdictKind[] = [...ERROR_KINDS, ...WARN_KINDS, 'unsupported', 'ok'];
export function pickPrimary(findings: Finding[]): Finding {
  return [...findings].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))[0] ?? finding('ok');
}

// macOS: "env: node: No such file or directory"
// Linux: "/usr/bin/env: 'node': No such file or directory" (또는 로캘에 따라 ‘node’)
const ENV_MISSING = /env:\s*['‘"]?([^'’":\s]+)['’"]?:\s*No such file or directory/;

export function parseMissingInterpreter(stderr: string): string | undefined {
  return ENV_MISSING.exec(stderr)?.[1];
}

/** Pure judgement of one observation (no retries). */
export function analyze(obs: SessionObservation, limit: StartupLimit): Finding[] {
  const out: Finding[] = [];

  if (obs.cwdMissing) return [finding('not_found', { what: 'cwd', path: obs.cwdMissing })];
  if (obs.spawnError) return [finding('not_found', { what: 'command', errno: obs.spawnError.errno, message: obs.spawnError.message })];

  if (obs.exit?.beforeShutdown) {
    // 우리가 stdin 을 닫기 전에 스스로 끝났다 — 어느 단계에서 끝났는지 함께 남긴다
    const interpreter = obs.exit.code === 127 ? parseMissingInterpreter(obs.stderrTail) : undefined;
    let phase = 'after_handshake';
    if (!obs.initialize) phase = 'initialize';
    else if (obs.initialize.hasTools && obs.toolsListMs === undefined) phase = 'tools/list';
    if (interpreter) out.push(finding('interpreter_missing', { interpreter, code: obs.exit.code }));
    else out.push(finding('early_exit', { code: obs.exit.code, signal: obs.exit.signal, atMs: obs.exit.atMs, phase }));
  }

  if (obs.timedOut) {
    if (obs.unmatchedResponseIds.length > 0) {
      out.push(finding('protocol_error', { reason: 'id_mismatch', ids: obs.unmatchedResponseIds.slice(0, 5) }));
    } else {
      out.push(finding('startup_timeout', { phase: obs.timedOut.phase, limitMs: obs.timedOut.limitMs, client: limit.client, limitSource: limit.source, known: limit.known }));
    }
  }

  if (obs.initialize) {
    const v = obs.initialize.protocolVersion;
    if (obs.initialize.error) out.push(finding('protocol_error', { reason: 'initialize_error', code: obs.initialize.error.code, message: obs.initialize.error.message }));
    else if (v === undefined) out.push(finding('protocol_error', { reason: 'no_protocol_version' }));
    else if (!SUPPORTED_PROTOCOL_VERSIONS.includes(v)) out.push(finding('version_mismatch', { got: v, supported: SUPPORTED_PROTOCOL_VERSIONS }));
  }
  if (obs.toolsError) out.push(finding('protocol_error', { reason: 'tools_list_error', code: obs.toolsError.code, message: obs.toolsError.message }));

  if (obs.pollutionCount > 0) {
    out.push(finding('stdout_pollution', { count: obs.pollutionCount, lines: obs.pollution.slice(0, 5).map(lineFacts) }));
  }
  const fc = obs.framingCounts;
  if (fc.bom + fc.crlf + fc.blank + fc.invalidUtf8 + fc.partial > 0) {
    out.push(finding('framing_warning', { ...fc, lines: obs.framing.slice(0, 5).map(lineFacts) }));
  }

  if (obs.initializeMs !== undefined && !obs.timedOut && obs.initializeMs > limit.ms * SLOW_START_RATIO) {
    out.push(finding('slow_start', { initializeMs: obs.initializeMs, limitMs: limit.ms, client: limit.client }));
  }
  return out;
}

function lineFacts(rec: LineRecord): Record<string, unknown> {
  const flags = [rec.bom && 'bom', rec.crlf && 'crlf', rec.kind === 'blank' && 'blank', rec.invalidUtf8 && 'invalid_utf8', rec.partial && 'partial_line'].filter(Boolean);
  return { line: rec.index + 1, offset: rec.offset, kind: rec.kind, flags, preview: rec.preview };
}

// ---- 재시도 규칙 -------------------------------------------------------------

function commandName(command: string): string {
  return basename(command).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

export function isPackageRunner(spec: Pick<ServerSpec, 'command' | 'args'>): boolean {
  const name = commandName(spec.command);
  if (['npx', 'uvx', 'bunx', 'pnpx'].includes(name)) return true;
  return (name === 'pnpm' || name === 'yarn') && spec.args[0] === 'dlx';
}

export function isPythonLike(spec: Pick<ServerSpec, 'command' | 'args'>): boolean {
  const name = commandName(spec.command);
  if (/^python[0-9.]*$/.test(name) || name === 'uv' || name === 'uvx' || name.endsWith('.py')) return true;
  return spec.args.some((a) => a.endsWith('.py'));
}

export function retryStrategies(spec: Pick<ServerSpec, 'command' | 'args'>): Array<'rerun' | 'unbuffered'> {
  const out: Array<'rerun' | 'unbuffered'> = [];
  if (isPackageRunner(spec)) out.push('rerun');
  if (isPythonLike(spec)) out.push('unbuffered');
  return out;
}

export function isNpxWithoutYes(spec: Pick<ServerSpec, 'command' | 'args'>): boolean {
  return commandName(spec.command) === 'npx' && !spec.args.includes('-y') && !spec.args.includes('--yes');
}

/** Exit code for --fail-on. */
export function exitCodeFor(results: DiagnosisResult[], failOn: 'error' | 'warn' | 'never'): 0 | 1 {
  if (failOn === 'never') return 0;
  const severities = results.flatMap((r) => r.findings.map((f) => f.severity));
  if (severities.includes('error')) return 1;
  if (failOn === 'warn' && severities.includes('warn')) return 1;
  return 0;
}
