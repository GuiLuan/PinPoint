from __future__ import annotations

import argparse
from email.parser import BytesParser
from email.policy import default as email_default_policy
import functools
import http.server
import json
import os
import re
import signal
import socketserver
import threading
import urllib.parse
import webbrowser
from pathlib import Path

from .assets import MAX_ASSET_BYTES
from .mcp import PinPointMcpServer, make_router_rest_caller
from .models import ApiError
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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-PinPoint-Client, X-PinPoint-Filename, X-PinPoint-Kind, Range")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path_only = self.path.split("?")[0]
        if self.router.is_api_path(self.path):
            if path_only == "/api/v1/events":
                self._handle_sse()
                return
            if path_only.startswith("/api/v1/assets/") and path_only not in ("/api/v1/assets/stats",):
                self._handle_asset_get(path_only)
                return
            m_zip = re.match(r"^/api/v1/canvases/([^/]+)/export-bundle$", path_only)
            if m_zip:
                self._handle_export_bundle(urllib.parse.unquote(m_zip.group(1)))
                return
            self._handle_api("GET")
            return
        super().do_GET()

    def do_POST(self):
        path_only = self.path.split("?")[0]
        if path_only == "/mcp":
            self._handle_mcp()
            return
        if path_only == "/api/v1/assets":
            self._handle_asset_upload()
            return
        if path_only == "/api/v1/assets/bundle":
            self._handle_asset_bundle_upload()
            return
        if path_only == "/api/v1/assets/unpack-zip":
            self._handle_unpack_zip()
            return
        m_imp = re.match(r"^/api/v1/canvases/([^/]+)/import-bundle$", path_only)
        if m_imp:
            self._handle_import_bundle(urllib.parse.unquote(m_imp.group(1)))
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

    def _handle_asset_get(self, path_only: str) -> None:
        rel = path_only[len("/api/v1/assets/"):]
        parts = rel.split("/", 1)
        asset_id = urllib.parse.unquote(parts[0])
        sub_path = urllib.parse.unquote(parts[1]) if len(parts) > 1 else None
        resolved = self.router.store.assets.resolve_asset_file(asset_id, sub_path)
        if resolved is None:
            self._send_json(404, {"ok": False, "error": {"code": "ASSET_NOT_FOUND", "message": "Asset not found."}})
            return
        file_path, mime_type, _meta = resolved
        file_size = file_path.stat().st_size
        range_header = self.headers.get("Range")

        start = 0
        end = file_size - 1 if file_size > 0 else 0
        status = 200

        if range_header and file_size > 0:
            m = re.match(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not m:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            raw_start, raw_end = m.group(1), m.group(2)
            if raw_start == "" and raw_end == "":
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if raw_start == "":
                suffix_len = int(raw_end)
                start = max(0, file_size - suffix_len)
                end = file_size - 1
            else:
                start = int(raw_start)
                end = int(raw_end) if raw_end else file_size - 1
            if start >= file_size or end < start:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            end = min(end, file_size - 1)
            status = 206

        length = (end - start + 1) if file_size > 0 else 0
        self.send_response(status)
        self.send_header("Content-Type", mime_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()

        if length > 0:
            with file_path.open("rb") as fp:
                fp.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fp.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

    def _handle_asset_upload(self) -> None:
        raw_len = self.headers.get("Content-Length")
        if not raw_len:
            self._send_json(400, {"ok": False, "error": {"code": "MISSING_CONTENT_LENGTH", "message": "Content-Length required."}})
            return
        try:
            length = int(raw_len)
        except ValueError:
            self._send_json(400, {"ok": False, "error": {"code": "INVALID_CONTENT_LENGTH", "message": "Invalid Content-Length."}})
            return
        if length <= 0:
            self._send_json(400, {"ok": False, "error": {"code": "EMPTY_FILE", "message": "Empty file cannot be uploaded."}})
            return
        if length > MAX_ASSET_BYTES:
            self._send_json(413, {"ok": False, "error": {"code": "FILE_TOO_LARGE", "message": f"File exceeds {MAX_ASSET_BYTES // (1024 * 1024)}MB limit."}})
            return

        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        raw_name = self.headers.get("X-PinPoint-Filename") or qs.get("filename", ["media.bin"])[0]
        filename = urllib.parse.unquote(raw_name)
        kind = self.headers.get("X-PinPoint-Kind") or qs.get("kind", [None])[0]
        mime_type = self.headers.get("Content-Type") or ""

        try:
            meta = self.router.store.assets.save_single_stream(
                self.rfile,
                length,
                filename=filename,
                mime_type=mime_type,
                kind=kind,
            )
            self._send_json(201, {"ok": True, "data": meta})
        except ValueError as exc:
            self._send_json(400, {"ok": False, "error": {"code": "INVALID_ASSET", "message": str(exc)}})
        except Exception as exc:
            self._send_json(500, {"ok": False, "error": {"code": "UPLOAD_FAILED", "message": str(exc)}})

    def _handle_asset_bundle_upload(self) -> None:
        raw_len = self.headers.get("Content-Length")
        if not raw_len:
            self._send_json(400, {"ok": False, "error": {"code": "MISSING_CONTENT_LENGTH", "message": "Content-Length required."}})
            return
        length = int(raw_len)
        if length <= 0 or length > MAX_ASSET_BYTES:
            self._send_json(413, {"ok": False, "error": {"code": "FILE_TOO_LARGE", "message": "Folder bundle empty or exceeds 500MB limit."}})
            return
        ctype = self.headers.get("Content-Type") or ""
        if "multipart/form-data" not in ctype.lower():
            self._send_json(400, {"ok": False, "error": {"code": "INVALID_CONTENT_TYPE", "message": "Expected multipart/form-data."}})
            return

        raw_body = self.rfile.read(length)
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        root_name = urllib.parse.unquote(self.headers.get("X-PinPoint-Filename") or qs.get("name", ["site"])[0])
        entry_path = qs.get("entry", [None])[0]

        try:
            msg_bytes = f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n".encode("latin-1") + raw_body
            msg = BytesParser(policy=email_default_policy).parsebytes(msg_bytes)
            files_list: list[tuple[str, bytes]] = []
            for part in msg.iter_parts():
                part_name = part.get_param("name", header="content-disposition")
                if part_name == "entry":
                    val = part.get_payload(decode=True)
                    if val and not entry_path:
                        entry_path = val.decode("utf-8", errors="ignore").strip() or None
                    continue
                if part_name == "rootName":
                    val = part.get_payload(decode=True)
                    if val:
                        root_name = val.decode("utf-8", errors="ignore").strip() or root_name
                    continue
                rel_fn = part.get_filename() or ""
                data = part.get_payload(decode=True) or b""
                if rel_fn:
                    files_list.append((rel_fn, data))
            meta = self.router.store.assets.save_bundle_files(files_list, root_name=root_name, entry_path=entry_path)
            self._send_json(201, {"ok": True, "data": meta})
        except ValueError as exc:
            self._send_json(400, {"ok": False, "error": {"code": "INVALID_BUNDLE", "message": str(exc)}})
        except Exception as exc:
            self._send_json(500, {"ok": False, "error": {"code": "BUNDLE_UPLOAD_FAILED", "message": str(exc)}})

    def _handle_export_bundle(self, canvas_id: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        fmt = qs.get("format", ["zip"])[0].lower()
        inc_sub = qs.get("includeSubcanvases", ["true"])[0].lower() != "false"
        try:
            if fmt == "zip":
                zip_bytes, title = self.router.store.export_canvas_zip(canvas_id=canvas_id, include_subcanvases=inc_sub)
                safe_title = re.sub(r'[\\/:*?"<>|]', "_", title or "graph")
                encoded_name = urllib.parse.quote(f"{safe_title}.pinpoint.zip")
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Disposition", f"attachment; filename=\"graph.pinpoint.zip\"; filename*=UTF-8''{encoded_name}")
                self.send_header("Content-Length", str(len(zip_bytes)))
                self.end_headers()
                self.wfile.write(zip_bytes)
            else:
                data = self.router.store.export_canvas(canvas_id=canvas_id, include_subcanvases=inc_sub, include_assets=True)
                self._send_json(200, {"ok": True, "data": data})
        except ApiError as err:
            self._send_json(err.status, {"ok": False, "error": {"code": err.code, "message": err.message}})
        except Exception as exc:
            self._send_json(500, {"ok": False, "error": {"code": "EXPORT_FAILED", "message": str(exc)}})

    def _handle_import_bundle(self, canvas_id: str) -> None:
        raw_body = self._read_body()
        if not raw_body:
            self._send_json(400, {"ok": False, "error": {"code": "EMPTY_BODY", "message": "Import payload is empty."}})
            return
        ctype = (self.headers.get("Content-Type") or "").lower()
        try:
            if "zip" in ctype or raw_body[:2] == b"PK":
                res = self.router.store.import_zip_bundle(canvas_id, raw_body)
                self._send_json(200, {"ok": True, "data": res})
            else:
                data = json.loads(raw_body.decode("utf-8"))
                res = self.router.store.import_canvas(canvas_id, data)
                self._send_json(200, {"ok": True, "data": res})
        except ApiError as err:
            self._send_json(err.status, {"ok": False, "error": {"code": err.code, "message": err.message}})
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": {"code": "IMPORT_FAILED", "message": str(exc)}})

    def _handle_unpack_zip(self) -> None:
        raw_body = self._read_body()
        if not raw_body:
            self._send_json(400, {"ok": False, "error": {"code": "EMPTY_BODY", "message": "Zip payload is empty."}})
            return
        try:
            graph_data = self.router.store.assets.import_zip_bundle(raw_body)
            self._send_json(200, {"ok": True, "data": graph_data})
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": {"code": "UNPACK_FAILED", "message": str(exc)}})


class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def create_server(
    host: str = "",
    port: int = DEFAULT_PORT,
    workspace_file: str | Path | None = None,
    library_file: str | Path | None = None,
    db_path: str | Path | None = None,
) -> tuple[ThreadingTCPServer, GraphStore, ApiRouter]:
    store = GraphStore(workspace_file=workspace_file, base_dir=ROOT_DIR, library_file=library_file, db_path=db_path)
    router = ApiRouter(store=store, openapi_path=OPENAPI_PATH)
    mcp = PinPointMcpServer(make_router_rest_caller(router, client_id="pinpoint-mcp-http"))
    handler_cls = functools.partial(PinPointHandler, router=router, mcp=mcp, directory=str(FRONTEND_DIR))
    httpd = ThreadingTCPServer((host, port), handler_cls)
    return httpd, store, router


def main() -> None:
    parser = argparse.ArgumentParser(description="PinPoint Static + RESTful API + SQLite Server")
    parser.add_argument("--host", type=str, default=os.environ.get("PINPOINT_HOST", ""))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PINPOINT_PORT", DEFAULT_PORT)))
    parser.add_argument("--db", type=str, default=os.environ.get("PINPOINT_DB"))
    parser.add_argument("--workspace", type=str, default=os.environ.get("PINPOINT_WORKSPACE"))
    parser.add_argument("--library", type=str, default=os.environ.get("PINPOINT_LIBRARY"))
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically open browser")
    args = parser.parse_args()

    resolved_db = args.db
    if not resolved_db:
        if args.workspace:
            resolved_db = str(Path(args.workspace).with_suffix(".db"))
        else:
            resolved_db = str(ROOT_DIR / "data" / "pinpoint.db")

    httpd, _store, _router = create_server(
        host=args.host,
        port=args.port,
        workspace_file=args.workspace,
        library_file=args.library,
        db_path=resolved_db,
    )

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
        print(f"SQLite 数据库路径:    {resolved_db}")
        print(f"OpenAPI 规范地址:     {api_url}")
        print(f"MCP HTTP 端点:        {mcp_url}")
        if args.workspace:
            print(f"工作区导入/导出文件:  {args.workspace}")
        print("按 Ctrl+C 可停止服务")
        print("==================================================")
        if not args.no_browser and os.environ.get("PINPOINT_NO_BROWSER") != "1":
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n服务已退出")
