// Variable expansion the way each client does it, so we launch what the app would launch.
// Anything we cannot resolve is reported instead of being run with a literal "${...}".

export type ExpandStyle = 'claude' | 'vscode' | 'none';

export interface ExpandContext {
  /** environment variables visible to the client (normally your shell environment) */
  env: NodeJS.ProcessEnv;
  /** VS Code ${workspaceFolder} (the current folder) */
  workspaceFolder: string;
}

export interface Expanded {
  value: string;
  /** placeholders left unresolved, e.g. "${input:api-key}" or "${MISSING}" */
  unresolved: string[];
}

// ${VAR} 또는 ${VAR:-기본값}
const CLAUDE_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const ANY_PLACEHOLDER = /\$\{[^}]*\}/g;

export function expandValue(value: string, style: ExpandStyle, ctx: ExpandContext): Expanded {
  let out = value;
  const unresolved: string[] = [];

  if (style === 'claude') {
    out = out.replace(CLAUDE_VAR, (whole, name: string, fallback: string | undefined) => {
      const current = ctx.env[name];
      // 빈 문자열도 "설정됨"으로 본다(Claude Code 문서 규칙) — 기본값은 변수가 아예 없을 때만
      if (current !== undefined) return current;
      if (fallback !== undefined) return fallback;
      unresolved.push(whole);
      return whole;
    });
  } else if (style === 'vscode') {
    out = out.replace(/\$\{workspaceFolder\}/g, ctx.workspaceFolder);
  }

  // 위 규칙으로 못 바꾼 ${...} 는 전부 "실행 전 경고" 대상(${input:…} 등)
  for (const m of out.matchAll(ANY_PLACEHOLDER)) {
    if (!unresolved.includes(m[0])) unresolved.push(m[0]);
  }
  return { value: out, unresolved };
}
