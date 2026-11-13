// Ready-to-paste fixes, written in the format of the client the server came from:
// JSON (mcpServers / VS Code servers) or Codex TOML.

import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { stringify as toToml } from 'smol-toml';
import type { ServerSpec } from './config/parse.js';
import type { DiagnosisResult, VerdictKind } from './diagnose.js';
import { guiDefaultPath } from './envProfiles.js';
import { redactArgs, redactText } from './redact.js';
import { isTemporaryPath, SELF, TOOL_NAME, type SelfInfo } from './selfLaunch.js';


export type FixFormat = 'json' | 'toml' | 'shell' | 'none';

export interface FixSnippet {
  forKind: VerdictKind;
  format: FixFormat;
  /** text to paste (language independent); absent when there is only advice */
  code?: string;
  /** message key in the locale tables (src/locales) */
  note: string;
  data: Record<string, unknown>;
}

export interface FixContext {
  /** your shell environment — where we look for the absolute paths the app is missing */
  baseEnv: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** where this tool runs from (tests pass a fake npx-cache location); default: the running copy */
  self?: SelfInfo;
}

interface EntryPatch {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  startup_timeout_sec?: number;
}

export function buildFixes(result: DiagnosisResult, spec: ServerSpec, ctx: FixContext): FixSnippet[] {
  const out: FixSnippet[] = [];
  const shellPath = ctx.baseEnv.PATH ?? '';
  const gui = (guiDefaultPath(ctx.platform) ?? '').split(delimiter).filter(Boolean);

  for (const f of result.findings) {
    switch (f.kind) {
      case 'not_found': {
        if (f.data.what === 'cwd') {
          out.push({ forKind: f.kind, format: 'none', note: 'fix.cwd_missing', data: { path: f.data.path } });
          break;
        }
        const abs = findForFix(spec.command, shellPath);
        if (!abs) {
          out.push({ forKind: f.kind, format: 'none', note: 'fix.not_found_anywhere', data: { command: spec.command } });
          break;
        }
        // 절대 경로만 바꾸면 "#!/usr/bin/env node" 같은 스크립트는 다시 실패한다 → 인터프리터 폴더도 PATH 에 넣는다
        const interpreter = shebangInterpreter(abs);
        const interpreterAbs = interpreter ? findForFix(interpreter, shellPath) : undefined;
        const path = unique([interpreterAbs ? dirname(interpreterAbs) : undefined, dirname(abs), ...gui]);
        const note = interpreter ? 'fix.not_found_script' : 'fix.not_found';
        out.push(snippet(f.kind, spec, { command: abs, env: { PATH: path.join(delimiter) } }, note, { absolute: abs, interpreter: interpreter ?? null }));
        break;
      }
      case 'interpreter_missing': {
        const name = String(f.data.interpreter);
        const interpreterAbs = findForFix(name, shellPath);
        if (!interpreterAbs) {
          out.push({ forKind: f.kind, format: 'none', note: 'fix.not_found_anywhere', data: { command: name } });
          break;
        }
        const path = unique([dirname(interpreterAbs), ...gui]);
        out.push(snippet(f.kind, spec, { env: { PATH: path.join(delimiter) } }, 'fix.interpreter_missing', { interpreter: name, absolute: interpreterAbs }));
        break;
      }
      case 'startup_timeout': {
        if (f.cause === 'buffering') {
          out.push(snippet(f.kind, spec, { env: { PYTHONUNBUFFERED: '1' } }, 'fix.buffering', {}));
          break;
        }
        const seconds = Math.max(30, Math.ceil((3 * result.limit.ms) / 1000));
        if (spec.client === 'codex') {
          out.push(snippet(f.kind, spec, { startup_timeout_sec: seconds }, f.cause === 'first_run_install' ? 'fix.first_run_codex' : 'fix.timeout_codex', { seconds }));
        } else if (spec.client === 'claude-code') {
          out.push({ forKind: f.kind, format: 'shell', code: `MCP_TIMEOUT=${seconds * 1000} claude`, note: f.cause === 'first_run_install' ? 'fix.first_run_claude_code' : 'fix.timeout_claude_code', data: { ms: seconds * 1000 } });
        } else {
          out.push({ forKind: f.kind, format: 'none', note: f.cause === 'first_run_install' ? 'fix.first_run_generic' : 'fix.timeout_generic', data: { limitMs: result.limit.ms } });
        }
        break;
      }
      case 'stdout_pollution': {
        // 서버를 고치기 전 임시 방편: wrap 을 앞에 끼워 JSON-RPC 줄만 stdout 으로 내보낸다
        const self = ctx.self ?? SELF;
        const original = [fixCommand(spec), ...fixArgs(spec)];
        if (isTemporaryPath(self.cliPath)) {
          // npx 캐시에서 도는 중: 이 경로는 곧 지워질 수 있으니 설정에 박지 않고, 버전을 고정한 npx 로 띄운다.
          // 서버가 원래 npx 로 뜨던 항목이면 그 npx(절대 경로일 수도 있다)를 그대로 쓴다 — 앱에서 이미 찾아지는 명령이다
          const npx = basename(spec.command).replace(/\.(exe|cmd)$/i, '') === 'npx' ? redactText(spec.command) : 'npx';
          const args = ['-y', `${TOOL_NAME}@${self.version}`, 'wrap', '--', ...original];
          out.push(snippet(f.kind, spec, { command: npx, args }, 'fix.wrap_npx', { version: self.version, launcher: 'npx' }));
        } else {
          // 클론·전역 설치: node 절대 경로 + 이 도구의 dist/cli.js (앱의 PATH 에 node 가 없어도 뜬다)
          // node 는 버전마다 바뀌는 실제 경로(Cellar 등)보다 셸 PATH 에 보이는 안정된 경로를 쓴다
          const command = stableNodePath(shellPath);
          out.push(snippet(f.kind, spec, { command, args: [self.cliPath, 'wrap', '--', ...original] }, 'fix.wrap', { launcher: 'node' }));
        }
        break;
      }
      case 'npx_prompt_risk':
        out.push(snippet(f.kind, spec, { args: ['-y', ...fixArgs(spec)] }, 'fix.npx_yes', {}));
        break;
      case 'version_mismatch':
        out.push({ forKind: f.kind, format: 'none', note: 'fix.version', data: { got: f.data.got } });
        break;
      case 'early_exit':
        out.push({ forKind: f.kind, format: 'none', note: 'fix.early_exit', data: {} });
        break;
      case 'unresolved_variable':
        out.push({ forKind: f.kind, format: 'none', note: 'fix.unresolved', data: {} });
        break;
      case 'framing_warning':
        out.push({ forKind: f.kind, format: 'none', note: 'fix.framing', data: {} });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Arguments for a fix snippet. For `run`, a relative argument that names an existing file (relative to the
 * folder `run` was started in) becomes absolute, so the snippet works when an app starts it from elsewhere.
 */
export function fixArgs(spec: ServerSpec): string[] {
  return redactArgs(spec.argBase ? spec.args.map((arg) => absolutizeExisting(arg, spec.argBase as string)) : spec.args);
}

/** The command for a fix snippet. A relative path to an existing file (`bin/my-server`) becomes absolute like the args; a bare name stays. */
export function fixCommand(spec: ServerSpec): string {
  const cmd = spec.command;
  const base = spec.argBase;
  if (!base || !(cmd.includes('/') || cmd.includes('\\'))) return redactText(cmd);
  return redactText(absolutizeExisting(cmd, base));
}

function absolutizeExisting(arg: string, base: string): string {
  if (!arg || arg.startsWith('-') || isAbsolute(arg)) return arg;
  const abs = resolve(base, arg);
  try {
    return statSync(abs).isFile() ? abs : arg;
  } catch {
    return arg;
  }
}

/** One config entry in the client's own format. Only the keys that change are included. */
function snippet(kind: VerdictKind, spec: ServerSpec, patch: EntryPatch, note: string, data: Record<string, unknown>): FixSnippet {
  const entry: Record<string, unknown> = {};
  if (spec.client === 'vscode') entry.type = 'stdio';
  entry.command = patch.command ?? fixCommand(spec);
  entry.args = patch.args ?? fixArgs(spec);
  if (patch.env) entry.env = patch.env;

  if (spec.client === 'codex') {
    if (patch.startup_timeout_sec !== undefined) entry.startup_timeout_sec = patch.startup_timeout_sec;
    return { forKind: kind, format: 'toml', code: toToml({ mcp_servers: { [spec.name]: entry } }), note, data };
  }
  const key = spec.client === 'vscode' ? 'servers' : 'mcpServers';
  return { forKind: kind, format: 'json', code: JSON.stringify({ [key]: { [spec.name]: entry } }, null, 2), note, data };
}

/** Finds an executable like the shell would (POSIX PATH search). */
export function which(command: string, pathValue: string): string | undefined {
  if (command.includes('/') || command.includes('\\') || isAbsolute(command)) {
    return isExecutableFile(command) ? command : undefined;
  }
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** "#!/usr/bin/env node" -> "node"; "#!/usr/local/bin/python3" -> "/usr/local/bin/python3". */
export function shebangInterpreter(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0] ?? '';
    const m = /^#!\s*(\S+)((?:\s+\S+)*)/.exec(first);
    if (!m || !m[1]) return undefined;
    if (!m[1].endsWith('/env')) return m[1];
    // "#!/usr/bin/env -S node --flag" 처럼 옵션이 앞에 올 수 있다 → 첫 번째 옵션 아닌 낱말
    return (m[2] ?? '').trim().split(/\s+/).find((w) => w && !w.startsWith('-'));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Absolute path to put into a fix. Prefers PATH entries that last; a hit inside a temporary folder
 * (npx cache, fnm per-shell links) is replaced by the real file behind it when that one lasts.
 * Falls back to the plain lookup so your own command always gets a fix.
 */
export function findForFix(command: string, pathValue: string): string | undefined {
  const lasting = pathValue.split(delimiter).filter((dir) => !isTemporaryPath(dir)).join(delimiter);
  const found = which(command, lasting);
  if (found && !isTemporaryPath(found)) return found;
  const anywhere = which(command, pathValue);
  const real = anywhere ? realPath(anywhere) : undefined;
  if (real && !isTemporaryPath(real)) return real;
  return found ?? anywhere;
}

/**
 * Node for the wrap fix: `node` on the shell PATH when it is the node running this tool (a stable
 * name such as /opt/homebrew/bin/node), else this node's own path — but never one inside a
 * temporary folder (e.g. `npx -p node@22`); then plain "node".
 */
export function stableNodePath(shellPath: string, execPath: string = process.execPath): string {
  const running = realPath(execPath);
  const onPath = findForFix('node', shellPath);
  if (onPath && running && realPath(onPath) === running && !isTemporaryPath(onPath)) return onPath;
  if (!isTemporaryPath(execPath)) return execPath;
  if (running && !isTemporaryPath(running)) return running;
  return 'node';
}

function realPath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

function unique(items: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const i of items) if (i && !out.includes(i)) out.push(i);
  return out;
}
