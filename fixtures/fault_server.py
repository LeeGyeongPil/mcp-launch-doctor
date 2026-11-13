"""Practice fixture (mock MCP server) for Python-specific faults — NOT a real MCP server.

FAULT environment variable:
  none      healthy server, flushes after every message
  noflush   never flushes stdout. When stdout is a pipe Python block-buffers it, so the
            initialize answer stays in the buffer and the client times out. Setting
            PYTHONUNBUFFERED=1 (or running `python3 -u`) makes the same code answer at once.
  banner    prints a startup banner on stdout (stdout pollution)
"""
import json
import os
import sys

FAULT = os.environ.get("FAULT", "none")


def out(raw: str) -> None:
    sys.stdout.write(raw)
    if FAULT != "noflush":
        sys.stdout.flush()


def send(msg: dict) -> None:
    out(json.dumps(msg) + "\n")


if FAULT == "banner":
    out("Starting python fixture ...\n")

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    req = json.loads(raw)
    method = req.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": req["id"], "result": {
            "protocolVersion": req["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "py-fault-fixture", "version": "0.1.0"},
        }})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": req["id"], "result": {"tools": [
            {"name": "echo", "description": "Echo the input text", "inputSchema": {"type": "object"}}
        ]}})
    elif "id" in req:
        send({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32601, "message": "Method not found"}})
