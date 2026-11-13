#!/usr/bin/env node
// mcp-launch-doctor command line: check / run / wrap / demo.
// Exit codes: 0 passed, 1 findings at or above --fail-on, 2 usage or config error.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { findConfigs, guessClient } from './config/locate.js';
import { ConfigError, parseConfigText, type ServerSpec, type SkippedEntry } from './config/parse.js';
import { runDemo } from './demo.js';
import { diagnoseServer, exitCodeFor, type DiagnosisResult } from './diagnose.js';
import { ENV_PROFILES, parseProfiles, type ProfileName } from './envProfiles.js';
import { LANGS, resolveLang, t, type Lang, type MessageKey, type Params } from './i18n.js';
import { redactArgs, redactText } from './redact.js';
import { renderDryRunHuman, renderDryRunJson, renderHuman, renderJson, shellQuote, type DryRunEntry } from './report.js';
import { SELF, withoutNpmExec } from './selfLaunch.js';
import { killActiveSessions } from './session.js';
import { CLIENTS, resolveStartupLimit, type ClientName } from './timeouts.js';
import { runWrap } from './wrap.js';

// 선택지 목록은 이 상수들 한 곳에서 도움말·오류 메시지·README 로 나간다
export const COMMANDS = ['check', 'run', 'wrap', 'demo'] as const;
export const FAIL_ON = ['error', 'warn', 'never'] as const;
type FailOn = (typeof FAIL_ON)[number];

const VERSION = SELF.version;

// 서버를 띄울 기준 환경 = 사용자의 셸. `npx mcp-launch-doctor` 로 실행되면 npx 가 넣은 변수(npm_config_yes 등)와
// npx 캐시 PATH 를 뺀다 — 그대로 두면 shell 프로필이 터미널과 달라지고(안쪽 npx 가 확인 없이 설치), 고칠 조각에 캐시 경로가 샌다
const SHELL_ENV = withoutNpmExec(process.env);

class UsageError extends Error {
  constructor(public readonly key: MessageKey, public readonly params: Params = {}) {
    super(key);
  }
}

const OPTIONS = {
  client: { type: 'string' },
  config: { type: 'string' },
  server: { type: 'string' },
  env: { type: 'string' },
  timeout: { type: 'string' },
  'no-retry': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean' },
  json: { type: 'boolean' },
  'fail-on': { type: 'string' },
  lang: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; strict: true; allowPositionals: true }>>['values'];

async function main(argv: string[]): Promise<number> {
  // "--" 뒤는 서버 명령이라 옵션으로 해석하지 않는다
  const sep = argv.indexOf('--');
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const tail = sep === -1 ? [] : argv.slice(sep + 1);

  const lang = pickLang(head);
  if (lang === undefined) return usageError(resolveLang(undefined, process.env), new UsageError('err.bad_choice', { option: '--lang', value: langFlag(head) ?? '', choices: LANGS.join(', ') }));

  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: head, options: OPTIONS, strict: true, allowPositionals: true }));
  } catch (err) {
    const e = err as Error & { code?: string };
    const option = /'(-[^']+)'/.exec(e.message)?.[1] ?? '';
    if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option) return usageError(lang, new UsageError('err.unknown_option', { option }));
    if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && option) return usageError(lang, new UsageError('err.option_value', { option }));
    return usageError(lang, new UsageError('err.bad_option', { message: e.message }));
  }

  const sub = positionals[0];
  if (values.version) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (values.help || sub === undefined) {
    process.stdout.write(helpText(lang) + '\n');
    return values.help ? 0 : 2;
  }

  try {
    if (!(COMMANDS as readonly string[]).includes(sub)) throw new UsageError('err.unknown_command', { command: sub, commands: COMMANDS.join(', ') });
    if (positionals.length > 1) throw new UsageError('err.unexpected_argument', { value: positionals[1] });
    // wrap 은 신호를 서버에 넘겨야 하므로 여기서 가로채지 않는다
    if (sub !== 'wrap') installCleanupOnSignals();
    const failOn = pickChoice(values['fail-on'], FAIL_ON, '--fail-on', 'error');
    switch (sub) {
      case 'check': return await cmdCheck(values, lang, failOn);
      case 'run': return await cmdRun(values, tail, lang, failOn);
      case 'wrap': return await cmdWrap(tail, lang);
      case 'demo': return await cmdDemo(values, lang);
    }
  } catch (err) {
    if (err instanceof UsageError) return usageError(lang, err);
    if (err instanceof ConfigError) return usageError(lang, new UsageError('err.config_parse', { source: err.source, message: err.message }));
    throw err;
  }
  return 2;
}

