#!/usr/bin/env node
// Practice fixture (mock MCP server) — NOT a real MCP server.
// A tiny stdio MCP server that misbehaves on purpose so mcp-launch-doctor has something real to
// diagnose: it really writes banner bytes to stdout, really answers late, really exits with code 3.
//
// FAULT environment variable:
//   none        healthy server (one tool: echo)
//   banner      prints a startup banner and a debug line on stdout (stdout pollution)
//   slow        waits SLOW_MS (default 2000) before answering anything
//   exit        prints an error with a token to stderr and exits with code 3 before answering
//   version     answers initialize with protocolVersion 1999-01-01
//   crlf        ends every message with \r\n
//   bom         writes a UTF-8 byte order mark before the first message
//   notjsonrpc  prints a JSON status object that is not JSON-RPC on stdout
//   partial     after tools/list, writes a log notification without the final newline
//   firstrun    slow (SLOW_MS, default 3000) only the first time: creates FIRSTRUN_MARKER, then fast
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const FAULT = process.env.FAULT ?? 'none';
const NEWLINE = FAULT === 'crlf' ? '\r\n' : '\n';
let bomPending = FAULT === 'bom';

function send(message) {
  const prefix = bomPending ? '﻿' : '';
  bomPending = false;
  process.stdout.write(prefix + JSON.stringify(message) + NEWLINE);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (FAULT === 'exit') {
  // 시작하자마자 죽는 서버: stderr 에 원인을 남기고 종료 코드 3 (stdin 은 읽지 않으므로 바로 끝난다)
  process.stderr.write('config: API_TOKEN=' + 'sk' + '-test-123 rejected by upstream\n');
  process.stderr.write('Error: missing or invalid API_TOKEN\n');
  process.exitCode = 3;
} else {
  await start();
}

async function start() {
  if (FAULT === 'banner') process.stdout.write('Starting fixture server v0.1 ...\n');
  if (FAULT === 'notjsonrpc') process.stdout.write(JSON.stringify({ status: 'starting', pid: process.pid }) + '\n');
  if (FAULT === 'slow') await sleep(Number(process.env.SLOW_MS ?? 2000));
  if (FAULT === 'firstrun') {
    const marker = process.env.FIRSTRUN_MARKER;
    if (marker && !existsSync(marker)) {
      // 첫 실행만 느리다 — npx/uvx 가 처음에 패키지를 내려받는 상황을 흉내 낸다
      writeFileSync(marker, 'installed\n');
      await sleep(Number(process.env.SLOW_MS ?? 3000));
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const raw of rl) {
    if (raw.trim() === '') continue;
    let req;
    try {
      req = JSON.parse(raw);
    } catch {
      process.stderr.write('fixture: ignoring unparseable input line\n');
      continue;
    }
    handle(req);
  }
  // stdin 이 닫히면 for-await 가 끝나고 프로세스가 자연스럽게 종료된다(버퍼가 다 비워진 뒤)
}

function handle(req) {
  const { id, method } = req;
  if (method === 'initialize') {
    const protocolVersion = FAULT === 'version' ? '1999-01-01' : req.params?.protocolVersion ?? '2025-11-25';
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fault-fixture', version: '0.1.0' },
      },
    });
    if (FAULT === 'banner') process.stdout.write('[debug] initialized ok\n');
    return;
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: [{ name: 'echo', description: 'Echo the input text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] },
    });
    if (FAULT === 'partial') process.stdout.write('{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"');
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}
