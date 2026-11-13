// Output: a table for people, stable JSON for machines (schemaVersion 1).
// Kinds and JSON keys stay in English; only the "message"/"note" texts follow --lang.

import type { ServerSpec, SkippedEntry } from './config/parse.js';
import type { DiagnosisResult, Finding } from './diagnose.js';
import { t, type Lang, type MessageKey, type Params } from './i18n.js';
import { redactArgs, redactEnv, redactText } from './redact.js';
import type { StartupLimit } from './timeouts.js';

export const SCHEMA_VERSION = 1;

export interface ReportMeta {
  lang: Lang;
  command: 'check' | 'run' | 'demo';
  version: string;
  /** demo: practice fixtures notice */
  practice?: boolean;
  exitCode: number;
}

// ---- 문구 만들기 ------------------------------------------------------------

export function limitLabel(limit: StartupLimit, lang: Lang): string {
  const client = limit.client ?? '';
  switch (limit.source) {
    case 'flag': return t(lang, 'limit.flag');
    case 'config': return t(lang, 'limit.config', { client });
    case 'client_default': return t(lang, 'limit.client_default', { client });
    case 'env': return t(lang, 'limit.env');
    case 'tool_default': return t(lang, 'limit.tool_default');
    case 'demo': return t(lang, 'limit.demo');
  }
}

/** Human sentence for one finding, in the chosen language. */
export function describe(f: Finding, r: DiagnosisResult, lang: Lang): string {
  const d = f.data;
  const phase = (p: unknown) => t(lang, `phase.${String(p)}` as MessageKey);
  switch (f.kind) {
    case 'ok':
      return t(lang, 'verdict.ok', {
        name: r.serverInfo?.name ?? '?', version: r.serverInfo?.version ?? '', protocol: r.serverInfo?.protocolVersion ?? '?',
        initMs: r.timings.initializeMs, tools: r.toolCount ?? 0,
      });
    case 'not_found':
      return d.what === 'cwd'
        ? t(lang, 'verdict.not_found_cwd', { path: String(d.path) })
        : t(lang, 'verdict.not_found', { command: r.command, errno: String(d.errno) });
    case 'interpreter_missing':
      return t(lang, 'verdict.interpreter_missing', { interpreter: String(d.interpreter), code: d.code as number });
    case 'early_exit':
      return t(lang, 'verdict.early_exit', { code: d.code === null ? String(d.signal) : (d.code as number), phase: phase(d.phase) });
    case 'startup_timeout': {
      const base = t(lang, 'verdict.startup_timeout', { phase: phase(d.phase), limitMs: d.limitMs as number, limitLabel: limitLabel(r.limit, lang) });
      return f.cause ? `${base} ${causeText(f, lang)}` : base;
    }
    case 'protocol_error':
      if (d.reason === 'id_mismatch') return t(lang, 'verdict.protocol_error_id', { ids: JSON.stringify(d.ids) });
      if (d.reason === 'initialize_error') return t(lang, 'verdict.protocol_error_init', { message: String(d.message), code: d.code as number });
      if (d.reason === 'tools_list_error') return t(lang, 'verdict.protocol_error_tools', { message: String(d.message), code: d.code as number });
      return t(lang, 'verdict.protocol_error_noversion');
    case 'version_mismatch':
      return t(lang, 'verdict.version_mismatch', { got: String(d.got), supported: (d.supported as string[]).join(', ') });
    case 'stdout_pollution':
      return t(lang, 'verdict.stdout_pollution', { count: d.count as number });
    case 'framing_warning':
      return t(lang, 'verdict.framing_warning', { details: framingDetails(d, lang) });
    case 'unresolved_variable':
      return t(lang, 'verdict.unresolved_variable', { placeholders: (d.placeholders as string[]).join('; ') });
    case 'npx_prompt_risk':
      return t(lang, 'verdict.npx_prompt_risk');
    case 'slow_start':
      return t(lang, 'verdict.slow_start', { initMs: d.initializeMs as number, limitMs: d.limitMs as number, limitLabel: limitLabel(r.limit, lang) });
    case 'unsupported':
      return t(lang, 'verdict.unsupported', { platform: String(d.platform) });
  }
}

function causeText(f: Finding, lang: Lang): string {
  const ms = f.data.retryInitializeMs as number | undefined;
  if (f.cause === 'buffering') return t(lang, 'cause.buffering', { ms });
  if (f.cause === 'first_run_install') return t(lang, 'cause.first_run_install', { ms });
  return t(lang, 'cause.unknown');
}

