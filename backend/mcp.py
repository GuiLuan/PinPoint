from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

SUPPORTED_PROTOCOL_VERSIONS = {"2025-06-18", "2025-03-26", "2024-11-05"}
DEFAULT_PROTOCOL_VERSION = "2024-11-05"

RestCallFn = Callable[[str, str, dict[str, Any] | None], tuple[int, dict[str, Any]]]


def make_http_rest_caller(api_base: str, client_id: str = "pinpoint-mcp") -> RestCallFn:
    """Create a REST caller targeting a running PinPoint HTTP server."""
    base = api_base.rstrip("/")

    def call_rest(method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
        url = f"{base}{path}"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        headers = {"X-PinPoint-Client": client_id}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", errors="replace")
            try:
                return err.code, json.loads(raw)
            except Exception:
                return err.code, {"ok": False, "error": {"code": f"HTTP_{err.code}", "message": raw or str(err)}}
        except urllib.error.URLError as err:
            return 503, {
                "ok": False,
                "error": {
                    "code": "PINPOINT_SERVER_UNREACHABLE",
                    "message": f"Cannot reach PinPoint API at {base} ({err.reason}). Start server.py first.",
                },
            }

    return call_rest


def make_router_rest_caller(router: Any, client_id: str = "pinpoint-mcp-http") -> RestCallFn:
    """Create an in-process REST caller directly invoking ApiRouter."""

    def call_rest(method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
        raw_body = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        status, payload, _ct = router.handle(method.upper(), f"/api/v1{path}", raw_body, client_id=client_id)
        if isinstance(payload, bytes):
            payload = json.loads(payload.decode("utf-8"))
        return status, payload

    return call_rest


MCP_TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_graph_summary",
        "description": "Get a compact overview of the current PinPoint knowledge graph: all cards (id, title, position, plain contentText, capsules with pinIds, headerPins), connections, and groups. Call this first to inspect existing nodes before editing.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "get_card",
        "description": "Get detailed information for a single card by ID, including its parsed capsules and connected wires.",
        "inputSchema": {
            "type": "object",
            "required": ["cardId"],
            "properties": {
                "cardId": {"type": "string", "description": "Target card ID"},
            },
        },
    },
    {
        "name": "search_cards",
        "description": "Search cards by keyword in title or body text, optionally filtered by groupId.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "Keyword to match in card title or content"},
                "groupId": {"type": "string", "description": "Optional group ID filter"},
            },
        },
    },
    {
        "name": "create_card",
        "description": "Create a new node card on the infinite canvas. Supports plain contentText and optional inline highlighted text capsules that can act as wire endpoints.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Card header title"},
                "contentText": {"type": "string", "description": "Plain text body content"},
                "capsules": {
                    "type": "array",
                    "description": "Optional inline text capsules to highlight within contentText (or append if not matched)",
                    "items": {
                        "type": "object",
                        "required": ["text"],
                        "properties": {
                            "text": {"type": "string"},
                            "color": {"type": ["string", "null"], "description": "Hex color e.g. #30d158, #0a84ff, #bf5af2"},
                        },
                    },
                },
                "x": {"type": "number", "description": "Optional X coordinate on canvas (auto-placed if omitted)"},
                "y": {"type": "number", "description": "Optional Y coordinate on canvas (auto-placed if omitted)"},
                "width": {"type": "number", "minimum": 250, "description": "Card width in px (min 250, default 310)"},
                "headerColor": {"type": ["string", "null"], "description": "Optional header accent hex color"},
            },
        },
    },
    {
        "name": "update_card",
        "description": "Update an existing card's title, plain contentText (with optional capsules), coordinates, width, or headerColor.",
        "inputSchema": {
            "type": "object",
            "required": ["cardId"],
            "properties": {
                "cardId": {"type": "string"},
                "title": {"type": "string"},
                "contentText": {"type": "string"},
                "capsules": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["text"],
                        "properties": {
                            "text": {"type": "string"},
                            "color": {"type": ["string", "null"]},
                        },
                    },
                },
                "x": {"type": "number"},
                "y": {"type": "number"},
                "width": {"type": "number", "minimum": 250},
                "headerColor": {"type": ["string", "null"]},
            },
        },
    },
    {
        "name": "delete_card",
        "description": "Delete a card and cascade-clean its connections and group memberships.",
        "inputSchema": {
            "type": "object",
            "required": ["cardId"],
            "properties": {
                "cardId": {"type": "string"},
            },
        },
    },
    {
        "name": "batch_mutate_cards",
        "description": "Batch create, update, or delete multiple cards in a single operation (recommended when generating a multi-node mind map).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "create": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "title": {"type": "string"},
                            "contentText": {"type": "string"},
                            "capsules": {"type": "array", "items": {"type": "object"}},
                            "x": {"type": "number"},
                            "y": {"type": "number"},
                            "width": {"type": "number", "minimum": 250},
                            "headerColor": {"type": ["string", "null"]},
                        },
                    },
                },
                "update": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "required": ["id"],
                        "properties": {
                            "id": {"type": "string"},
                            "title": {"type": "string"},
                            "contentText": {"type": "string"},
                            "x": {"type": "number"},
                            "y": {"type": "number"},
                            "width": {"type": "number", "minimum": 250},
                            "headerColor": {"type": ["string", "null"]},
                        },
                    },
                },
                "deleteIds": {"type": "array", "items": {"type": "string"}},
            },
        },
    },
    {
        "name": "clone_card",
        "description": "Clone an existing card with new IDs and remapped capsule pins.",
        "inputSchema": {
            "type": "object",
            "required": ["cardId"],
            "properties": {
                "cardId": {"type": "string"},
                "offsetX": {"type": "number", "default": 32},
                "offsetY": {"type": "number", "default": 32},
            },
        },
    },
    {
        "name": "create_capsule",
        "description": "Turn a phrase in a card's plain text into a colored connectable text capsule, or append a new capsule. Returns the new pinId.",
        "inputSchema": {
            "type": "object",
            "required": ["cardId"],
            "properties": {
                "cardId": {"type": "string"},
                "matchText": {"type": "string", "description": "Existing plain-text substring inside the card to highlight as a capsule"},
                "occurrence": {"type": "integer", "minimum": 1, "default": 1},
                "text": {"type": "string", "description": "Text to append when append=true or matchText is omitted"},
                "append": {"type": "boolean", "default": False},
                "color": {"type": ["string", "null"], "default": "#30d158"},
            },
        },
    },
    {
        "name": "update_capsule",
        "description": "Recolor or rename a text capsule by its pinId (automatically updates connected wire colors).",
        "inputSchema": {
            "type": "object",
            "required": ["pinId"],
            "properties": {
                "pinId": {"type": "string"},
                "color": {"type": ["string", "null"]},
                "text": {"type": "string"},
            },
        },
    },
    {
        "name": "delete_capsule",
        "description": "Unwrap a text capsule back into plain text and delete wires attached to it.",
        "inputSchema": {
            "type": "object",
            "required": ["pinId"],
            "properties": {
                "pinId": {"type": "string"},
            },
        },
    },
    {
        "name": "connect_nodes",
        "description": "Create a topological wire connection between two distinct entities (card headers, text capsules, or groups). You may pass exact pinIds (fromPinId/toPinId) OR semantic references (fromCardId + fromSide/fromCapsuleText, toCardId + toSide/toCapsuleText, or fromGroupId/toGroupId).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "fromPinId": {"type": "string"},
                "toPinId": {"type": "string"},
                "fromCardId": {"type": "string"},
                "fromSide": {"type": "string", "enum": ["left", "right"], "default": "right"},
                "fromCapsuleText": {"type": "string"},
                "toCardId": {"type": "string"},
                "toSide": {"type": "string", "enum": ["left", "right"], "default": "left"},
                "toCapsuleText": {"type": "string"},
                "fromGroupId": {"type": "string"},
                "toGroupId": {"type": "string"},
                "color": {"type": ["string", "null"]},
            },
        },
    },
    {
        "name": "update_connection",
        "description": "Reconnect a wire's target pin or change its color.",
        "inputSchema": {
            "type": "object",
            "required": ["connId"],
            "properties": {
                "connId": {"type": "string"},
                "toPinId": {"type": "string"},
                "color": {"type": ["string", "null"]},
            },
        },
    },
    {
        "name": "delete_connection",
        "description": "Remove a wire connection by ID.",
        "inputSchema": {
            "type": "object",
            "required": ["connId"],
            "properties": {
                "connId": {"type": "string"},
            },
        },
    },
    {
        "name": "create_group",
        "description": "Group 2 or more cards into a labeled container group.",
        "inputSchema": {
            "type": "object",
            "required": ["cardIds"],
            "properties": {
                "cardIds": {"type": "array", "minItems": 2, "items": {"type": "string"}},
                "title": {"type": "string"},
                "headerColor": {"type": ["string", "null"], "default": "#0a84ff"},
            },
        },
    },
    {
        "name": "update_group",
        "description": "Rename, recolor, or translate (move) a group and its member cards.",
        "inputSchema": {
            "type": "object",
            "required": ["groupId"],
            "properties": {
                "groupId": {"type": "string"},
                "title": {"type": "string"},
                "headerColor": {"type": ["string", "null"]},
                "deltaX": {"type": "number"},
                "deltaY": {"type": "number"},
            },
        },
    },
    {
        "name": "delete_group",
        "description": "Dissolve a group while preserving all member cards.",
        "inputSchema": {
            "type": "object",
            "required": ["groupId"],
            "properties": {
                "groupId": {"type": "string"},
            },
        },
    },
    {
        "name": "manage_group_members",
        "description": "Add a card to an existing group or remove a card from it (auto-dissolves the group if fewer than 2 members remain).",
        "inputSchema": {
            "type": "object",
            "required": ["groupId", "action", "cardId"],
            "properties": {
                "groupId": {"type": "string"},
                "action": {"type": "string", "enum": ["add", "remove"]},
                "cardId": {"type": "string"},
            },
        },
    },
    {
        "name": "align_cards",
        "description": "Align or evenly distribute 2+ (or 3+ for distribute) cards.",
        "inputSchema": {
            "type": "object",
            "required": ["cardIds", "type"],
            "properties": {
                "cardIds": {"type": "array", "minItems": 2, "items": {"type": "string"}},
                "type": {
                    "type": "string",
                    "enum": ["left", "center-h", "right", "top", "center-v", "bottom", "distribute-h", "distribute-v"],
                },
            },
        },
    },
    {
        "name": "auto_layout",
        "description": "Automatically arrange cards on the canvas using topology-aware 'layered' DAG layout or 'grid' layout to prevent overlap.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "strategy": {"type": "string", "enum": ["layered", "grid"], "default": "layered"},
                "cardIds": {"type": "array", "items": {"type": "string"}},
                "spacingX": {"type": "number", "default": 96},
                "spacingY": {"type": "number", "default": 64},
            },
        },
    },
    {
        "name": "focus_viewport",
        "description": "Fit all graph content in view (fitAll=true) or center the browser viewport on specific cardIds or a groupId.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "fitAll": {"type": "boolean", "default": False},
                "cardIds": {"type": "array", "items": {"type": "string"}},
                "groupId": {"type": "string"},
                "viewportWidth": {"type": "number", "default": 1440},
                "viewportHeight": {"type": "number", "default": 900},
            },
        },
    },
    {
        "name": "undo_redo",
        "description": "Undo or redo the most recent graph mutation.",
        "inputSchema": {
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {"type": "string", "enum": ["undo", "redo"]},
            },
        },
    },
    {
        "name": "save_graph",
        "description": "Save the current graph workspace as a .pinpoint JSON file.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Optional relative path within workspace"},
            },
        },
    },
    {
        "name": "get_selection",
        "description": "Get the cards, capsule, and inline highlighted textSelection ({cardId, text}) currently selected by the user on the live PinPoint browser canvas.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "set_selection",
        "description": "Highlight specific cards (or a group's cards) and/or a capsule on the live browser canvas.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "cardIds": {"type": "array", "items": {"type": "string"}, "description": "Card IDs to select (empty array clears selection)"},
                "groupId": {"type": "string", "description": "Optional group ID whose member cards should be selected"},
                "capsulePinId": {"type": ["string", "null"], "description": "Optional capsule pinId to highlight, or null to clear"},
            },
        },
    },
]

