# Why mcp-launch-doctor does not use the MCP SDK client

The MCP stdio transport has three simple rules
([spec 2025-11-25, Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)):

1. Messages are JSON-RPC 2.0, one per line, separated by `\n`, with no newline inside a message.
2. The server MUST NOT write anything to stdout that is not a valid MCP message. Logs go to stderr.
3. Everything is UTF-8.

A health check built on the official TypeScript SDK client cannot see most violations of rule 2,
because the SDK is designed to be forgiving.

## What the SDK does with a bad line

`@modelcontextprotocol/sdk` 1.32.2 reads stdout through `ReadBuffer` (`dist/esm/shared/stdio.js`):

- it splits on `\n` and strips one trailing `\r`;
- each line goes through `JSON.parse` and the JSON-RPC schema;
- when that fails, the error is reported through `transport.onerror` / `client.onerror`
  and **the transport keeps reading the next line**. The connection stays up.

So a server that prints `Starting server v0.1 ...` before its first answer still "connects",
lists its tools and looks healthy to an SDK-based checker. Real clients are less forgiving and
fail with messages such as "Server disconnected", "Connection closed" or "Client closed",
depending on the client and version.

## Reproduced

Measured on 2026-11-13 with SDK 1.32.2 and the bundled practice fixture (mock server)
`fixtures/fault-server.mjs` with `FAULT=banner`:

| Checker | Result |
|---|---|
| SDK `Client.connect()` + `listTools()` | success, 1 tool; two `onerror` calls (`Unexpected token 'S', "Starting f"... is not valid JSON`) that a checker has to opt into |
| `mcp-launch-doctor run` | `stdout_pollution`: line 1 at byte 0 and line 3 at a later byte offset, with previews |

To see it yourself (outside this repository's dependencies):

```bash
mkdir sdk-check && cd sdk-check && npm init -y >/dev/null
npm install @modelcontextprotocol/sdk@1.32.2
cat > check.mjs <<'EOF'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const transport = new StdioClientTransport({ command: 'node', args: [process.argv[2]], env: { ...process.env, FAULT: 'banner' } });
const client = new Client({ name: 'sdk-check', version: '0' });
client.onerror = (e) => console.log('onerror:', e.message);
await client.connect(transport);
console.log('tools:', (await client.listTools()).tools.length);
await client.close();
EOF
node check.mjs /path/to/mcp-launch-doctor/fixtures/fault-server.mjs
```

## What the hand-written client does instead

`src/framing.ts` keeps the raw stdout bytes, splits them on `\n` itself (independent of how the
chunks arrive) and labels every line:

| Label | Meaning | Verdict |
|---|---|---|
| `jsonrpc` | a JSON object with `"jsonrpc": "2.0"` | fine |
| `json_not_jsonrpc` | valid JSON, but not JSON-RPC (for example a status object) | `stdout_pollution` |
| `non_json` | anything else (banners, `print` output, progress bars) | `stdout_pollution` |
| `blank` | an empty line | `framing_warning` |
| `bom` flag | the line starts with a UTF-8 byte order mark | `framing_warning` |
| `crlf` flag | the line ends with `\r\n` | `framing_warning` |
| `invalid_utf8` flag | the bytes are not valid UTF-8 | `framing_warning` |
| `partial_line` flag | the stream ended without a final `\n` | `framing_warning` |

Each line keeps its byte offset in the stream, so the report can say exactly where the bad output
starts. The SDK is still the right choice for building a client; it is just the wrong instrument
for measuring whether a server follows the transport rules.