function framingDetails(d: Record<string, unknown>, lang: Lang): string {
  const parts: string[] = [];
  const add = (key: MessageKey, n: unknown) => { if (typeof n === 'number' && n > 0) parts.push(t(lang, key, { n })); };
  add('framing.bom', d.bom);
  add('framing.crlf', d.crlf);
  add('framing.blank', d.blank);
  add('framing.invalid_utf8', d.invalidUtf8);
  add('framing.partial', d.partial);
  return parts.join(', ');
}

function lineItems(f: Finding, lang: Lang): string[] {
  const lines = (f.data.lines as Array<Record<string, unknown>> | undefined) ?? [];
  return lines.map((l) => {
    const flags = (l.flags as string[]).length > 0 ? `, ${(l.flags as string[]).join(', ')}` : '';
    const params: Params = { line: l.line as number, offset: l.offset as number, kind: String(l.kind), flags, preview: l.preview === undefined ? '' : JSON.stringify(l.preview) };
    return t(lang, 'lines.item', params).trimEnd();
  });
}

// ---- 사람용 표 --------------------------------------------------------------

/** Terminal width of a string: Hangul and CJK take two columns. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

function resultCell(r: DiagnosisResult): string {
  const v = r.verdict;
  return v.cause ? `${v.kind} (${v.cause})` : v.kind;
}

function timeCell(r: DiagnosisResult): string {
  if (r.timings.initializeMs !== undefined) return `${r.timings.initializeMs} ms`;
  if (r.findings.some((f) => f.kind === 'startup_timeout')) return `> ${r.limit.ms} ms`;
  return '-';
}

function indent(text: string, spaces: number): string {
  const pre = ' '.repeat(spaces);
  return text.split('\n').map((l) => (l ? pre + l : l)).join('\n');
}

export function renderTable(results: DiagnosisResult[], lang: Lang): string {
  const header = [t(lang, 'table.server'), t(lang, 'table.env'), t(lang, 'table.result'), t(lang, 'table.time'), t(lang, 'table.tools')];
  const rows = results.map((r) => [r.client ? `${r.server} (${r.client})` : r.server, r.profile ?? '-', resultCell(r), timeCell(r), r.toolCount === undefined ? '-' : String(r.toolCount)]);
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...rows.map((row) => displayWidth(row[i] ?? ''))));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i] ?? 0))).join('  ').trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}

export function renderDetails(r: DiagnosisResult, lang: Lang): string {
  const out: string[] = [t(lang, 'section.details', { server: r.server, profile: r.profile ?? '-' })];
  if (r.source && r.source !== 'command line' && r.source !== 'practice fixture') out.push(indent(t(lang, 'section.source', { source: r.source }), 2));
  for (const f of r.findings) {
    if (f.severity === 'ok') continue;
    out.push(indent(`[${f.severity.toUpperCase()}] ${f.kind}: ${describe(f, r, lang)}`, 2));
    for (const item of lineItems(f, lang)) out.push(indent(item, 6));
  }
  for (const retry of r.retries) {
    const result = retry.ok ? t(lang, 'retry.ok', { ms: retry.initializeMs }) : t(lang, 'retry.failed');
    out.push(indent(t(lang, retry.strategy === 'rerun' ? 'retry.rerun' : 'retry.unbuffered', { result }), 6));
  }
  for (const fix of r.fixes) {
    out.push(indent(`${t(lang, 'section.fix')} (${fix.forKind}): ${t(lang, fix.note as MessageKey, fix.data as Params)}`, 2));
    if (fix.code) out.push(indent(fix.code.trimEnd(), 6));
    if (fix.code?.includes('***')) out.push(indent(t(lang, 'fix.masked_note'), 6));
  }
  const showStderr = r.stderrTail && r.findings.some((f) => f.severity === 'error');
  if (showStderr) {
    out.push(indent(t(lang, 'section.stderr'), 2));
    const tail = (r.stderrTail ?? '').trimEnd().split('\n').slice(-6).join('\n');
    out.push(indent(tail, 6));
  }
  return out.join('\n');
}

export function summarize(results: DiagnosisResult[]): { ok: number; warn: number; error: number; total: number } {
  const s = { ok: 0, warn: 0, error: 0, total: results.length };
  for (const r of results) {
    if (r.verdict.severity === 'error') s.error++;
    else if (r.verdict.severity === 'warn') s.warn++;
    else s.ok++;
  }
  return s;
}

export function renderHuman(results: DiagnosisResult[], skipped: SkippedEntry[], meta: ReportMeta): string {
  const out: string[] = [];
  if (meta.practice) out.push(t(meta.lang, 'demo.notice'), '');
  out.push(renderTable(results, meta.lang));
  for (const r of results) {
    if (r.verdict.severity === 'ok') continue;
    out.push('', renderDetails(r, meta.lang));
  }
  if (skipped.length > 0) out.push('', renderSkipped(skipped, meta.lang));
  const s = summarize(results);
  out.push('', t(meta.lang, 'summary', s));
  if (meta.practice) out.push(t(meta.lang, 'demo.next'));
  return out.join('\n');
}

function renderSkipped(skipped: SkippedEntry[], lang: Lang): string {
  const lines = [t(lang, 'skipped.header')];
  for (const s of skipped) lines.push('  ' + t(lang, `skipped.${s.reason}` as MessageKey, { name: s.name, client: s.client, detail: s.detail ?? '' }));
  return lines.join('\n');
}

// ---- JSON -------------------------------------------------------------------

export function renderJson(results: DiagnosisResult[], skipped: SkippedEntry[], meta: ReportMeta): string {
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'mcp-launch-doctor', version: meta.version },
    command: meta.command,
    lang: meta.lang,
    ...(meta.practice ? { practice: true, notice: t(meta.lang, 'demo.notice') } : {}),
    results: results.map((r) => ({
      server: r.server,
      client: r.client ?? null,
      source: r.source,
      profile: r.profile,
      command: redactText(r.command),
      args: redactArgs(r.args),
      launched: r.launched,
      limit: r.limit,
      verdict: { ...findingJson(r.verdict, r, meta.lang) },
      findings: r.findings.map((f) => findingJson(f, r, meta.lang)),
      timings: r.timings,
      serverInfo: r.serverInfo ?? null,
      toolCount: r.toolCount ?? null,
      retries: r.retries,
      stderrTail: r.stderrTail ?? '',
      fixes: r.fixes.map((fx) => ({ forKind: fx.forKind, format: fx.format, code: fx.code ?? null, note: t(meta.lang, fx.note as MessageKey, fx.data as Params) })),
    })),
    skipped,
    summary: summarize(results),
    exitCode: meta.exitCode,
  };
  return JSON.stringify(doc, null, 2);
}

function findingJson(f: Finding, r: DiagnosisResult, lang: Lang) {
  return { kind: f.kind, severity: f.severity, cause: f.cause ?? null, message: describe(f, r, lang), data: f.data };
}

// ---- 시험 실행(--dry-run) ----------------------------------------------------

export interface DryRunEntry {
  spec: ServerSpec;
  limit: StartupLimit;
  profiles: string[];
}

export function renderDryRunJson(entries: DryRunEntry[], skipped: SkippedEntry[], meta: Omit<ReportMeta, 'exitCode'>): string {
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'mcp-launch-doctor', version: meta.version },
    command: meta.command,
    dryRun: true,
    servers: entries.map(({ spec, limit, profiles }) => ({
      server: spec.name,
      client: spec.client ?? null,
      source: spec.source,
      command: redactText(spec.command),
      args: redactArgs(spec.args),
      env: redactEnv(spec.env),
      envVars: spec.passThrough,
      cwd: spec.cwd ?? null,
      startupTimeoutMs: limit.ms,
      limit,
      profiles,
      unresolved: spec.unresolved,
      willLaunch: spec.unresolved.length === 0,
    })),
    skipped,
  };
  return JSON.stringify(doc, null, 2);
}

export function renderDryRunHuman(entries: DryRunEntry[], skipped: SkippedEntry[], lang: Lang): string {
  const out = [t(lang, 'dryrun.header')];
  for (const { spec, limit, profiles } of entries) {
    out.push('', `  ${spec.name}${spec.client ? ` (${spec.client})` : ''} — ${spec.source}`);
    out.push(`    $ ${[redactText(spec.command), ...redactArgs(spec.args)].map(shellQuote).join(' ')}`);
    const env = redactEnv(spec.env);
    for (const [k, v] of Object.entries(env)) out.push(`      ${k}=${v}`);
    if (spec.cwd) out.push(`    cwd: ${spec.cwd}`);
    out.push(`    ${t(lang, 'dryrun.limit')}: ${limit.ms} ms (${limitLabel(limit, lang)}) · env: ${profiles.join(', ')}`);
    if (spec.unresolved.length > 0) out.push(`    ${t(lang, 'dryrun.not_launched')}: ${spec.unresolved.join('; ')}`);
  }
  if (skipped.length > 0) out.push('', renderSkipped(skipped, lang));
  return out.join('\n');
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
