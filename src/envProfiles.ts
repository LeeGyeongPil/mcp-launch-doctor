// Launch-environment profiles. A desktop app does not start servers from your terminal, so the
// same command can see a very different PATH. These profiles are approximations — they show
// where things differ, they do not claim to copy any one app exactly.
//
//   shell  your current environment (what you get when you test in a terminal)
//   gui    a GUI-app-like environment: the OS default PATH, no shell profile (.zshrc etc.) applied
//   sdk    the six variables the official MCP TypeScript SDK passes by default

export const ENV_PROFILES = ['shell', 'gui', 'sdk'] as const;
export type ProfileName = (typeof ENV_PROFILES)[number];

/** macOS launchd default PATH for apps started from Dock/Finder. */
export const MACOS_GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** systemd default PATH on Linux desktop sessions. */
export const LINUX_GUI_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** Variables kept by the gui profile besides PATH. */
const GUI_KEEP = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR'];
/** getDefaultEnvironment() of @modelcontextprotocol/sdk StdioClientTransport (POSIX). */
export const SDK_DEFAULT_VARS = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

export type Env = Record<string, string>;

export interface ProfileInput {
  profile: ProfileName;
  /** environment the tool itself runs with (normally process.env) */
  baseEnv: NodeJS.ProcessEnv;
  /** env block from the server's config entry (always laid on top) */
  configEnv: Env;
  /** Codex env_vars: names copied from the shell environment into the server */
  passThrough?: string[];
  platform?: NodeJS.Platform;
}

export type ProfileResult = { env: Env; unsupported?: undefined } | { env?: undefined; unsupported: string };

export function guiDefaultPath(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'darwin') return MACOS_GUI_PATH;
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return LINUX_GUI_PATH;
  return undefined;
}

export function buildProfileEnv(input: ProfileInput): ProfileResult {
  const platform = input.platform ?? process.platform;
  const base = cleanEnv(input.baseEnv);
  let env: Env;

  if (input.profile === 'shell') {
    env = { ...base };
  } else {
    // gui·sdk 는 Windows 에서 근사할 근거가 없어 M1 에서는 지원하지 않는다고 밝힌다
    if (platform === 'win32') return { unsupported: 'win32' };
    if (input.profile === 'gui') {
      env = pick(base, GUI_KEEP);
      env.PATH = guiDefaultPath(platform) ?? LINUX_GUI_PATH;
    } else {
      // SDK 는 함수 정의처럼 "()" 로 시작하는 값은 넘기지 않는다
      env = pick(base, SDK_DEFAULT_VARS, (v) => !v.startsWith('()'));
    }
    for (const name of input.passThrough ?? []) {
      if (base[name] !== undefined) env[name] = base[name];
    }
  }
  // 설정 파일의 env 는 어떤 프로필이든 마지막에 덧씌운다(앱도 그렇게 한다)
  return { env: { ...env, ...input.configEnv } };
}

function cleanEnv(env: NodeJS.ProcessEnv): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

function pick(env: Env, names: string[], keep: (value: string) => boolean = () => true): Env {
  const out: Env = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && keep(value)) out[name] = value;
  }
  return out;
}

/** Parses "gui,shell" / "all" into a list of profiles; returns undefined on an unknown name. */
export function parseProfiles(value: string): ProfileName[] | undefined {
  if (value === 'all') return [...ENV_PROFILES];
  const names = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return undefined;
  const out: ProfileName[] = [];
  for (const n of names) {
    if (!(ENV_PROFILES as readonly string[]).includes(n)) return undefined;
    if (!out.includes(n as ProfileName)) out.push(n as ProfileName);
  }
  return out;
}