MCP_RESOURCES: list[dict[str, Any]] = [
    {
        "uri": "pinpoint://graph/summary",
        "name": "PinPoint Graph Summary",
        "description": "Compact AI-friendly summary of cards, capsules, connections, and groups",
        "mimeType": "application/json",
    },
    {
        "uri": "pinpoint://graph",
        "name": "PinPoint Full Graph State",
        "description": "Complete PinPoint workspace state including viewport and settings",
        "mimeType": "application/json",
    },
    {
        "uri": "pinpoint://selection",
        "name": "PinPoint Current Canvas Selection",
        "description": "Currently selected cards and capsule on the live PinPoint canvas",
        "mimeType": "application/json",
    },
    {
        "uri": "pinpoint://openapi",
        "name": "PinPoint OpenAPI 3.1 Specification",
        "description": "OpenAPI 3.1 JSON specification of the underlying RESTful API",
        "mimeType": "application/json",
    },
]


class PinPointMcpServer:
    """Zero-dependency MCP JSON-RPC 2.0 protocol handler backed by the RESTful API."""

    def __init__(self, call_rest: RestCallFn) -> None:
        self.call_rest = call_rest

    def handle_message(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        if not isinstance(msg, dict):
            return self._error_resp(None, -32600, "Invalid Request: expected JSON object.")

        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}

        # Notifications have no 'id' (or id is None for notifications like notifications/initialized)
        is_notification = "id" not in msg or method in ("notifications/initialized", "notifications/cancelled")

        if not isinstance(method, str):
            return None if is_notification else self._error_resp(req_id, -32600, "Invalid Request: missing method.")

        if method == "notifications/initialized":
            return None

        try:
            if method == "initialize":
                req_ver = params.get("protocolVersion") if isinstance(params, dict) else None
                proto = req_ver if req_ver in SUPPORTED_PROTOCOL_VERSIONS else DEFAULT_PROTOCOL_VERSION
                return self._ok_resp(
                    req_id,
                    {
                        "protocolVersion": proto,
                        "capabilities": {
                            "tools": {"listChanged": False},
                            "resources": {"subscribe": False, "listChanged": False},
                        },
                        "serverInfo": {"name": "pinpoint-mcp", "version": "1.0.0"},
                    },
                )

            if method == "ping":
                return self._ok_resp(req_id, {})

            if method == "tools/list":
                return self._ok_resp(req_id, {"tools": MCP_TOOLS})

            if method == "tools/call":
                if not isinstance(params, dict) or not params.get("name"):
                    return self._error_resp(req_id, -32602, "Invalid params: 'name' is required.")
                tool_name = str(params["name"])
                arguments = params.get("arguments") or {}
                if not isinstance(arguments, dict):
                    return self._error_resp(req_id, -32602, "Invalid params: 'arguments' must be an object.")
                result = self._execute_tool(tool_name, arguments)
                return self._ok_resp(req_id, result)

            if method == "resources/list":
                return self._ok_resp(req_id, {"resources": MCP_RESOURCES})

            if method == "resources/read":
                if not isinstance(params, dict) or not params.get("uri"):
                    return self._error_resp(req_id, -32602, "Invalid params: 'uri' is required.")
                return self._ok_resp(req_id, self._read_resource(str(params["uri"])))

            if is_notification:
                return None
            return self._error_resp(req_id, -32601, f"Method not found: {method}")
        except ValueError as exc:
            return None if is_notification else self._error_resp(req_id, -32602, str(exc))
        except Exception as exc:
            return None if is_notification else self._error_resp(req_id, -32603, f"Internal error: {exc}")

    def _execute_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        status: int
        res: dict[str, Any]

        if name == "get_graph_summary":
            status, res = self.call_rest("GET", "/graph/summary", None)
        elif name == "get_card":
            cid = urllib.parse.quote(str(args.get("cardId", "")), safe="")
            status, res = self.call_rest("GET", f"/cards/{cid}", None)
        elif name == "search_cards":
            qs_parts = []
            if args.get("q") is not None:
                qs_parts.append("q=" + urllib.parse.quote(str(args["q"])))
            if args.get("groupId") is not None:
                qs_parts.append("groupId=" + urllib.parse.quote(str(args["groupId"])))
            qs = ("?" + "&".join(qs_parts)) if qs_parts else ""
            status, res = self.call_rest("GET", f"/cards{qs}", None)
        elif name == "create_card":
            status, res = self.call_rest("POST", "/cards", args)
        elif name == "update_card":
            cid = urllib.parse.quote(str(args.get("cardId", "")), safe="")
            patch = {k: v for k, v in args.items() if k != "cardId"}
            status, res = self.call_rest("PATCH", f"/cards/{cid}", patch)
        elif name == "delete_card":
            cid = urllib.parse.quote(str(args.get("cardId", "")), safe="")
            status, res = self.call_rest("DELETE", f"/cards/{cid}", None)
        elif name == "batch_mutate_cards":
            status, res = self.call_rest("POST", "/cards/batch", args)
        elif name == "clone_card":
            cid = urllib.parse.quote(str(args.get("cardId", "")), safe="")
            body = {k: v for k, v in args.items() if k != "cardId"}
            status, res = self.call_rest("POST", f"/cards/{cid}/clone", body)
        elif name == "create_capsule":
            cid = urllib.parse.quote(str(args.get("cardId", "")), safe="")
            body = {k: v for k, v in args.items() if k != "cardId"}
            status, res = self.call_rest("POST", f"/cards/{cid}/capsules", body)
        elif name == "update_capsule":
            pid = urllib.parse.quote(str(args.get("pinId", "")), safe="")
            body = {k: v for k, v in args.items() if k != "pinId"}
            status, res = self.call_rest("PATCH", f"/capsules/{pid}", body)
        elif name == "delete_capsule":
            pid = urllib.parse.quote(str(args.get("pinId", "")), safe="")
            status, res = self.call_rest("DELETE", f"/capsules/{pid}", None)
        elif name == "connect_nodes":
            status, res = self.call_rest("POST", "/connections", args)
        elif name == "update_connection":
            conn_id = urllib.parse.quote(str(args.get("connId", "")), safe="")
            body = {k: v for k, v in args.items() if k != "connId"}
            status, res = self.call_rest("PATCH", f"/connections/{conn_id}", body)
        elif name == "delete_connection":
            conn_id = urllib.parse.quote(str(args.get("connId", "")), safe="")
            status, res = self.call_rest("DELETE", f"/connections/{conn_id}", None)
        elif name == "create_group":
            status, res = self.call_rest("POST", "/groups", args)
        elif name == "update_group":
            gid = urllib.parse.quote(str(args.get("groupId", "")), safe="")
            body = {k: v for k, v in args.items() if k != "groupId"}
            status, res = self.call_rest("PATCH", f"/groups/{gid}", body)
        elif name == "delete_group":
            gid = urllib.parse.quote(str(args.get("groupId", "")), safe="")
            status, res = self.call_rest("DELETE", f"/groups/{gid}", None)
        elif name == "manage_group_members":
            gid = urllib.parse.quote(str(args.get("groupId", "")), safe="")
            cid = str(args.get("cardId", ""))
            action = args.get("action")
            if action == "add":
                status, res = self.call_rest("POST", f"/groups/{gid}/members", {"cardId": cid})
            elif action == "remove":
                cid_q = urllib.parse.quote(cid, safe="")
                status, res = self.call_rest("DELETE", f"/groups/{gid}/members/{cid_q}", None)
            else:
                return self._tool_error("INVALID_ACTION", "action must be 'add' or 'remove'.")
        elif name == "align_cards":
            status, res = self.call_rest("POST", "/layout/align", args)
        elif name == "auto_layout":
            status, res = self.call_rest("POST", "/layout/auto", args)
        elif name == "focus_viewport":
            if args.get("fitAll"):
                body = {}
                if "viewportWidth" in args:
                    body["viewportWidth"] = args["viewportWidth"]
                if "viewportHeight" in args:
                    body["viewportHeight"] = args["viewportHeight"]
                status, res = self.call_rest("POST", "/viewport/fit", body)
            else:
                body = {k: v for k, v in args.items() if k != "fitAll"}
                status, res = self.call_rest("POST", "/viewport/focus", body)
        elif name == "undo_redo":
            action = args.get("action")
            if action not in ("undo", "redo"):
                return self._tool_error("INVALID_ACTION", "action must be 'undo' or 'redo'.")
            status, res = self.call_rest("POST", f"/history/{action}", {})
        elif name == "save_graph":
            status, res = self.call_rest("POST", "/graph/save", args)
        elif name == "get_selection":
            status, res = self.call_rest("GET", "/selection", None)
        elif name == "set_selection":
            body = dict(args)
            body["strict"] = True
            status, res = self.call_rest("PUT", "/selection", body)
        else:
            return self._tool_error("UNKNOWN_TOOL", f"Unknown tool '{name}'.")

        if status >= 400 or not res.get("ok"):
            err = res.get("error") if isinstance(res, dict) else None
            code = (err or {}).get("code", f"HTTP_{status}")
            msg = (err or {}).get("message", json.dumps(res, ensure_ascii=False))
            return self._tool_error(code, msg)

        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(res.get("data"), ensure_ascii=False, indent=2),
                }
            ],
            "isError": False,
        }

    def _read_resource(self, uri: str) -> dict[str, Any]:
        if uri == "pinpoint://graph/summary":
            status, res = self.call_rest("GET", "/graph/summary", None)
            payload = res.get("data") if status < 400 and res.get("ok") else res
        elif uri == "pinpoint://graph":
            status, res = self.call_rest("GET", "/graph", None)
            payload = res.get("data") if status < 400 and res.get("ok") else res
        elif uri == "pinpoint://selection":
            status, res = self.call_rest("GET", "/selection", None)
            payload = res.get("data") if status < 400 and res.get("ok") else res
        elif uri == "pinpoint://openapi":
            status, res = self.call_rest("GET", "/openapi.json", None)
            payload = res
        else:
            raise ValueError(f"Resource not found: {uri}")

        return {
            "contents": [
                {
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": json.dumps(payload, ensure_ascii=False, indent=2),
                }
            ]
        }

    @staticmethod
    def _tool_error(code: str, message: str) -> dict[str, Any]:
        return {
            "content": [{"type": "text", "text": f"[{code}] {message}"}],
            "isError": True,
        }

    @staticmethod
    def _ok_resp(req_id: Any, result: dict[str, Any]) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    @staticmethod
    def _error_resp(req_id: Any, code: int, message: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}
