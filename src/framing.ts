// Byte-level line framing for MCP stdio.
//
// The MCP stdio transport is "one JSON-RPC message per line, separated by \n, UTF-8, and
// nothing else on stdout". SDK clients skip lines they cannot parse, so a polluted stdout can
// still look healthy. Here we keep the raw bytes, split them ourselves and label every line.

import { redactText } from './redact.js';

export type LineKind = 'jsonrpc' | 'json_not_jsonrpc' | 'non_json' | 'blank';

export interface LineRecord {
  /** 0-based line number in the stdout stream */
  index: number;
  /** byte offset of the first byte of this line in the whole stdout stream */
  offset: number;
  /** length in bytes, without the trailing \n */
  bytes: number;
  kind: LineKind;
  /** line starts with a UTF-8 byte order mark (EF BB BF) */
  bom: boolean;
  /** line ends with \r before the \n */
  crlf: boolean;
  /** bytes are not valid UTF-8 */
  invalidUtf8: boolean;
  /** stream ended without a final \n (only the last line can be partial) */
  partial: boolean;
  /** first 80 characters, secrets masked (only for lines that are not JSON-RPC) */
  preview?: string;
  /** parsed message (only for jsonrpc lines) */
  message?: JsonRpcMessage;
  /** line bytes without BOM, \r and \n (only when the splitter was created with keepBody) */
  body?: Buffer;
}

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const NEWLINE = 0x0a;
const CR = 0x0d;
const PREVIEW_CHARS = 80;
// fatal: true makes the decoder throw on bad UTF-8 instead of silently inserting U+FFFD
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const lenientUtf8 = new TextDecoder('utf-8', { fatal: false });

/**
 * Splits a byte stream into lines no matter how the chunks are cut.
 * push() returns the lines completed by this chunk; end() returns the leftover partial line.
 */
export class LineSplitter {
  private pending: Buffer = Buffer.alloc(0);
  private pendingOffset = 0; // stream offset of pending[0]
  private nextIndex = 0;
  private seenBytes = 0;

  /** keepBody: also hand back the cleaned line bytes (wrap needs them to forward lines unchanged) */
  constructor(private readonly options: { keepBody?: boolean } = {}) {}

  push(chunk: Buffer): LineRecord[] {
    this.seenBytes += chunk.length;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const out: LineRecord[] = [];
    let nl: number;
    // 버퍼에 \n 이 있는 동안 한 줄씩 잘라 낸다 — 청크 경계와 무관하게 같은 결과가 나온다
    while ((nl = this.pending.indexOf(NEWLINE)) !== -1) {
      const line = this.pending.subarray(0, nl);
      out.push(classifyLine(line, this.pendingOffset, this.nextIndex++, false, this.options.keepBody));
      this.pendingOffset += nl + 1;
      this.pending = this.pending.subarray(nl + 1);
    }
    return out;
  }

  /** Call once when the stream closes. Returns the unterminated last line, if any. */
  end(): LineRecord[] {
    if (this.pending.length === 0) return [];
    const rec = classifyLine(this.pending, this.pendingOffset, this.nextIndex++, true, this.options.keepBody);
    this.pendingOffset += this.pending.length;
    this.pending = Buffer.alloc(0);
    return [rec];
  }

  /** total bytes received so far */
  get totalBytes(): number {
    return this.seenBytes;
  }
}

/** Labels one line (raw bytes without the trailing \n). */
export function classifyLine(raw: Buffer, offset: number, index: number, partial: boolean, keepBody = false): LineRecord {
  let body = raw;
  const bom = body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf;
  if (bom) body = body.subarray(3);
  const crlf = body.length > 0 && body[body.length - 1] === CR;
  if (crlf) body = body.subarray(0, body.length - 1);
  // 버퍼 조각은 원본 메모리를 공유하므로 보관할 때는 복사본을 쓴다
  const kept = keepBody ? Buffer.from(body) : undefined;

  let invalidUtf8 = false;
  let text: string;
  try {
    text = strictUtf8.decode(body);
  } catch {
    invalidUtf8 = true;
    text = lenientUtf8.decode(body);
  }

  const rec: LineRecord = { index, offset, bytes: raw.length, kind: 'non_json', bom, crlf, invalidUtf8, partial };
  if (kept) rec.body = kept;
  if (text.trim() === '') {
    rec.kind = 'blank';
    return rec;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    rec.kind = 'non_json';
    rec.preview = makePreview(text);
    return rec;
  }
  if (isJsonRpc(parsed)) {
    rec.kind = 'jsonrpc';
    rec.message = parsed;
  } else {
    // 유효한 JSON 이지만 {"jsonrpc":"2.0", ...} 형태가 아님 — 이것도 stdout 오염이다
    rec.kind = 'json_not_jsonrpc';
    rec.preview = makePreview(text);
  }
  return rec;
}

function isJsonRpc(value: unknown): value is JsonRpcMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { jsonrpc?: unknown }).jsonrpc === '2.0';
}

/** Short, single-line, secret-masked preview of a line. */
export function makePreview(text: string): string {
  // 제어 문자는 눈에 보이게 바꾸고, 비밀값은 가린 뒤 80자로 자른다
  // eslint-disable-next-line no-control-regex
  const visible = text.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
  const masked = redactText(visible);
  return masked.length > PREVIEW_CHARS ? masked.slice(0, PREVIEW_CHARS - 1) + '…' : masked;
}

/** True when a line breaks the "only MCP messages on stdout" rule. */
export function isPollution(rec: LineRecord): boolean {
  // 끝 줄바꿈 없이 끝난 마지막 줄은 내용과 상관없이 partial_line(프레이밍 경고)으로 따로 센다
  if (rec.partial) return false;
  return rec.kind === 'non_json' || rec.kind === 'json_not_jsonrpc';
}

/** True when a line is parseable but has a framing defect some clients reject. */
export function hasFramingDefect(rec: LineRecord): boolean {
  return rec.kind === 'blank' || rec.bom || rec.crlf || rec.invalidUtf8 || rec.partial;
}
