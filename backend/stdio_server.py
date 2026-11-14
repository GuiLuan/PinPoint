from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .mcp import PinPointMcpServer, make_http_rest_caller, make_router_rest_caller
from .router import ApiRouter
from .store import GraphStore

ROOT_DIR = Path(__file__).resolve().parent.parent
OPENAPI_PATH = ROOT_DIR / "docs" / "openapi.json"
DEFAULT_API_BASE = "http://localhost:5173/api/v1"


def run_stdio_loop(mcp: PinPointMcpServer, stdin=None, stdout=None) -> None:
    in_stream = stdin or sys.stdin
    out_stream = stdout or sys.stdout

    if hasattr(in_stream, "reconfigure"):
        in_stream.reconfigure(encoding="utf-8")
    if hasattr(out_stream, "reconfigure"):
        out_stream.reconfigure(encoding="utf-8")

    for raw_line in in_stream:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as exc:
            err_resp = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Parse error: {exc}"},
            }
            out_stream.write(json.dumps(err_resp, ensure_ascii=False) + "\n")
            out_stream.flush()
            continue

        if isinstance(msg, list):
            responses = []
            for item in msg:
                resp = mcp.handle_message(item)
                if resp is not None:
                    responses.append(resp)
            if responses:
                out_stream.write(json.dumps(responses, ensure_ascii=False) + "\n")
                out_stream.flush()
        else:
            resp = mcp.handle_message(msg)
            if resp is not None:
                out_stream.write(json.dumps(resp, ensure_ascii=False) + "\n")
                out_stream.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description="PinPoint MCP Stdio Server")
    parser.add_argument(
        "--api-base",
        type=str,
        default=os.environ.get("PINPOINT_API_BASE", DEFAULT_API_BASE),
        help="PinPoint REST API base URL (default: http://localhost:5173/api/v1)",
    )
    parser.add_argument(
        "--embedded",
        action="store_true",
        help="Run with an in-process GraphStore instead of forwarding to server.py",
    )
    parser.add_argument(
        "--workspace",
        type=str,
        default=os.environ.get("PINPOINT_WORKSPACE"),
        help="Workspace .pinpoint file path when running in --embedded mode",
    )
    args = parser.parse_args()

    if args.embedded:
        store = GraphStore(workspace_file=args.workspace, base_dir=ROOT_DIR)
        router = ApiRouter(store=store, openapi_path=OPENAPI_PATH)
        caller = make_router_rest_caller(router, client_id="pinpoint-mcp-embedded")
    else:
        caller = make_http_rest_caller(args.api_base, client_id="pinpoint-mcp-stdio")

    mcp = PinPointMcpServer(caller)
    run_stdio_loop(mcp)
