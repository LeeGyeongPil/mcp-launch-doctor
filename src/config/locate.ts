// Where each client keeps its MCP server list.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientName } from '../timeouts.js';

export interface LocateContext {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface ConfigLocation {
  client: ClientName;
  path: string;
  scope: 'user' | 'project';
}

export function candidatePaths(client: ClientName, ctx: LocateContext): ConfigLocation[] {
  const { home, cwd, platform, env } = ctx;
  switch (client) {
    case 'claude-desktop': {
      let path: string;
      if (platform === 'darwin') path = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      else if (platform === 'win32') path = join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
      else path = join(home, '.config', 'Claude', 'claude_desktop_config.json');
      return [{ client, path, scope: 'user' }];
    }
    case 'claude-code':
      return [
        { client, path: join(cwd, '.mcp.json'), scope: 'project' },
        // 사용자 범위 서버와 projects[<현재 폴더>] 의 로컬 범위 서버가 모두 여기 있다
        { client, path: join(home, '.claude.json'), scope: 'user' },
      ];
    case 'cursor':
      return [
        { client, path: join(cwd, '.cursor', 'mcp.json'), scope: 'project' },
        { client, path: join(home, '.cursor', 'mcp.json'), scope: 'user' },
      ];
    case 'vscode':
      return [{ client, path: join(cwd, '.vscode', 'mcp.json'), scope: 'project' }];
    case 'codex':
      return [{ client, path: join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), scope: 'user' }];
  }
}

/** Existing config files for the given clients, in a stable order. */
export function findConfigs(clients: readonly ClientName[], ctx: LocateContext): ConfigLocation[] {
  const out: ConfigLocation[] = [];
  for (const client of clients) {
    for (const loc of candidatePaths(client, ctx)) {
      // 홈 폴더에서 실행하면 프로젝트 경로와 사용자 경로가 같은 파일일 수 있다 → 한 번만 읽는다
      const dup = out.some((o) => o.client === loc.client && o.path === loc.path);
      if (!dup && existsSync(loc.path)) out.push(loc);
    }
  }
  return out;
}

/** Guesses the client from a file name when --config is given without --client. */
export function guessClient(path: string): ClientName | undefined {
  const p = path.replace(/\\/g, '/').toLowerCase();
  if (p.endsWith('.toml')) return 'codex';
  if (p.endsWith('claude_desktop_config.json')) return 'claude-desktop';
  if (p.endsWith('.mcp.json') || p.endsWith('.claude.json')) return 'claude-code';
  if (p.includes('/.cursor/')) return 'cursor';
  if (p.includes('/.vscode/')) return 'vscode';
  return undefined;
}
