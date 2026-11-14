from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import signal
import socketserver
import threading
import webbrowser
from pathlib import Path

from .mcp import PinPointMcpServer, make_router_rest_caller
from .router import ApiRouter
from .store import GraphStore

DEFAULT_PORT = 5173
ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"
OPENAPI_PATH = ROOT_DIR / "docs" / "openapi.json"


class PinPointHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, router: ApiRouter, mcp: PinPointMcpServer, directory: str, **kwargs):
        self.router = router
        self.mcp = mcp
        super().__init__(*args, directory=directory, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-PinPoint-Client")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.router.is_api_path(self.path):
            if self.path.split("?")[0] == "/api/v1/events":
                self._handle_sse()
                return
            self._handle_api("GET")
            return
        super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] == "/mcp":
            self._handle_mcp()
            return
        self._handle_api("POST")

    def do_PUT(self):
        self._handle_api("PUT")

    def do_PATCH(self):
        self._handle_api("PATCH")

    def do_DELETE(self):
        self._handle_api("DELETE")

    def _read_body(self) -> bytes | None:
        raw_len = self.headers.get("Content-Length")
        if not raw_len:
            return None
        length = int(raw_len)
        return self.rfile.read(length) if length > 0 else None

    def _handle_mcp(self) -> None:
        raw_body = self._read_body()
        if not raw_body:
            self._send_json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Empty request body."}})
            return
        try:
            msg = json.loads(raw_body.decode("utf-8"))
        except Exception as exc:
            self._send_json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Parse error: {exc}"}})
            return

        if isinstance(msg, list):
            responses = []
            for item in msg:
                resp = self.mcp.handle_message(item)
                if resp is not None:
                    responses.append(resp)
            if not responses:
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self._send_json(200, responses)
            return

        resp = self.mcp.handle_message(msg)
        if resp is None:
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._send_json(200, resp)

    def _handle_api(self, method: str) -> None:
        if not self.router.is_api_path(self.path):
            self._send_json(404, {"ok": False, "error": {"code": "NOT_FOUND", "message": "Endpoint not found."}})
            return
        raw_body = self._read_body()
        client_id = self.headers.get("X-PinPoint-Client")
        status, payload, content_type = self.router.handle(method, self.path, raw_body, client_id=client_id)
        if isinstance(payload, bytes):
            body_bytes = payload
        else:
            body_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def _send_json(self, status: int, data: dict) -> None:
        body_bytes = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def _handle_sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.router.stream_events(self.wfile.write, self.wfile.flush)


class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def create_server(
    host: str = "",
    port: int = DEFAULT_PORT,
    workspace_file: str | Path | None = None,
) -> tuple[ThreadingTCPServer, GraphStore, ApiRouter]:
    store = GraphStore(workspace_file=workspace_file, base_dir=ROOT_DIR)
    router = ApiRouter(store=store, openapi_path=OPENAPI_PATH)
    mcp = PinPointMcpServer(make_router_rest_caller(router, client_id="pinpoint-mcp-http"))
    handler_cls = functools.partial(PinPointHandler, router=router, mcp=mcp, directory=str(FRONTEND_DIR))
    httpd = ThreadingTCPServer((host, port), handler_cls)
    return httpd, store, router


def main() -> None:
    parser = argparse.ArgumentParser(description="PinPoint Static + RESTful API Server")
    parser.add_argument("--host", type=str, default=os.environ.get("PINPOINT_HOST", ""))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PINPOINT_PORT", DEFAULT_PORT)))
    parser.add_argument("--workspace", type=str, default=os.environ.get("PINPOINT_WORKSPACE"))
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically open browser")
    args = parser.parse_args()

    httpd, _store, _router = create_server(host=args.host, port=args.port, workspace_file=args.workspace)

    def _handle_sigterm(_signum, _frame):
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _handle_sigterm)

    with httpd:
        actual_port = httpd.server_address[1]
        url = f"http://localhost:{actual_port}/index.html"
        api_url = f"http://localhost:{actual_port}/api/v1/openapi.json"
        mcp_url = f"http://localhost:{actual_port}/mcp"
        print("==================================================")
        print(f"PinPoint 服务正在运行: {url}")
        print(f"OpenAPI 规范地址:     {api_url}")
        print(f"MCP HTTP 端点:        {mcp_url}")
        if args.workspace:
            print(f"工作区持久化文件:     {args.workspace}")
        print("按 Ctrl+C 可停止服务")
        print("==================================================")
        if not args.no_browser and os.environ.get("PINPOINT_NO_BROWSER") != "1":
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务已退出")
