// `wrap -- <command>`: a stdout-cleaning proxy to put in front of a server you cannot fix yet.
//
//   your app  --stdin-->  wrap  --stdin-->  server
//   your app  <--stdout-- wrap  <--stdout-- server   (only JSON-RPC lines pass; BOM and \r removed)
//                         wrap  --stderr--> app log  ("[wrap] diverted: ..." for everything else)

import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { LineSplitter, type LineRecord } from './framing.js';
import { withoutNpmExec } from './selfLaunch.js';

export interface WrapIO {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const NEWLINE = Buffer.from('\n');

/** Runs the server behind the proxy and resolves with the exit code to pass on. */
export function runWrap(command: string, args: string[], io: WrapIO, onSpawnError: (message: string) => void): Promise<number> {
  return new Promise((resolve) => {
    // 서버에는 앱이 준 환경을 넘긴다 — `npx -y mcp-launch-doctor wrap` 으로 떴을 때 npx 가 덧붙인 변수·캐시 PATH 는 뺀다
    const child = spawn(command, args, { env: withoutNpmExec(process.env), stdio: ['pipe', 'pipe', 'inherit'], shell: false, windowsHide: true });
    const splitter = new LineSplitter({ keepBody: true });
    let finished = false;

    // 앱이 wrap 을 끝내려 하면 같은 신호를 서버에도 전달한다
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    const forward = (signal: NodeJS.Signals) => { try { child.kill(signal); } catch { /* already gone */ } };
    for (const s of signals) process.on(s, forward);

    const done = (code: number) => {
      if (finished) return;
      finished = true;
      for (const s of signals) process.off(s, forward);
      io.stdin.unpipe(child.stdin);
      resolve(code);
    };

    // 부모 stdin → 자식 stdin 그대로. 부모 stdin 이 끝나면(EOF) pipe 가 자식 stdin 도 닫아 준다
    io.stdin.pipe(child.stdin);
    child.stdin.on('error', () => { /* server gone: its exit code is what matters */ });

    const forwardLines = (records: LineRecord[]) => {
      for (const rec of records) {
        if (rec.kind === 'jsonrpc' && rec.body) {
          // 원래 바이트를 그대로(BOM·\r 만 빼고) \n 하나로 끝내 내보낸다 — 다시 직렬화하지 않는다
          io.stdout.write(Buffer.concat([rec.body, NEWLINE]));
        } else {
          const what = rec.kind === 'blank' ? '(blank line)' : rec.preview ?? '';
          io.stderr.write(`[wrap] diverted: ${what}\n`);
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => forwardLines(splitter.push(chunk)));

    child.on('error', (err) => {
      onSpawnError(err.message);
      done(127);
    });

    // close = 자식이 끝나고 stdout 도 끝까지 읽음 → 남은 부분 줄까지 처리하고 종료 코드를 그대로 돌려준다
    child.on('close', (code, signal) => {
      forwardLines(splitter.end());
      if (code !== null) done(code);
      else done(128 + (signal ? constants.signals[signal] ?? 1 : 1));
    });
  });
}
