// Reads the five client config formats into one shape (ServerSpec).
//
//   Claude Desktop / Claude Code / Cursor   JSON, servers under "mcpServers"
//   VS Code                                 JSON with comments, servers under "servers"
//   Codex                                   TOML, servers under [mcp_servers.<name>]

import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ClientName } from '../timeouts.js';
import { expandValue, type ExpandContext, type ExpandStyle } from './expand.js';

export interface ServerSpec {
  /** undefined for `run -- <command>` */
  client?: ClientName;
  name: string;
  command: string;
  args: string[];
  /** env block from the config, variables already expanded */
  env: Record<string, string>;
  /** Codex env_vars: names passed through from the shell environment */
  passThrough: string[];
  cwd?: string;
  /** folder that relative file arguments of a `run` command line refer to (only set by `run`) */
  argBase?: string;
  /** Codex startup_timeout_sec converted to ms */
  startupTimeoutMs?: number;
  /** config file (or "command line") */
  source: string;
  /** placeholders that could not be resolved; such servers are not launched */
  unresolved: string[];
}

export interface SkippedEntry {
  client: ClientName;
  name: string;
  source: string;
  reason: 'remote' | 'disabled' | 'invalid';
  detail?: string;
}

export interface ParsedConfig {
  servers: ServerSpec[];
  skipped: SkippedEntry[];
}

export class ConfigError extends Error {
  constructor(public readonly source: string, message: string) {
    super(message);
  }
}

export interface ParseContext extends ExpandContext {
  /** current folder, used for ~/.claude.json projects[<cwd>] and relative Codex cwd */
  cwd: string;
}

const EXPAND_STYLE: Record<ClientName, ExpandStyle> = {
  'claude-desktop': 'claude',
  'claude-code': 'claude',
  cursor: 'claude',
  vscode: 'vscode',
  codex: 'none',
};

export function parseConfigText(client: ClientName, text: string, source: string, ctx: ParseContext): ParsedConfig {
  const out: ParsedConfig = { servers: [], skipped: [] };

  if (client === 'codex') {
    let doc: Record<string, unknown>;
    try {
      doc = parseToml(text) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(source, (err as Error).message.split('\n')[0] ?? 'TOML parse error');
    }
    const table = asObject(doc.mcp_servers);
    for (const [name, raw] of Object.entries(table)) addEntry(out, client, name, asObject(raw), source, ctx);
    return out;
  }

  let doc: Record<string, unknown>;
  try {
    // VS Code 의 mcp.json 은 주석·끝 쉼표를 허용하므로 모든 JSON 설정에 같은 관용 규칙을 쓴다
    doc = asObject(JSON.parse(stripJsonComments(text)));
  } catch (err) {
    throw new ConfigError(source, (err as Error).message);
  }

  if (client === 'vscode') {
    for (const [name, raw] of Object.entries(asObject(doc.servers))) addEntry(out, client, name, asObject(raw), source, ctx);
    return out;
  }

  for (const [name, raw] of Object.entries(asObject(doc.mcpServers))) addEntry(out, client, name, asObject(raw), source, ctx);
  if (client === 'claude-code') {
    // ~/.claude.json 은 프로젝트별 서버를 projects["<폴더 경로>"].mcpServers 에 둔다
    const project = asObject(asObject(doc.projects)[ctx.cwd]);
    for (const [name, raw] of Object.entries(asObject(project.mcpServers))) {
      addEntry(out, client, name, asObject(raw), `${source} (projects["${ctx.cwd}"])`, ctx);
    }
  }
  return out;
}

function addEntry(out: ParsedConfig, client: ClientName, name: string, raw: Record<string, unknown>, source: string, ctx: ParseContext): void {
  const type = typeof raw.type === 'string' ? raw.type : undefined;
  if (raw.url !== undefined || (type !== undefined && type !== 'stdio')) {
    // HTTP/SSE 서버는 stdio 진단 대상이 아니다 — 실행하지 않고 "건너뜀"으로 보여 준다
    out.skipped.push({ client, name, source, reason: 'remote', detail: typeof raw.url === 'string' ? raw.url : type });
    return;
  }
  if (raw.enabled === false || raw.disabled === true) {
    out.skipped.push({ client, name, source, reason: 'disabled' });
    return;
  }
  if (typeof raw.command !== 'string' || raw.command.trim() === '') {
    out.skipped.push({ client, name, source, reason: 'invalid', detail: 'missing "command"' });
    return;
  }

  const style = EXPAND_STYLE[client];
  const unresolved: string[] = [];
  const expand = (value: string, where: string) => {
    const r = expandValue(value, style, ctx);
    for (const u of r.unresolved) unresolved.push(`${where}: ${u}`);
    return r.value;
  };

  const command = expand(raw.command, 'command');
  const args = (Array.isArray(raw.args) ? raw.args : []).map((a, i) => expand(String(a), `args[${i}]`));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(asObject(raw.env))) env[k] = expand(String(v), `env.${k}`);

  const spec: ServerSpec = { client, name, command, args, env, passThrough: [], source, unresolved };

  if (typeof raw.cwd === 'string' && raw.cwd !== '') {
    const cwd = expand(raw.cwd, 'cwd');
    spec.cwd = resolve(ctx.cwd, cwd); // 상대 경로는 현재 폴더 기준
  }
  if (client === 'vscode' && raw.envFile !== undefined) {
    // envFile 읽기는 M2 — 지금은 값이 빠진 채 실행하지 않도록 경고로 돌린다
    unresolved.push(`envFile: ${String(raw.envFile)} (not read by mcp-launch-doctor yet)`);
  }
  if (client === 'codex') {
    if (Array.isArray(raw.env_vars)) spec.passThrough = raw.env_vars.map(String);
    if (typeof raw.startup_timeout_sec === 'number') spec.startupTimeoutMs = Math.round(raw.startup_timeout_sec * 1000);
    else if (typeof raw.startup_timeout_ms === 'number') spec.startupTimeoutMs = Math.round(raw.startup_timeout_ms);
  }
  out.servers.push(spec);
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Removes // and /* *\/ comments and trailing commas outside of strings (JSONC, as VS Code allows).
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  // 닫는 괄호 앞의 끝 쉼표 제거 (문자열 안의 ",]" 는 위에서 그대로 두었으므로 문자열 밖만 대상이 되도록 한 번 더 따진다)
  return removeTrailingCommas(out);
}

function removeTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? '')) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}
