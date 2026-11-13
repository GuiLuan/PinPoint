from __future__ import annotations

import json
import queue
import re
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, unquote, urlparse

from .models import ApiError
from .store import GraphStore

API_PREFIX = "/api/v1"


class ApiRouter:
    """Lightweight regex-based RESTful router over GraphStore."""

    def __init__(self, store: GraphStore, openapi_path: str | Path) -> None:
        self.store = store
        self.openapi_path = Path(openapi_path)
        self._routes: list[tuple[str, re.Pattern[str], Callable[..., tuple[int, Any]]]] = []
        self._register_routes()

    def _route(self, method: str, pattern: str) -> Callable[[Callable[..., tuple[int, Any]]], Callable[..., tuple[int, Any]]]:
        regex_str = re.sub(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}", r"(?P<\1>[^/]+)", pattern)
        compiled = re.compile(f"^{regex_str}$")

        def decorator(fn: Callable[..., tuple[int, Any]]) -> Callable[..., tuple[int, Any]]:
            self._routes.append((method.upper(), compiled, fn))
            return fn

        return decorator

    def _register_routes(self) -> None:
        # System
        @self._route("GET", "/health")
        def get_health(_query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            return 200, {"status": "ok", "service": "pinpoint-api", "version": "1.0.0"}

        # Graph & Workspace
        @self._route("GET", "/graph")
        def get_graph(query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            inc_raw = query.get("include", [None])[0]
            include = {s.strip() for s in inc_raw.split(",") if s.strip()} if inc_raw else None
            return 200, self.store.get_graph(include=include)

        @self._route("PUT", "/graph")
        def replace_graph(query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            mode = query.get("mode", ["replace"])[0]
            if mode == "sync":
                return 200, self.store.sync_from_client(body)
            return 200, self.store.replace_graph(body)

        @self._route("GET", "/graph/summary")
        def get_graph_summary(_query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            return 200, self.store.get_summary()

        @self._route("POST", "/graph/reset")
        def reset_graph(_query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            return 200, self.store.reset()

        @self._route("POST", "/graph/save")
        def save_graph(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            path_str = body.get("path") if isinstance(body, dict) else None
            return 200, self.store.save_to_file(path_str)

        # Cards
        @self._route("GET", "/cards")
        def list_cards(query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            q = query.get("q", [None])[0]
            group_id = query.get("groupId", [None])[0]
            return 200, self.store.list_cards(q=q, group_id=group_id)

        @self._route("POST", "/cards")
        def create_card(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            return 201, self.store.create_card(body)

        @self._route("POST", "/cards/batch")
        def batch_cards(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            return 200, self.store.batch_cards(body)

        @self._route("GET", "/cards/{cardId}")
        def get_card(_query: dict[str, list[str]], _body: Any, cardId: str) -> tuple[int, Any]:
            return 200, self.store.get_card(cardId)

        @self._route("PATCH", "/cards/{cardId}")
        def update_card(_query: dict[str, list[str]], body: Any, cardId: str) -> tuple[int, Any]:
            return 200, self.store.update_card(cardId, body)

        @self._route("DELETE", "/cards/{cardId}")
        def delete_card(_query: dict[str, list[str]], _body: Any, cardId: str) -> tuple[int, Any]:
            return 200, self.store.delete_card(cardId)

        @self._route("POST", "/cards/{cardId}/clone")
        def clone_card(_query: dict[str, list[str]], body: Any, cardId: str) -> tuple[int, Any]:
            ox = float(body.get("offsetX", 32)) if isinstance(body, dict) else 32.0
            oy = float(body.get("offsetY", 32)) if isinstance(body, dict) else 32.0
            return 201, self.store.clone_card(cardId, offset_x=ox, offset_y=oy)

        # Capsules
        @self._route("GET", "/cards/{cardId}/capsules")
        def list_capsules(_query: dict[str, list[str]], _body: Any, cardId: str) -> tuple[int, Any]:
            return 200, self.store.list_capsules(cardId)

        @self._route("POST", "/cards/{cardId}/capsules")
        def create_capsule(_query: dict[str, list[str]], body: Any, cardId: str) -> tuple[int, Any]:
            return 201, self.store.create_capsule(cardId, body)

        @self._route("PATCH", "/capsules/{pinId}")
        def update_capsule(_query: dict[str, list[str]], body: Any, pinId: str) -> tuple[int, Any]:
            return 200, self.store.update_capsule(pinId, body)

        @self._route("DELETE", "/capsules/{pinId}")
        def delete_capsule(_query: dict[str, list[str]], _body: Any, pinId: str) -> tuple[int, Any]:
            return 200, self.store.delete_capsule(pinId)

        # Connections
        @self._route("GET", "/connections")
        def list_connections(query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            return 200, self.store.list_connections(
                card_id=query.get("cardId", [None])[0],
                group_id=query.get("groupId", [None])[0],
                pin_id=query.get("pinId", [None])[0],
            )

        @self._route("POST", "/connections")
        def create_connection(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            return 201, self.store.create_connection(body)

        @self._route("PATCH", "/connections/{connId}")
        def update_connection(_query: dict[str, list[str]], body: Any, connId: str) -> tuple[int, Any]:
            return 200, self.store.update_connection(connId, body)

        @self._route("DELETE", "/connections/{connId}")
        def delete_connection(_query: dict[str, list[str]], _body: Any, connId: str) -> tuple[int, Any]:
            return 200, self.store.delete_connection(connId)

        # Groups
        @self._route("GET", "/groups")
        def list_groups(_query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            return 200, self.store.list_groups()

        @self._route("POST", "/groups")
        def create_group(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            return 201, self.store.create_group(body)

        @self._route("PATCH", "/groups/{groupId}")
        def update_group(_query: dict[str, list[str]], body: Any, groupId: str) -> tuple[int, Any]:
            return 200, self.store.update_group(groupId, body)

        @self._route("DELETE", "/groups/{groupId}")
        def delete_group(_query: dict[str, list[str]], _body: Any, groupId: str) -> tuple[int, Any]:
            return 200, self.store.delete_group(groupId)

        @self._route("POST", "/groups/{groupId}/members")
        def add_group_member(_query: dict[str, list[str]], body: Any, groupId: str) -> tuple[int, Any]:
            if not isinstance(body, dict) or not body.get("cardId"):
                raise ApiError(400, "MISSING_CARD_ID", "'cardId' is required.")
            return 200, self.store.add_card_to_group(groupId, str(body["cardId"]))

        @self._route("DELETE", "/groups/{groupId}/members/{cardId}")
        def remove_group_member(_query: dict[str, list[str]], _body: Any, groupId: str, cardId: str) -> tuple[int, Any]:
            return 200, self.store.remove_card_from_group(groupId, cardId)

        # Layout
        @self._route("POST", "/layout/align")
        def align_cards(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            if not isinstance(body, dict):
                raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
            return 200, self.store.align_cards(body.get("cardIds") or [], body.get("type") or "")

        @self._route("POST", "/layout/auto")
        def auto_layout(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            b = body if isinstance(body, dict) else {}
            return 200, self.store.auto_layout(
                strategy=b.get("strategy", "layered"),
                card_ids=b.get("cardIds"),
                spacing_x=float(b.get("spacingX", 96)),
                spacing_y=float(b.get("spacingY", 64)),
            )

        # History
        @self._route("GET", "/history")
        def get_history(_query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            return 200, self.store.get_history()

        @self._route("POST", "/history/undo")
        def undo_history(_query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            return 200, self.store.undo()

        @self._route("POST", "/history/redo")
        def redo_history(_query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            return 200, self.store.redo()

        # Viewport
        @self._route("GET", "/viewport")
        def get_viewport(_query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            return 200, self.store.get_viewport()

        @self._route("PATCH", "/viewport")
        def update_viewport(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            return 200, self.store.update_viewport(body)

        @self._route("POST", "/viewport/fit")
        def fit_viewport(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            b = body if isinstance(body, dict) else {}
            return 200, self.store.fit_viewport(
                viewport_width=float(b.get("viewportWidth", 1440)),
                viewport_height=float(b.get("viewportHeight", 900)),
            )

        @self._route("POST", "/viewport/focus")
        def focus_viewport(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            if not isinstance(body, dict):
                raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
            return 200, self.store.focus_viewport(
                card_ids=body.get("cardIds"),
                group_id=body.get("groupId"),
                viewport_width=float(body.get("viewportWidth", 1440)),
                viewport_height=float(body.get("viewportHeight", 900)),
            )

        # Settings
        @self._route("GET", "/settings")
        def get_settings(_query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            return 200, self.store.get_settings()

        @self._route("PATCH", "/settings")
        def update_settings(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            return 200, self.store.update_settings(body)

        @self._route("POST", "/settings/palette/reset")
        def reset_palette(_query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            return 200, self.store.reset_palette()

        # Live Selection (Transient UI <-> MCP)
        @self._route("GET", "/selection")
        def get_selection(_query: dict[str, list[str]], _body: Any) -> tuple[int, Any]:
            return 200, self.store.get_selection()

        @self._route("PUT", "/selection")
        def put_selection(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            strict = bool(isinstance(body, dict) and body.get("strict"))
            return 200, self.store.update_selection(body, strict=strict)

        @self._route("PATCH", "/selection")
        def patch_selection(_query: dict[str, list[str]], body: Any) -> tuple[int, Any]:
            strict = bool(isinstance(body, dict) and body.get("strict"))
            return 200, self.store.update_selection(body, strict=strict)

    def is_api_path(self, raw_path: str) -> bool:
        path = urlparse(raw_path).path
        return path == API_PREFIX or path.startswith(API_PREFIX + "/")

    def handle(
        self,
        method: str,
        raw_path: str,
        raw_body: bytes | None = None,
        client_id: str | None = None,
    ) -> tuple[int, dict[str, Any] | bytes, str]:
        parsed = urlparse(raw_path)
        rel_path = parsed.path[len(API_PREFIX):] or "/"
        query = parse_qs(parsed.query)
        effective_client_id = client_id or query.get("clientId", [None])[0]

        if method.upper() == "GET" and rel_path == "/openapi.json":
            if not self.openapi_path.exists():
                return 404, {"ok": False, "error": {"code": "OPENAPI_NOT_FOUND", "message": "OpenAPI spec not found."}}, "application/json"
            return 200, self.openapi_path.read_bytes(), "application/json"

        body: Any = None
        if raw_body:
            try:
                body = json.loads(raw_body.decode("utf-8"))
            except Exception as exc:
                return (
                    400,
                    {"ok": False, "error": {"code": "INVALID_JSON", "message": f"Invalid JSON body: {exc}"}},
                    "application/json",
                )

        path_matched_other_method = False
        for route_method, regex, handler in self._routes:
            m = regex.match(rel_path)
            if not m:
                continue
            if route_method != method.upper():
                path_matched_other_method = True
                continue
            kwargs = {k: unquote(v) for k, v in m.groupdict().items()}
            try:
                with self.store.client_context(effective_client_id):
                    status, data = handler(query, body, **kwargs)
                return status, {"ok": True, "data": data}, "application/json"
            except ApiError as err:
                error_obj: dict[str, Any] = {"code": err.code, "message": err.message}
                if err.details is not None:
                    error_obj["details"] = err.details
                return err.status, {"ok": False, "error": error_obj}, "application/json"
            except Exception as exc:
                return (
                    500,
                    {"ok": False, "error": {"code": "INTERNAL_ERROR", "message": str(exc)}},
                    "application/json",
                )

        if path_matched_other_method:
            return (
                405,
                {"ok": False, "error": {"code": "METHOD_NOT_ALLOWED", "message": f"Method {method} not allowed for {rel_path}."}},
                "application/json",
            )
        return (
            404,
            {"ok": False, "error": {"code": "ROUTE_NOT_FOUND", "message": f"API endpoint '{rel_path}' not found."}},
            "application/json",
        )

    def stream_events(self, write_fn: Callable[[bytes], None], flush_fn: Callable[[], None]) -> None:
        sub_q = self.store.subscribe()
        try:
            hello = json.dumps(
                {
                    "type": "CONNECTED",
                    "revision": self.store.revision,
                    "hasWorkspaceFile": self.store.has_workspace_file,
                    "state": self.store.get_graph(),
                    "selection": self.store.get_selection(),
                },
                ensure_ascii=False,
            )
            write_fn(f"event: connected\ndata: {hello}\n\n".encode("utf-8"))
            flush_fn()
            while True:
                try:
                    event = sub_q.get(timeout=15.0)
                    payload = json.dumps(event, ensure_ascii=False)
                    write_fn(f"data: {payload}\n\n".encode("utf-8"))
                    flush_fn()
                except queue.Empty:
                    write_fn(b": keepalive\n\n")
                    flush_fn()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.store.unsubscribe(sub_q)
