// Masks values that look like secrets before anything is printed.
// Applied to stderr tails, line previews, env listings and wrap's diverted lines.

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

const PATTERNS: Array<[RegExp, string]> = [
  // NAME=value or NAME: value where NAME looks secret (API_TOKEN=<value> -> API_TOKEN=***)
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;"']+)/gi, '$1$2***'],
  // "NAME": "value" inside JSON text
  [/("[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*"\s*:\s*)"[^"]*"/gi, '$1"***"'],
  // well-known token shapes
  [/\bsk-[A-Za-z0-9_-]{3,}/g, 'sk-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{10,}/g, 'gh*_***'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***'],
];

export function redactText(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Copy of env with secret-looking values replaced by ***. */
export function redactEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    out[name] = SECRET_NAME.test(name) ? '***' : redactText(value);
  }
  return out;
}

const SECRET_FLAG = /^--?[A-Za-z0-9_-]*(key|token|secret|password|passwd|credential)[A-Za-z0-9_-]*$/i;

/** Copy of an argument list with secrets masked: values after --api-key style flags and secret-looking tokens. */
export function redactArgs(args: readonly string[]): string[] {
  return args.map((arg, i) => {
    const prev = i > 0 ? args[i - 1] ?? '' : '';
    if (SECRET_FLAG.test(prev) && !arg.startsWith('-')) return '***';
    return redactText(arg);
  });
}
