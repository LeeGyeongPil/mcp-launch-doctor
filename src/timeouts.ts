// Startup time limits per client. Only limits we could confirm in documentation are listed;
// for the rest we say "unknown" and use the tool default instead of guessing.

export const CLIENTS = ['claude-desktop', 'claude-code', 'cursor', 'vscode', 'codex'] as const;
export type ClientName = (typeof CLIENTS)[number];

export const TOOL_DEFAULT_TIMEOUT_MS = 30_000;
export const CODEX_DEFAULT_STARTUP_MS = 10_000;
export const CODEX_DOC_URL = 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli';
export const CLAUDE_CODE_DOC_URL = 'https://code.claude.com/docs/en/mcp';

export type LimitSource = 'flag' | 'config' | 'client_default' | 'env' | 'tool_default' | 'demo';

export interface StartupLimit {
  ms: number;
  source: LimitSource;
  /** client whose rule produced the limit (undefined for `run` without --client) */
  client?: ClientName;
  /** false when the client has no documented default and the tool default is used */
  known: boolean;
  /** where the rule comes from */
  ref?: string;
}

export interface LimitInput {
  client?: ClientName;
  /** from the config entry (Codex startup_timeout_sec) */
  configStartupMs?: number;
  /** --timeout */
  flagMs?: number;
  env: NodeJS.ProcessEnv;
}

export function resolveStartupLimit(input: LimitInput): StartupLimit {
  const { client } = input;
  // --timeout 이 있으면 모든 규칙보다 우선한다
  if (input.flagMs !== undefined) return { ms: input.flagMs, source: 'flag', client, known: true };

  if (client === 'codex') {
    if (input.configStartupMs !== undefined) return { ms: input.configStartupMs, source: 'config', client, known: true, ref: CODEX_DOC_URL };
    return { ms: CODEX_DEFAULT_STARTUP_MS, source: 'client_default', client, known: true, ref: CODEX_DOC_URL };
  }
  if (client === 'claude-code') {
    const fromEnv = Number(input.env.MCP_TIMEOUT);
    if (input.env.MCP_TIMEOUT && Number.isFinite(fromEnv) && fromEnv > 0) {
      return { ms: Math.round(fromEnv), source: 'env', client, known: true, ref: CLAUDE_CODE_DOC_URL };
    }
  }
  return { ms: TOOL_DEFAULT_TIMEOUT_MS, source: 'tool_default', client, known: false };
}

/** A first answer slower than this share of the limit gets a slow_start warning. */
export const SLOW_START_RATIO = 0.5;
