// Language choice and message lookup. Rule: --lang > MCP_LAUNCH_DOCTOR_LANG > LC_ALL > LC_MESSAGES > LANG;
// a value starting with "ko" means Korean, anything else means English.

import { en, type MessageKey } from './locales/en.js';
import { ko } from './locales/ko.js';

export const LANGS = ['en', 'ko'] as const;
export type Lang = (typeof LANGS)[number];
export const LANG_ENV = 'MCP_LAUNCH_DOCTOR_LANG';

export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, ko };

export function resolveLang(flag: string | undefined, env: NodeJS.ProcessEnv): Lang {
  // 앞에서부터 처음으로 값이 있는 것을 쓴다
  const candidates = [flag, env[LANG_ENV], env.LC_ALL, env.LC_MESSAGES, env.LANG];
  const first = candidates.find((v) => v !== undefined && v !== '');
  return first?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export type Params = Record<string, string | number | boolean | null | undefined>;

export function t(lang: Lang, key: MessageKey, params: Params = {}): string {
  const template = MESSAGES[lang][key] ?? en[key];
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? whole : String(value);
  });
}

export type { MessageKey };