// ---- check ------------------------------------------------------------------

async function cmdCheck(values: Values, lang: Lang, failOn: FailOn): Promise<number> {
  const clientArg = pickChoice(values.client, [...CLIENTS, 'all'] as const, '--client', 'all');
  const profiles = pickProfiles(values.env, 'gui,shell');
  const flagMs = pickTimeout(values.timeout);
  const cwd = process.cwd();
  const ctx = { cwd, env: SHELL_ENV, workspaceFolder: cwd };

  // 1) 설정 파일 찾기·읽기
  const files: Array<{ client: ClientName; path: string }> = [];
  if (values.config) {
    const path = resolve(values.config);
    const client = clientArg === 'all' ? guessClient(path) : clientArg;
    if (!client) throw new UsageError('err.client_required', { path: values.config, clients: CLIENTS.join(', ') });
    if (!existsSync(path)) throw new UsageError('err.config_missing', { path: values.config });
    files.push({ client, path });
  } else {
    const clients = clientArg === 'all' ? CLIENTS : [clientArg];
    files.push(...findConfigs(clients, { home: homedir(), cwd, platform: process.platform, env: process.env }));
    if (files.length === 0) throw new UsageError('err.no_configs', { clients: clients.join(', ') });
  }

  let specs: ServerSpec[] = [];
  let skipped: SkippedEntry[] = [];
  for (const f of files) {
    try {
      let text: string;
      try {
        text = readFileSync(f.path, 'utf8');
      } catch (err) {
        throw new ConfigError(f.path, (err as Error).message);
      }
      const parsed = parseConfigText(f.client, text, f.path, ctx);
      specs.push(...parsed.servers);
      skipped.push(...parsed.skipped);
    } catch (err) {
      // --config 로 직접 준 파일이 깨졌으면 설정 오류(종료 2), 자동으로 찾은 파일이면 경고만 하고 나머지를 계속 본다
      if (values.config || !(err instanceof ConfigError)) throw err;
      process.stderr.write(t(lang, 'warn.config_skipped', { source: err.source, message: err.message }) + '\n');
    }
  }
  if (specs.length === 0 && values.server === undefined && !values.config && skipped.length === 0) {
    throw new UsageError('err.no_configs', { clients: (clientArg === 'all' ? CLIENTS : [clientArg]).join(', ') });
  }
  if (values.server !== undefined) {
    specs = specs.filter((s) => s.name === values.server);
    skipped = skipped.filter((s) => s.name === values.server);
    if (specs.length === 0) throw new UsageError('err.no_server_match', { name: values.server });
  }

  if (values.config && specs.length === 0 && skipped.length === 0) {
    throw new UsageError('err.no_servers_in_config', { path: values.config });
  }

  const entries: DryRunEntry[] = specs.map((spec) => ({
    spec,
    limit: resolveStartupLimit({ client: spec.client, configStartupMs: spec.startupTimeoutMs, flagMs, env: process.env }),
    profiles,
  }));

  // 2) --dry-run: 아무것도 실행하지 않고 정규화 결과만
  if (values['dry-run']) {
    const meta = { lang, command: 'check' as const, version: VERSION };
    process.stdout.write((values.json ? renderDryRunJson(entries, skipped, meta) : renderDryRunHuman(entries, skipped, lang)) + '\n');
    return 0;
  }

  // 3) 대화형 터미널이면 실행할 명령을 보여 주고 한 번 묻는다(--yes 로 생략)
  if (!values.yes && process.stdin.isTTY && process.stderr.isTTY) {
    const runnable = entries.filter((e) => e.spec.unresolved.length === 0);
    process.stderr.write(t(lang, 'confirm.header', { count: runnable.length }) + '\n');
    for (const e of runnable) process.stderr.write(`  ${e.spec.name}: ${[redactText(e.spec.command), ...redactArgs(e.spec.args)].map(shellQuote).join(' ')}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question(t(lang, 'confirm.question'))).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      process.stderr.write(t(lang, 'confirm.aborted') + '\n');
      return 0;
    }
  }

  // 4) 서버 × 프로필을 하나씩 띄워 진단(동시에 띄우면 첫 설치 캐시가 서로 섞인다)
  const results: DiagnosisResult[] = [];
  for (const e of entries) {
    const list: ProfileName[] = e.spec.unresolved.length > 0 ? [profiles[0] ?? 'shell'] : profiles;
    for (const profile of list) {
      progress(lang, e.spec.name, profile);
      const r = await diagnoseServer(e.spec, { profile, limit: e.limit, retry: !values['no-retry'], baseEnv: SHELL_ENV });
      if (e.spec.unresolved.length > 0) r.profile = null;
      results.push(r);
    }
  }
  return output(results, skipped, values, lang, 'check', exitCodeFor(results, failOn));
}

// ---- run --------------------------------------------------------------------

async function cmdRun(values: Values, tail: string[], lang: Lang, failOn: FailOn): Promise<number> {
  const [command, ...args] = tail;
  if (!command) throw new UsageError('err.missing_command', { sub: 'run' });
  const clientArg = pickChoice(values.client, CLIENTS, '--client', undefined);
  const profiles = pickProfiles(values.env, 'shell');
  const flagMs = pickTimeout(values.timeout);

  const spec: ServerSpec = { client: clientArg, name: runName(command, args), command, args, env: {}, passThrough: [], source: 'command line', unresolved: [] };
  const limit = resolveStartupLimit({ client: clientArg, flagMs, env: process.env });

  if (values['dry-run']) {
    const entries = [{ spec, limit, profiles }];
    const meta = { lang, command: 'run' as const, version: VERSION };
    process.stdout.write((values.json ? renderDryRunJson(entries, [], meta) : renderDryRunHuman(entries, [], lang)) + '\n');
    return 0;
  }

  const results: DiagnosisResult[] = [];
  for (const profile of profiles) {
    progress(lang, spec.name, profile);
    results.push(await diagnoseServer(spec, { profile, limit, retry: !values['no-retry'], baseEnv: SHELL_ENV }));
  }
  return output(results, [], values, lang, 'run', exitCodeFor(results, failOn));
}

/** Server name for `run`: "node dist/index.js" -> "index.js", "npx -y @x/server" -> "@x/server", else the command. */
function runName(command: string, args: string[]): string {
  // 전역 설치 이름을 바로 쓴 `mcp-launch-doctor wrap -- <server>` 도 감싼 서버 이름으로 푼다
  if (/^mcp-launch-doctor(\.cmd|\.exe)?$/i.test(basename(command)) && args[0] === 'wrap') {
    const sep = args.indexOf('--');
    const inner = sep === -1 ? args.slice(1) : args.slice(sep + 1);
    if (inner[0] !== undefined) return runName(inner[0], inner.slice(1));
  }
  const launcher = /^(node|nodejs|bunx|npx|pnpx|uvx|python[0-9.]*)$/i.test(basename(command).replace(/\.(exe|cmd)$/i, ''));
  if (!launcher) return basename(command);
  // 값을 받는 플래그(-e code, -m module)의 값은 이름 후보에서 뺀다
  const valueFlags = new Set(['-e', '--eval', '-p', '--print', '-c', '-m', '-r', '--require', '--import', '--loader']);
  let firstAt = -1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (valueFlags.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    firstAt = i;
    break;
  }
  if (firstAt === -1) return basename(command);
  const first = args[firstAt] ?? '';
  // `mcp-launch-doctor wrap -- <server>` 로 감싼 서버는 감싼 명령 이름을 쓴다
  // (npx 고칠 조각처럼 `npx -y mcp-launch-doctor@0.1.0 wrap -- …` 로 버전을 붙인 형태도 같다)
  if (/^(cli\.js|mcp-launch-doctor(@[\w.+-]+)?)$/.test(basename(first)) && args[firstAt + 1] === 'wrap') {
    const wrapped = args.slice(firstAt + 2);
    const sep = wrapped.indexOf('--');
    const inner = sep === -1 ? wrapped : wrapped.slice(sep + 1);
    if (inner[0] !== undefined) return runName(inner[0], inner.slice(1));
  }
  const name = first.startsWith('@') ? first : basename(first);
  return name.length > 40 ? `${name.slice(0, 37)}...` : name;
}

// ---- wrap -------------------------------------------------------------------

async function cmdWrap(tail: string[], lang: Lang): Promise<number> {
  const [command, ...args] = tail;
  if (!command) throw new UsageError('err.missing_command', { sub: 'wrap' });
  const code = await runWrap(command, args, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, (message) => {
    process.stderr.write(t(lang, 'wrap.spawn_failed', { command, message }) + '\n');
  });
  // 부모 stdin 이 아직 열려 있어도 서버가 끝났으면 wrap 도 끝낸다(출력은 모두 비운 뒤)
  await new Promise<void>((r) => process.stdout.write('', () => r()));
  process.exit(code);
}

// ---- demo -------------------------------------------------------------------

async function cmdDemo(values: Values, lang: Lang): Promise<number> {
  // 첫 줄: 연습용 목(mock) 서버라는 안내 — 기다리는 동안에도 보이도록 먼저 찍는다
  if (!values.json) process.stdout.write(t(lang, 'demo.notice') + '\n\n');
  const results = await runDemo(SHELL_ENV, (name) => progress(lang, name, 'shell'));
  // 데모는 일부러 결함을 보여 주므로 기본은 --fail-on never (명시하면 그 값을 따른다)
  const failOn = pickChoice(values['fail-on'], FAIL_ON, '--fail-on', 'never');
  const code = exitCodeFor(results, failOn);
  const meta = { lang, command: 'demo' as const, version: VERSION, practice: true, exitCode: code };
  if (values.json) process.stdout.write(renderJson(results, [], meta) + '\n');
  else process.stdout.write(renderHuman(results, [], { ...meta, practice: false }) + '\n' + t(lang, 'demo.next') + '\n');
  return code;
}

// ---- 공통 -------------------------------------------------------------------

function output(results: DiagnosisResult[], skipped: SkippedEntry[], values: Values, lang: Lang, command: 'check' | 'run', exitCode: number): number {
  const meta = { lang, command, version: VERSION, exitCode };
  process.stdout.write((values.json ? renderJson(results, skipped, meta) : renderHuman(results, skipped, meta)) + '\n');
  return exitCode;
}

function progress(lang: Lang, server: string, profile: string): void {
  // 진행 표시는 사람이 보는 터미널일 때만, 그리고 stdout(JSON)을 더럽히지 않게 stderr 로
  if (process.stderr.isTTY) process.stderr.write(t(lang, 'progress', { server, profile }) + '\n');
}

function pickChoice<T extends string, D extends T | undefined>(value: string | undefined, choices: readonly T[], option: string, fallback: D): T | D {
  if (value === undefined) return fallback;
  if (!(choices as readonly string[]).includes(value)) throw new UsageError('err.bad_choice', { option, value, choices: choices.join(', ') });
  return value as T;
}

function pickProfiles(value: string | undefined, fallback: string): ProfileName[] {
  const profiles = parseProfiles(value ?? fallback);
  if (!profiles) throw new UsageError('err.bad_choice', { option: '--env', value: value ?? '', choices: [...ENV_PROFILES, 'all'].join(', ') });
  return profiles;
}

function pickTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) throw new UsageError('err.bad_timeout', { value });
  return Math.round(ms);
}

function langFlag(head: string[]): string | undefined {
  for (let i = 0; i < head.length; i++) {
    const a = head[i] ?? '';
    if (a === '--lang') return head[i + 1] ?? '';
    if (a.startsWith('--lang=')) return a.slice('--lang='.length);
  }
  return undefined;
}

/** Language from --lang (validated) or the environment; undefined means an invalid --lang value. */
function pickLang(head: string[]): Lang | undefined {
  const flag = langFlag(head);
  if (flag !== undefined && !(LANGS as readonly string[]).includes(flag)) return undefined;
  return resolveLang(flag, process.env);
}

export function helpText(lang: Lang): string {
  return t(lang, 'help', {
    version: VERSION,
    clients: CLIENTS.join('|'),
    profiles: ENV_PROFILES.join('|'),
    failOn: FAIL_ON.join('|'),
    langs: LANGS.join('|'),
  });
}

function usageError(lang: Lang, err: UsageError): number {
  process.stderr.write(`mcp-launch-doctor: ${t(lang, err.key, err.params)}\n${t(lang, 'err.help_hint')}\n`);
  return 2;
}

/** Ctrl-C·종료 신호를 받으면 진단 중인 서버(프로세스 그룹)까지 정리하고 끝낸다. */
function installCleanupOnSignals(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      killActiveSessions();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    killActiveSessions();
    process.stderr.write(`mcp-launch-doctor: ${(err as Error)?.stack ?? String(err)}\n`);
    process.exitCode = 2;
  },
);
