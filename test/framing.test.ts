// AC-1: byte-level line splitter and classifier.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyLine, LineSplitter, type LineRecord } from '#lib/framing';
import { fixtureStdout } from './helpers.js';

function splitAll(bytes: Buffer, chunkSize: number): LineRecord[] {
  const s = new LineSplitter();
  const out: LineRecord[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) out.push(...s.push(bytes.subarray(i, i + chunkSize)));
  out.push(...s.end());
  return out;
}

const strip = (recs: LineRecord[]) => recs.map(({ message, ...rest }) => ({ ...rest, id: message?.id }));

test('banner fixture: same lines and offsets for 1-byte chunks and one chunk', async () => {
  const bytes = await fixtureStdout('banner');
  const whole = splitAll(bytes, bytes.length);
  const tiny = splitAll(bytes, 1);
  assert.deepEqual(strip(tiny), strip(whole));

  const banner = 'Starting fixture server v0.1 ...\n';
  assert.equal(whole[0]?.kind, 'non_json');
  assert.equal(whole[0]?.offset, 0);
  assert.equal(whole[0]?.preview, 'Starting fixture server v0.1 ...');
  assert.equal(whole[1]?.kind, 'jsonrpc');
  assert.equal(whole[1]?.offset, Buffer.byteLength(banner));
  // 두 번째 비 JSON 줄의 위치 = 배너 + initialize 응답 줄(줄바꿈 포함)
  const debug = whole.find((r) => r.preview === '[debug] initialized ok');
  assert.ok(debug, 'debug line found');
  assert.equal(debug.offset, Buffer.byteLength(banner) + (whole[1]?.bytes ?? 0) + 1);
  assert.equal(debug.offset, bytes.indexOf('[debug] initialized ok'));
  assert.equal(whole.filter((r) => r.kind === 'non_json').length, 2);
  assert.equal(whole.filter((r) => r.kind === 'jsonrpc').length, 2);
});

test('odd chunk sizes give identical records', async () => {
  const bytes = await fixtureStdout('crlf');
  const reference = strip(splitAll(bytes, bytes.length));
  for (const size of [1, 2, 3, 7, 64]) assert.deepEqual(strip(splitAll(bytes, size)), reference, `chunk size ${size}`);
});

test('classifies jsonrpc, json_not_jsonrpc, non_json and blank', () => {
  assert.equal(classifyLine(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}'), 0, 0, false).kind, 'jsonrpc');
  assert.equal(classifyLine(Buffer.from('{"status":"ok"}'), 0, 0, false).kind, 'json_not_jsonrpc');
  assert.equal(classifyLine(Buffer.from('[1,2]'), 0, 0, false).kind, 'json_not_jsonrpc');
  assert.equal(classifyLine(Buffer.from('{"jsonrpc":"1.0"}'), 0, 0, false).kind, 'json_not_jsonrpc');
  assert.equal(classifyLine(Buffer.from('hello'), 0, 0, false).kind, 'non_json');
  assert.equal(classifyLine(Buffer.from('   '), 0, 0, false).kind, 'blank');
  assert.equal(classifyLine(Buffer.from(''), 0, 0, false).kind, 'blank');
});

test('flags BOM, CRLF, invalid UTF-8 and partial lines', () => {
  const bom = classifyLine(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"jsonrpc":"2.0","method":"x"}')]), 0, 0, false);
  assert.equal(bom.kind, 'jsonrpc');
  assert.equal(bom.bom, true);

  const crlf = classifyLine(Buffer.from('{"jsonrpc":"2.0","method":"x"}\r'), 0, 0, false);
  assert.equal(crlf.kind, 'jsonrpc');
  assert.equal(crlf.crlf, true);

  const bad = classifyLine(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","method":"x","params":{"s":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}}')]), 0, 0, false);
  assert.equal(bad.invalidUtf8, true);
  assert.equal(bad.kind, 'jsonrpc');

  const s = new LineSplitter();
  assert.equal(s.push(Buffer.from('{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0"')).length, 1);
  const tail = s.end();
  assert.equal(tail.length, 1);
  assert.equal(tail[0]?.partial, true);
  assert.equal(tail[0]?.offset, 31);
  assert.equal(s.end().length, 0, 'end() twice yields nothing more');
});

test('previews are capped at 80 characters, show control characters and mask secrets', () => {
  const long = classifyLine(Buffer.from('x'.repeat(200)), 0, 0, false);
  assert.equal(long.preview?.length, 80);
  const ctl = classifyLine(Buffer.from('a\tb'), 0, 0, false);
  assert.equal(ctl.preview, 'a\\x09b');
  const secret = classifyLine(Buffer.from('loaded OPENAI_API_KEY=' + 'sk' + '-abc123456 ok'), 0, 0, false);
  assert.equal(secret.preview, 'loaded OPENAI_API_KEY=*** ok');
});

test('line indexes and offsets accumulate across lines', () => {
  const recs = splitAll(Buffer.from('a\n\nbc\r\nd'), 1);
  assert.deepEqual(recs.map((r) => [r.index, r.offset, r.bytes, r.kind, r.crlf, r.partial]), [
    [0, 0, 1, 'non_json', false, false],
    [1, 2, 0, 'blank', false, false],
    [2, 3, 3, 'non_json', true, false],
    [3, 7, 1, 'non_json', false, true],
  ]);
});
