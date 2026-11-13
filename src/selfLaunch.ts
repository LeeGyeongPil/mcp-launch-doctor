// Where this tool itself runs from, and whether that place lasts.
//
// `npx mcp-launch-doctor` does not install anything: npm unpacks the package into its cache
// (~/.npm/_npx/<hash>/node_modules/mcp-launch-doctor/…) and runs it from there. That folder can be
// removed at any time (`npm cache clean`, a new version, another npx run). A config entry that points
// into it works today and fails later with not_found, so the `wrap` fix must not use such a path.
// The same is true for other one-run folders (pnpm/yarn dlx, bunx) and per-shell links (fnm).

import { readFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_NAME = 'mcp-launch-doctor';

export interface SelfInfo {
  /** absolute path of dist/cli.js of the running copy */
  cliPath: string;
  /** version from package.json, used to pin `npx -y mcp-launch-doctor@<version>` */
  version: string;
}

export const SELF: SelfInfo = {
  cliPath: fileURLToPath(new URL('./cli.js', import.meta.url)),
  version: readVersion(),
};

// 한 번 실행하려고 만든 폴더, 셸 하나가 끝나면 사라지는 링크 폴더의 이름들
//   _npx            npm 7+ npx 캐시 (~/.npm/_npx/<hash>/…)
//   npm-cache       Windows npm 캐시 (%LocalAppData%\npm-cache\_npx\…)
//   _cacache        npm 캐시 본체
//   dlx-*, xfs-*    pnpm(옛 버전)·yarn dlx 가 임시 폴더에 만드는 이름
//   bunx-*          bunx 가 임시 폴더에 만드는 이름 (/tmp/bunx-<uid>-<pkg>@<ver>)
//   fnm_multishells fnm 이 셸마다 만드는 node 링크 폴더
const TEMPORARY_SEGMENTS = [/^_npx$/, /^npm-cache$/i, /^_cacache$/, /^dlx-/, /^xfs-/, /^bunx-/, /^fnm_multishells$/];

/**
 * True when the path lies in a folder that a package runner or version manager may delete
 * (npx cache, pnpm/yarn dlx, bunx, fnm per-shell links). A normal clone — even in /tmp — is not
 * counted: it stays until you remove it.
 */
export function isTemporaryPath(p: string): boolean {
  const parts = p.split(/[\\/]+/);
  return parts.some((segment, i) => {
    if (TEMPORARY_SEGMENTS.some((re) => re.test(segment))) return true;
    // pnpm 9+: <pnpm cache>/dlx/<hash>/…
    return segment === 'dlx' && parts[i - 1]?.toLowerCase() === 'pnpm';
  });
}

// npm/npx 가 띄우는 명령에만 넣어 주는 변수. 사용자의 셸에는 없다.
//   npm_config_yes=true      → npx -y 가 남긴 값. 그대로 두면 안쪽 npx 가 설치 확인 없이 진행한다
//   npm_config_package=<x>   → npx --package 가 남긴 값. 안쪽 npx 가 엉뚱한 패키지를 설치한다
const NPM_EXEC_VARS = ['npm_config_yes', 'npm_config_package', 'npm_config_call', 'npm_command', 'npm_lifecycle_event', 'npm_lifecycle_script'];

/**
 * The environment without what npm/npx added when it started this tool: the variables above and
 * the PATH entries pointing into the npx cache or npm's node-gyp-bin. Unchanged when npm did not
 * start us. Used for the `shell` profile (so it matches your terminal) and for `wrap` (so the server
 * sees what the app gave, not what npx added).
 */
export function withoutNpmExec(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.npm_lifecycle_event === undefined && env.npm_command === undefined) return env;
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of NPM_EXEC_VARS) delete out[name];
  if (out.PATH !== undefined) {
    out.PATH = out.PATH.split(delimiter)
      .filter((dir) => dir !== '' && !isTemporaryPath(dir) && !/[\\/]node-gyp-bin$/.test(dir))
      .join(delimiter);
  }
  return out;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
