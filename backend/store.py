from __future__ import annotations

from contextlib import contextmanager
import copy
import json
import math
import queue
import random
import threading
import time
from pathlib import Path
from typing import Any, Iterator

from .models import (
    DEFAULT_CARD_HEIGHT,
    DEFAULT_CARD_WIDTH,
    DEFAULT_COLOR_NEUTRAL,
    DEFAULT_PALETTE,
    DEFAULT_STATE,
    GRID_SIZE,
    MAX_HISTORY_STACK,
    MAX_ZOOM,
    MIN_CARD_WIDTH,
    MIN_ZOOM,
    VALID_ALIGN_TYPES,
    VALID_MINIMAP_POSITIONS,
    ApiError,
    build_capsule_html,
    parse_content,
    render_segments_to_html,
    text_and_capsules_to_html,
)


class GraphStore:
    """Thread-safe PinPoint workspace store mirroring frontend StateManager."""

    def __init__(self, workspace_file: str | Path | None = None, base_dir: str | Path | None = None) -> None:
        self._lock = threading.RLock()
        self._local = threading.local()
        self._subscribers: set[queue.Queue[dict[str, Any]]] = set()
        self._base_dir = Path(base_dir).resolve() if base_dir else Path.cwd().resolve()
        self.workspace_file: Path | None = Path(workspace_file).resolve() if workspace_file else None
        self.has_workspace_file: bool = bool(self.workspace_file and self.workspace_file.exists())
        self._id_counter = 0
        self.revision = 0

        self.state: dict[str, Any] = self._load_initial_state()
        self.selection: dict[str, Any] = {"cardIds": [], "capsulePinId": None, "textSelection": None}
        self.undo_stack: list[str] = [self._snapshot()]
        self.redo_stack: list[str] = []

    @contextmanager
    def client_context(self, client_id: str | None) -> Iterator[None]:
        prev = getattr(self._local, "client_id", None)
        self._local.client_id = client_id
        try:
            yield
        finally:
            self._local.client_id = prev

    # ------------------------------------------------------------------
    # Internal helpers & pub/sub
    # ------------------------------------------------------------------

    def _next_id(self, prefix: str) -> str:
        self._id_counter += 1
        return f"{prefix}-{int(time.time() * 1000)}-{self._id_counter}-{random.randint(100, 999)}"

    def _load_initial_state(self) -> dict[str, Any]:
        if self.workspace_file and self.workspace_file.exists():
            try:
                raw = json.loads(self.workspace_file.read_text(encoding="utf-8"))
                if isinstance(raw, dict) and isinstance(raw.get("cards"), list) and isinstance(raw.get("connections"), list):
                    return self._normalize_state(raw)
            except Exception:
                pass
        return copy.deepcopy(DEFAULT_STATE)

    def _normalize_settings(self, raw_settings: dict[str, Any] | None) -> dict[str, Any]:
        s = raw_settings or {}
        palette = s.get("palette")
        if not isinstance(palette, list) or len(palette) < 2 or len(palette) > 10:
            palette = list(DEFAULT_PALETTE)

        mm_raw = s.get("minimap") if isinstance(s.get("minimap"), dict) else {}
        pos = mm_raw.get("position")
        if pos not in VALID_MINIMAP_POSITIONS:
            pos = "bottom-right"
        size = mm_raw.get("size", 220)
        if not isinstance(size, (int, float)) or isinstance(size, bool):
            size = 220
        size = int(max(140, min(320, size)))

        return {
            "alignMode": bool(s.get("alignMode", False)),
            "gridSnapMode": bool(s.get("gridSnapMode", False)),
            "palette": list(palette),
            "minimap": {
                "enabled": bool(mm_raw.get("enabled", True)),
                "position": pos,
                "size": size,
            },
        }

    def _normalize_viewport(self, raw_vp: dict[str, Any] | None) -> dict[str, Any]:
        vp = raw_vp or {}
        x = float(vp.get("x", 0))
        y = float(vp.get("y", 0))
        zoom = float(vp.get("zoom", 1.0))
        zoom = max(MIN_ZOOM, min(MAX_ZOOM, zoom))
        return {"x": x, "y": y, "zoom": zoom}

    def _normalize_state(self, data: dict[str, Any]) -> dict[str, Any]:
        cards = copy.deepcopy(data.get("cards", []))
        groups = copy.deepcopy(data.get("groups", []))
        raw_conns = copy.deepcopy(data.get("connections", []))
        valid_conns = [c for c in raw_conns if self._validate_connection_dict(c, cards, groups)]
        return {
            "viewport": self._normalize_viewport(data.get("viewport")),
            "settings": self._normalize_settings(data.get("settings")),
            "cards": cards,
            "connections": valid_conns,
            "groups": groups,
        }

    def _snapshot(self) -> str:
        return json.dumps(
            {
                "cards": self.state["cards"],
                "connections": self.state["connections"],
                "groups": self.state.get("groups", []),
            },
            ensure_ascii=False,
        )

    def _commit(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        snap = self._snapshot()
        if not self.undo_stack or self.undo_stack[-1] != snap:
            self.undo_stack.append(snap)
            if len(self.undo_stack) > MAX_HISTORY_STACK:
                self.undo_stack.pop(0)
            self.redo_stack.clear()
        self._publish(event_type, payload)

    def _publish(self, event_type: str, payload: dict[str, Any] | None = None) -> None:
        self.revision += 1
        client_id = getattr(self._local, "client_id", None)
        event = {
            "type": event_type,
            "revision": self.revision,
            "clientId": client_id,
            "timestamp": int(time.time() * 1000),
            "payload": payload or {},
            "state": self.get_graph(),
        }
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except queue.Full:
                pass

    def subscribe(self) -> queue.Queue[dict[str, Any]]:
        q: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=128)
        with self._lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q: queue.Queue[dict[str, Any]]) -> None:
        with self._lock:
            self._subscribers.discard(q)

    def _snap_coord(self, val: float) -> int:
        if self.state.get("settings", {}).get("gridSnapMode"):
            return int(round(val / GRID_SIZE) * GRID_SIZE)
        return int(round(val))

    def _find_owner_id_by_pin(
        self,
        pin_id: str | None,
        cards: list[dict[str, Any]] | None = None,
        groups: list[dict[str, Any]] | None = None,
    ) -> str | None:
        if not pin_id:
            return None
        cards = cards if cards is not None else self.state["cards"]
        groups = groups if groups is not None else self.state.get("groups", [])

        for prefix in ("pin-group-left-", "pin-group-right-", "pin-group-"):
            if pin_id.startswith(prefix):
                gid = pin_id[len(prefix):]
                return gid if any(g["id"] == gid for g in groups) else None

        for prefix in ("pin-head-left-", "pin-head-right-", "pin-head-"):
            if pin_id.startswith(prefix):
                cid = pin_id[len(prefix):]
                return cid if any(c["id"] == cid for c in cards) else None

        for card in cards:
            _, capsules, _ = parse_content(card.get("contentHtml", ""))
            if any(cap["pinId"] == pin_id for cap in capsules):
                return card["id"]
        return None

    def _validate_connection_dict(
        self,
        conn: dict[str, Any],
        cards: list[dict[str, Any]],
        groups: list[dict[str, Any]],
    ) -> bool:
        from_pin = conn.get("fromPinId")
        to_pin = conn.get("toPinId")
        if not from_pin or not to_pin or from_pin == to_pin:
            return False
        o1 = self._find_owner_id_by_pin(from_pin, cards, groups)
        o2 = self._find_owner_id_by_pin(to_pin, cards, groups)
        return bool(o1 and o2 and o1 != o2)

    def _resolve_pin_color(self, pin_id: str) -> str | None:
        if pin_id.startswith("pin-head-"):
            cid = self._find_owner_id_by_pin(pin_id)
            card = next((c for c in self.state["cards"] if c["id"] == cid), None)
            return card.get("headerColor") if card else None
        if pin_id.startswith("pin-group-"):
            gid = self._find_owner_id_by_pin(pin_id)
            group = next((g for g in self.state.get("groups", []) if g["id"] == gid), None)
            return group.get("headerColor") if group else None
        for card in self.state["cards"]:
            _, capsules, _ = parse_content(card.get("contentHtml", ""))
            for cap in capsules:
                if cap["pinId"] == pin_id:
                    return cap.get("color")
        return None

    def _card_to_view(self, card: dict[str, Any]) -> dict[str, Any]:
        plain_text, capsules, _ = parse_content(card.get("contentHtml", ""))
        view = copy.deepcopy(card)
        view["contentText"] = plain_text
        view["capsules"] = capsules
        return view

    def _calc_group_bounds(self, group: dict[str, Any]) -> dict[str, float] | None:
        card_ids = set(group.get("cardIds") or [])
        members = [c for c in self.state["cards"] if c["id"] in card_ids]
        if not members:
            return None
        pad_x = 24
        pad_top = 52
        pad_bottom = 24
        min_x = min(c["x"] for c in members)
        max_x = max(c["x"] + (c.get("width") or DEFAULT_CARD_WIDTH) for c in members)
        min_y = min(c["y"] for c in members)
        max_y = max(c["y"] + DEFAULT_CARD_HEIGHT for c in members)
        return {
            "x": min_x - pad_x,
            "y": min_y - pad_top,
            "width": max(340, (max_x - min_x) + pad_x * 2),
            "height": (max_y - min_y) + pad_top + pad_bottom,
        }

    # ------------------------------------------------------------------
    # Graph / Workspace
    # ------------------------------------------------------------------

    def get_graph(self, include: set[str] | None = None) -> dict[str, Any]:
        with self._lock:
            result: dict[str, Any] = {
                "cards": copy.deepcopy(self.state["cards"]),
                "connections": copy.deepcopy(self.state["connections"]),
                "groups": copy.deepcopy(self.state.get("groups", [])),
            }
            if include is None or "viewport" in include:
                result["viewport"] = copy.deepcopy(self.state["viewport"])
            if include is None or "settings" in include:
                result["settings"] = copy.deepcopy(self.state["settings"])
            return result

    def get_summary(self) -> dict[str, Any]:
        with self._lock:
            cards_summary = []
            for card in self.state["cards"]:
                plain_text, capsules, _ = parse_content(card.get("contentHtml", ""))
                cards_summary.append({
                    "id": card["id"],
                    "title": card.get("title", "未命名节点"),
                    "x": card["x"],
                    "y": card["y"],
                    "width": card.get("width", DEFAULT_CARD_WIDTH),
                    "headerColor": card.get("headerColor"),
                    "contentText": plain_text,
                    "capsules": capsules,
                    "headerPins": {
                        "left": f"pin-head-left-{card['id']}",
                        "right": f"pin-head-right-{card['id']}",
                    },
                })
            groups_summary = []
            for g in self.state.get("groups", []):
                groups_summary.append({
                    "id": g["id"],
                    "title": g.get("title", "节点组"),
                    "cardIds": list(g.get("cardIds", [])),
                    "headerColor": g.get("headerColor"),
                    "pins": {
                        "left": f"pin-group-left-{g['id']}",
                        "right": f"pin-group-right-{g['id']}",
                    },
                })
            return {
                "cardCount": len(cards_summary),
                "connectionCount": len(self.state["connections"]),
                "groupCount": len(groups_summary),
                "cards": cards_summary,
                "connections": copy.deepcopy(self.state["connections"]),
                "groups": groups_summary,
            }

    def replace_graph(self, data: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(data, dict) or not isinstance(data.get("cards"), list) or not isinstance(data.get("connections"), list):
            raise ApiError(400, "INVALID_GRAPH_PAYLOAD", "Graph payload must include 'cards' and 'connections' arrays.")
        with self._lock:
            self.state = self._normalize_state(data)
            self.undo_stack = [self._snapshot()]
            self.redo_stack = []
            self._publish("GRAPH_REPLACED")
            return self.get_graph()

    def sync_from_client(self, data: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(data, dict) or not isinstance(data.get("cards"), list) or not isinstance(data.get("connections"), list):
            raise ApiError(400, "INVALID_GRAPH_PAYLOAD", "Graph payload must include 'cards' and 'connections' arrays.")
        with self._lock:
            prev_snap = self._snapshot()
            prev_vp = copy.deepcopy(self.state["viewport"])
            prev_settings = copy.deepcopy(self.state["settings"])

            next_state = self._normalize_state({
                "viewport": data.get("viewport", self.state["viewport"]),
                "settings": data.get("settings", self.state["settings"]),
                "cards": data["cards"],
                "connections": data["connections"],
                "groups": data.get("groups", []),
            })
            self.state = next_state
            next_snap = self._snapshot()
            if next_snap != prev_snap:
                self._commit("GRAPH_SYNCED")
            elif self.state["viewport"] != prev_vp or self.state["settings"] != prev_settings:
                self._publish("GRAPH_SYNCED")
            return self.get_graph()

    def reset(self) -> dict[str, Any]:
        with self._lock:
            self.state = copy.deepcopy(DEFAULT_STATE)
            self.selection = {"cardIds": [], "capsulePinId": None, "textSelection": None}
            self.undo_stack = [self._snapshot()]
            self.redo_stack = []
            self._publish("STATE_RESET")
            return self.get_graph()

    def save_to_file(self, path_str: str | None = None) -> dict[str, Any]:
        with self._lock:
            target = self.workspace_file
            if path_str:
                candidate = (self._base_dir / path_str).resolve()
                if not candidate.is_relative_to(self._base_dir):
                    raise ApiError(400, "INVALID_SAVE_PATH", "Target path must stay within the workspace directory.")
                target = candidate
            if target is None:
                target = self._base_dir / "graph.pinpoint"

            export_data = {
                "version": 1,
                "timestamp": int(time.time() * 1000),
                "viewport": self.state["viewport"],
                "settings": self.state["settings"],
                "cards": self.state["cards"],
                "connections": self.state["connections"],
                "groups": self.state.get("groups", []),
            }
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(export_data, indent=2, ensure_ascii=False), encoding="utf-8")
            self.workspace_file = target
            self._publish("FILE_SAVED", {"fileName": target.name})
            return {"fileName": target.name, "path": str(target.relative_to(self._base_dir))}

    # ------------------------------------------------------------------
    # Cards
    # ------------------------------------------------------------------

    def list_cards(self, q: str | None = None, group_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            cards = self.state["cards"]
            if group_id:
                group = next((g for g in self.state.get("groups", []) if g["id"] == group_id), None)
                if not group:
                    return []
                member_ids = set(group.get("cardIds", []))
                cards = [c for c in cards if c["id"] in member_ids]

            result = []
            needle = (q or "").strip().lower()
            for card in cards:
                view = self._card_to_view(card)
                if needle:
                    haystack = f"{view.get('title', '')}\n{view.get('contentText', '')}".lower()
                    if needle not in haystack:
                        continue
                result.append(view)
            return result

    def get_card(self, card_id: str) -> dict[str, Any]:
        with self._lock:
            card = next((c for c in self.state["cards"] if c["id"] == card_id), None)
            if not card:
                raise ApiError(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found.")
            view = self._card_to_view(card)
            view["connections"] = [
                copy.deepcopy(conn)
                for conn in self.state["connections"]
                if self._find_owner_id_by_pin(conn["fromPinId"]) == card_id
                or self._find_owner_id_by_pin(conn["toPinId"]) == card_id
            ]
            return view

    def _auto_spawn_position(self) -> tuple[int, int]:
        if not self.state["cards"]:
            return 140, 200
        max_x = max(c["x"] + (c.get("width") or DEFAULT_CARD_WIDTH) for c in self.state["cards"])
        avg_y = sum(c["y"] for c in self.state["cards"]) / len(self.state["cards"])
        return self._snap_coord(max_x + 80), self._snap_coord(avg_y)

    def _build_card_dict(self, payload: dict[str, Any]) -> dict[str, Any]:
        card_id = payload.get("id") or self._next_id("card")
        if any(c["id"] == card_id for c in self.state["cards"]):
            raise ApiError(409, "DUPLICATE_CARD_ID", f"Card ID '{card_id}' already exists.")

        title = (payload.get("title") or "").strip() or "未命名节点"
        width = payload.get("width", DEFAULT_CARD_WIDTH)
        if not isinstance(width, (int, float)) or isinstance(width, bool) or width < MIN_CARD_WIDTH:
            raise ApiError(400, "INVALID_CARD_WIDTH", f"Card width must be >= {MIN_CARD_WIDTH}.")

        if "x" in payload and "y" in payload:
            x = self._snap_coord(float(payload["x"]))
            y = self._snap_coord(float(payload["y"]))
        else:
            auto_x, auto_y = self._auto_spawn_position()
            x = self._snap_coord(float(payload.get("x", auto_x)))
            y = self._snap_coord(float(payload.get("y", auto_y)))

        if "contentHtml" in payload and payload["contentHtml"] is not None:
            content_html = str(payload["contentHtml"])
        elif "contentText" in payload or "capsules" in payload:
            content_html = text_and_capsules_to_html(
                str(payload.get("contentText") or ""),
                payload.get("capsules"),
                gen_pin_fn=lambda: self._next_id("pin"),
            )
        else:
            content_html = ""

        card: dict[str, Any] = {
            "id": card_id,
            "title": title,
            "x": x,
            "y": y,
            "width": int(round(width)),
            "contentHtml": content_html,
        }
        if payload.get("headerColor"):
            card["headerColor"] = payload["headerColor"]
        return card

    def create_card(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            card = self._build_card_dict(payload)
            self.state["cards"].append(card)
            self._commit("CARD_ADDED", {"cardId": card["id"]})
            return self._card_to_view(card)

    def _apply_card_patch(self, card: dict[str, Any], patch: dict[str, Any]) -> None:
        if "title" in patch:
            card["title"] = (str(patch["title"] or "").strip()) or "未命名节点"
        if "x" in patch:
            card["x"] = int(round(float(patch["x"])))
        if "y" in patch:
            card["y"] = int(round(float(patch["y"])))
        if "width" in patch:
            w = patch["width"]
            if not isinstance(w, (int, float)) or isinstance(w, bool) or w < MIN_CARD_WIDTH:
                raise ApiError(400, "INVALID_CARD_WIDTH", f"Card width must be >= {MIN_CARD_WIDTH}.")
            card["width"] = int(round(w))
        if "contentHtml" in patch and patch["contentHtml"] is not None:
            _, old_capsules, _ = parse_content(card.get("contentHtml", ""))
            card["contentHtml"] = str(patch["contentHtml"])
            _, new_capsules, _ = parse_content(card["contentHtml"])
            removed_pins = {c["pinId"] for c in old_capsules} - {c["pinId"] for c in new_capsules}
            if removed_pins:
                self.state["connections"] = [
                    conn for conn in self.state["connections"]
                    if conn["fromPinId"] not in removed_pins and conn["toPinId"] not in removed_pins
                ]
        elif "contentText" in patch and patch["contentText"] is not None:
            _, old_capsules, _ = parse_content(card.get("contentHtml", ""))
            card["contentHtml"] = text_and_capsules_to_html(
                str(patch["contentText"]),
                patch.get("capsules"),
                gen_pin_fn=lambda: self._next_id("pin"),
            )
            _, new_capsules, _ = parse_content(card["contentHtml"])
            removed_pins = {c["pinId"] for c in old_capsules} - {c["pinId"] for c in new_capsules}
            if removed_pins:
                self.state["connections"] = [
                    conn for conn in self.state["connections"]
                    if conn["fromPinId"] not in removed_pins and conn["toPinId"] not in removed_pins
                ]

        if "headerColor" in patch:
            new_color = patch["headerColor"] or None
            if new_color is None:
                card.pop("headerColor", None)
            else:
                card["headerColor"] = new_color

            head_pins = {
                f"pin-head-left-{card['id']}",
                f"pin-head-right-{card['id']}",
                f"pin-head-{card['id']}",
            }
            for conn in self.state["connections"]:
                if conn["fromPinId"] in head_pins:
                    if new_color:
                        conn["color"] = new_color
                    else:
                        other_id = self._find_owner_id_by_pin(conn["toPinId"])
                        other_card = next((c for c in self.state["cards"] if c["id"] == other_id), None)
                        conn["color"] = (other_card or {}).get("headerColor") or DEFAULT_COLOR_NEUTRAL
                elif conn["toPinId"] in head_pins:
                    other_id = self._find_owner_id_by_pin(conn["fromPinId"])
                    other_card = next((c for c in self.state["cards"] if c["id"] == other_id), None)
                    is_from_capsule = conn["fromPinId"].startswith("pin-") and not conn["fromPinId"].startswith("pin-head-")
                    if not is_from_capsule:
                        conn["color"] = (other_card or {}).get("headerColor") or new_color or DEFAULT_COLOR_NEUTRAL

    def update_card(self, card_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            card = next((c for c in self.state["cards"] if c["id"] == card_id), None)
            if not card:
                raise ApiError(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found.")
            self._apply_card_patch(card, patch)
            self._commit("CARD_UPDATED", {"cardId": card_id})
            return self._card_to_view(card)

    def _remove_cards_internal(self, card_ids: list[str]) -> list[str]:
        id_set = set(card_ids)
        existing_ids = {c["id"] for c in self.state["cards"]}
        removed = [cid for cid in card_ids if cid in existing_ids]
        if not removed:
            return []

        # Collect pin owners while deleted cards are still present in self.state["cards"]
        self.state["connections"] = [
            c for c in self.state["connections"]
            if (self._find_owner_id_by_pin(c["fromPinId"]) not in id_set)
            and (self._find_owner_id_by_pin(c["toPinId"]) not in id_set)
        ]

        self.state["cards"] = [c for c in self.state["cards"] if c["id"] not in id_set]
        groups = self.state.get("groups", [])
        if groups:
            for g in groups:
                g["cardIds"] = [cid for cid in g.get("cardIds", []) if cid not in id_set]
            dissolved = [g for g in groups if len(g["cardIds"]) < 2]
            for g in dissolved:
                lp = f"pin-group-left-{g['id']}"
                rp = f"pin-group-right-{g['id']}"
                self.state["connections"] = [
                    c for c in self.state["connections"]
                    if c["fromPinId"] not in (lp, rp) and c["toPinId"] not in (lp, rp)
                ]
            self.state["groups"] = [g for g in groups if len(g["cardIds"]) >= 2]

        return removed

    def delete_card(self, card_id: str) -> dict[str, Any]:
        with self._lock:
            removed = self._remove_cards_internal([card_id])
            if not removed:
                raise ApiError(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found.")
            self._commit("CARD_REMOVED", {"cardIds": removed})
            return {"deletedIds": removed}

    def batch_cards(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            backup = json.loads(self._snapshot())
            created: list[dict[str, Any]] = []
            updated: list[dict[str, Any]] = []
            deleted: list[str] = []

            try:
                for item in payload.get("create") or []:
                    card = self._build_card_dict(item)
                    self.state["cards"].append(card)
                    created.append(self._card_to_view(card))

                for item in payload.get("update") or []:
                    cid = item.get("id")
                    card = next((c for c in self.state["cards"] if c["id"] == cid), None)
                    if not card:
                        raise ApiError(404, "CARD_NOT_FOUND", f"Card '{cid}' not found.")
                    self._apply_card_patch(card, item)
                    updated.append(self._card_to_view(card))

                del_ids = payload.get("deleteIds") or []
                if del_ids:
                    deleted = self._remove_cards_internal(list(del_ids))
            except Exception:
                self.state["cards"] = backup["cards"]
                self.state["connections"] = backup["connections"]
                self.state["groups"] = backup["groups"]
                raise

            self._commit("CARDS_BATCH_MUTATED", {
                "createdCount": len(created),
                "updatedCount": len(updated),
                "deletedCount": len(deleted),
            })
            return {"created": created, "updated": updated, "deletedIds": deleted}

    def clone_card(self, card_id: str, offset_x: float = 32, offset_y: float = 32) -> dict[str, Any]:
        with self._lock:
            src = next((c for c in self.state["cards"] if c["id"] == card_id), None)
            if not src:
                raise ApiError(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found.")

            new_card = copy.deepcopy(src)
            new_card["id"] = self._next_id("card")
            new_card["x"] = self._snap_coord(src["x"] + offset_x)
            new_card["y"] = self._snap_coord(src["y"] + offset_y)

            _, _, segments = parse_content(src.get("contentHtml", ""))
            for seg in segments:
                if seg["type"] == "capsule":
                    seg["pinId"] = self._next_id("pin")
            new_card["contentHtml"] = render_segments_to_html(segments)

            self.state["cards"].append(new_card)
            self._commit("CARD_ADDED", {"cardId": new_card["id"]})
            return self._card_to_view(new_card)

    # ------------------------------------------------------------------
    # Capsules
    # ------------------------------------------------------------------

    def list_capsules(self, card_id: str) -> list[dict[str, Any]]:
        with self._lock:
            card = next((c for c in self.state["cards"] if c["id"] == card_id), None)
            if not card:
                raise ApiError(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found.")
            _, capsules, _ = parse_content(card.get("contentHtml", ""))
            return capsules

    def create_capsule(self, card_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            card = next((c for c in self.state["cards"] if c["id"] == card_id), None)
            if not card:
                raise ApiError(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found.")

            color = payload.get("color", "#30d158")
            pin_id = self._next_id("pin")
            append = bool(payload.get("append", False))
            match_text = payload.get("matchText")
            text_to_append = (payload.get("text") or "").strip()

            if append or not match_text:
                if not text_to_append:
                    raise ApiError(400, "INVALID_CAPSULE_TEXT", "Provide 'matchText' or non-empty 'text' with append=true.")
                existing_html = card.get("contentHtml", "")
                spacer = " " if existing_html and not existing_html.endswith((" ", ">")) else ""
                card["contentHtml"] = existing_html + spacer + build_capsule_html(pin_id, text_to_append, color)
                cap_text = text_to_append
            else:
                occurrence = int(payload.get("occurrence", 1))
                if occurrence < 1:
                    raise ApiError(400, "INVALID_OCCURRENCE", "'occurrence' must be >= 1.")
                _, _, segments = parse_content(card.get("contentHtml", ""))
                seen = 0
                replaced = False
                new_segments: list[dict[str, Any]] = []
                for seg in segments:
                    if not replaced and seg["type"] == "text":
                        txt = seg["text"]
                        start = 0
                        while True:
                            pos = txt.find(match_text, start)
                            if pos < 0:
                                break
                            seen += 1
                            if seen == occurrence:
                                before = txt[:pos]
                                after = txt[pos + len(match_text):]
                                if before:
                                    new_segments.append({"type": "text", "text": before})
                                new_segments.append({
                                    "type": "capsule",
                                    "pinId": pin_id,
                                    "text": match_text,
                                    "color": color,
                                })
                                if after:
                                    new_segments.append({"type": "text", "text": after})
                                replaced = True
                                break
                            start = pos + len(match_text)
                        if not replaced:
                            new_segments.append(seg)
                    else:
                        new_segments.append(seg)

                if not replaced:
                    raise ApiError(
                        400,
                        "CAPSULE_MATCH_NOT_FOUND",
                        f"Text '{match_text}' (occurrence {occurrence}) not found in plain content of card '{card_id}'.",
                    )
                card["contentHtml"] = render_segments_to_html(new_segments)
                cap_text = match_text

            self._commit("CARD_UPDATED", {"cardId": card_id, "pinId": pin_id})
            return {"pinId": pin_id, "cardId": card_id, "text": cap_text, "color": color}

    def update_capsule(self, pin_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            for card in self.state["cards"]:
                _, _, segments = parse_content(card.get("contentHtml", ""))
                target = next((s for s in segments if s["type"] == "capsule" and s["pinId"] == pin_id), None)
                if not target:
                    continue

                if "color" in payload:
                    new_color = payload["color"] or None
                    target["color"] = new_color
                    wire_color = new_color or DEFAULT_COLOR_NEUTRAL
                    for conn in self.state["connections"]:
                        if conn["fromPinId"] == pin_id or conn["toPinId"] == pin_id:
                            conn["color"] = wire_color

                if "text" in payload and payload["text"] is not None:
                    new_text = str(payload["text"]).strip()
                    if not new_text:
                        raise ApiError(400, "INVALID_CAPSULE_TEXT", "Capsule text cannot be empty.")
                    target["text"] = new_text

                card["contentHtml"] = render_segments_to_html(segments)
                self._commit("CARD_UPDATED", {"cardId": card["id"], "pinId": pin_id})
                return {
                    "pinId": pin_id,
                    "cardId": card["id"],
                    "text": target["text"],
                    "color": target.get("color"),
                }
            raise ApiError(404, "CAPSULE_NOT_FOUND", f"Capsule '{pin_id}' not found.")

    def delete_capsule(self, pin_id: str) -> dict[str, Any]:
        with self._lock:
            for card in self.state["cards"]:
                _, _, segments = parse_content(card.get("contentHtml", ""))
                found = False
                new_segments: list[dict[str, Any]] = []
                for seg in segments:
                    if seg["type"] == "capsule" and seg["pinId"] == pin_id:
                        found = True
                        new_segments.append({"type": "text", "text": seg["text"]})
                    else:
                        new_segments.append(seg)
                if not found:
                    continue

                card["contentHtml"] = render_segments_to_html(new_segments)
                self.state["connections"] = [
                    c for c in self.state["connections"]
                    if c["fromPinId"] != pin_id and c["toPinId"] != pin_id
                ]
                self._commit("CARD_UPDATED", {"cardId": card["id"], "deletedPinId": pin_id})
                return {"deletedPinId": pin_id, "cardId": card["id"]}
            raise ApiError(404, "CAPSULE_NOT_FOUND", f"Capsule '{pin_id}' not found.")

    # ------------------------------------------------------------------
    # Connections
    # ------------------------------------------------------------------

    def list_connections(
        self,
        card_id: str | None = None,
        group_id: str | None = None,
        pin_id: str | None = None,
    ) -> list[dict[str, Any]]:
        with self._lock:
            result = []
            for conn in self.state["connections"]:
                if pin_id and conn["fromPinId"] != pin_id and conn["toPinId"] != pin_id:
                    continue
                if card_id:
                    o1 = self._find_owner_id_by_pin(conn["fromPinId"])
                    o2 = self._find_owner_id_by_pin(conn["toPinId"])
                    if o1 != card_id and o2 != card_id:
                        continue
                if group_id:
                    o1 = self._find_owner_id_by_pin(conn["fromPinId"])
                    o2 = self._find_owner_id_by_pin(conn["toPinId"])
                    if o1 != group_id and o2 != group_id:
                        continue
                result.append(copy.deepcopy(conn))
            return result

    def _resolve_endpoint_pin(
        self,
        pin_id: str | None,
        card_id: str | None,
        side: str,
        capsule_text: str | None,
        group_id: str | None,
        role: str,
    ) -> str:
        if pin_id:
            return pin_id
        if group_id:
            if not any(g["id"] == group_id for g in self.state.get("groups", [])):
                raise ApiError(404, "GROUP_NOT_FOUND", f"Group '{group_id}' not found.")
            return f"pin-group-{'left' if side == 'left' else 'right'}-{group_id}"
        if card_id:
            card = next((c for c in self.state["cards"] if c["id"] == card_id), None)
            if not card:
                raise ApiError(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found.")
            if capsule_text:
                _, capsules, _ = parse_content(card.get("contentHtml", ""))
                cap = next((c for c in capsules if c["text"] == capsule_text), None)
                if not cap:
                    raise ApiError(404, "CAPSULE_NOT_FOUND", f"Capsule '{capsule_text}' not found on card '{card_id}'.")
                return cap["pinId"]
            return f"pin-head-{'left' if side == 'left' else 'right'}-{card_id}"
        raise ApiError(400, "MISSING_ENDPOINT", f"Missing {role} endpoint (provide pinId, cardId, or groupId).")

    def create_connection(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            from_pin = self._resolve_endpoint_pin(
                payload.get("fromPinId"),
                payload.get("fromCardId"),
                payload.get("fromSide", "right"),
                payload.get("fromCapsuleText"),
                payload.get("fromGroupId"),
                "source",
            )
            to_pin = self._resolve_endpoint_pin(
                payload.get("toPinId"),
                payload.get("toCardId"),
                payload.get("toSide", "left"),
                payload.get("toCapsuleText"),
                payload.get("toGroupId"),
                "target",
            )

            if from_pin == to_pin:
                raise ApiError(400, "SELF_PIN_CONNECTION", "Source and target pin cannot be the same.")

            owner1 = self._find_owner_id_by_pin(from_pin)
            owner2 = self._find_owner_id_by_pin(to_pin)
            if not owner1:
                raise ApiError(404, "PIN_NOT_FOUND", f"Source pin '{from_pin}' does not belong to any card or group.")
            if not owner2:
                raise ApiError(404, "PIN_NOT_FOUND", f"Target pin '{to_pin}' does not belong to any card or group.")
            if owner1 == owner2:
                raise ApiError(400, "SELF_CONNECTION_NOT_ALLOWED", "Cannot connect two pins within the same card or group.")

            duplicate = any(
                (c["fromPinId"] == from_pin and c["toPinId"] == to_pin)
                or (c["fromPinId"] == to_pin and c["toPinId"] == from_pin)
                for c in self.state["connections"]
            )
            if duplicate:
                raise ApiError(409, "DUPLICATE_CONNECTION", f"Connection between '{from_pin}' and '{to_pin}' already exists.")

            color = payload.get("color")
            if not color:
                color = self._resolve_pin_color(from_pin) or self._resolve_pin_color(to_pin) or DEFAULT_COLOR_NEUTRAL

            conn = {
                "id": self._next_id("conn"),
                "fromPinId": from_pin,
                "toPinId": to_pin,
                "color": color,
            }
            self.state["connections"].append(conn)
            self._commit("CONNECTION_ADDED", {"connId": conn["id"]})
            return copy.deepcopy(conn)

    def update_connection(self, conn_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            conn = next((c for c in self.state["connections"] if c["id"] == conn_id), None)
            if not conn:
                raise ApiError(404, "CONNECTION_NOT_FOUND", f"Connection '{conn_id}' not found.")

            if "toPinId" in payload and payload["toPinId"]:
                new_to = payload["toPinId"]
                o1 = self._find_owner_id_by_pin(conn["fromPinId"])
                o2 = self._find_owner_id_by_pin(new_to)
                if not o2:
                    raise ApiError(404, "PIN_NOT_FOUND", f"Target pin '{new_to}' not found.")
                if o1 == o2:
                    raise ApiError(400, "SELF_CONNECTION_NOT_ALLOWED", "Cannot reconnect inside the same card or group.")
                dup = any(
                    c["id"] != conn_id
                    and (
                        (c["fromPinId"] == conn["fromPinId"] and c["toPinId"] == new_to)
                        or (c["fromPinId"] == new_to and c["toPinId"] == conn["fromPinId"])
                    )
                    for c in self.state["connections"]
                )
                if dup:
                    raise ApiError(409, "DUPLICATE_CONNECTION", f"Connection between '{conn['fromPinId']}' and '{new_to}' already exists.")
                conn["toPinId"] = new_to

            if "color" in payload:
                conn["color"] = payload["color"] or DEFAULT_COLOR_NEUTRAL

            self._commit("CONNECTION_RECONNECTED", {"connId": conn_id})
            return copy.deepcopy(conn)

    def delete_connection(self, conn_id: str) -> dict[str, Any]:
        with self._lock:
            before = len(self.state["connections"])
            self.state["connections"] = [c for c in self.state["connections"] if c["id"] != conn_id]
            if len(self.state["connections"]) == before:
                raise ApiError(404, "CONNECTION_NOT_FOUND", f"Connection '{conn_id}' not found.")
            self._commit("CONNECTION_REMOVED", {"connId": conn_id})
            return {"deletedId": conn_id}

    # ------------------------------------------------------------------
    # Groups
    # ------------------------------------------------------------------

    def list_groups(self) -> list[dict[str, Any]]:
        with self._lock:
            out = []
            for g in self.state.get("groups", []):
                item = copy.deepcopy(g)
                item["bounds"] = self._calc_group_bounds(g)
                out.append(item)
            return out

    def create_group(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            card_ids = payload.get("cardIds")
            if not isinstance(card_ids, list):
                raise ApiError(400, "INVALID_GROUP_CARDS", "'cardIds' must be an array of card IDs.")
            unique_ids = list(dict.fromkeys(card_ids))
            existing = {c["id"] for c in self.state["cards"]}
            missing = [cid for cid in unique_ids if cid not in existing]
            if missing:
                raise ApiError(404, "CARD_NOT_FOUND", f"Cards not found: {', '.join(missing)}")
            if len(unique_ids) < 2:
                raise ApiError(400, "GROUP_TOO_SMALL", "A group must contain at least 2 distinct cards.")

            groups = self.state.setdefault("groups", [])
            group = {
                "id": self._next_id("group"),
                "title": (payload.get("title") or "").strip() or f"组 {len(groups) + 1}",
                "cardIds": unique_ids,
                "headerColor": payload.get("headerColor", "#0a84ff"),
            }
            groups.append(group)
            self._commit("GROUP_ADDED", {"groupId": group["id"]})
            item = copy.deepcopy(group)
            item["bounds"] = self._calc_group_bounds(group)
            return item

    def update_group(self, group_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            group = next((g for g in self.state.get("groups", []) if g["id"] == group_id), None)
            if not group:
                raise ApiError(404, "GROUP_NOT_FOUND", f"Group '{group_id}' not found.")

            if "title" in payload:
                group["title"] = (str(payload["title"] or "").strip()) or "节点组"

            if "headerColor" in payload:
                new_color = payload["headerColor"] or None
                group["headerColor"] = new_color
                group_pins = {f"pin-group-left-{group_id}", f"pin-group-right-{group_id}"}
                for conn in self.state["connections"]:
                    if conn["fromPinId"] in group_pins:
                        conn["color"] = new_color or DEFAULT_COLOR_NEUTRAL
                    elif conn["toPinId"] in group_pins:
                        other_id = self._find_owner_id_by_pin(conn["fromPinId"])
                        other_card = next((c for c in self.state["cards"] if c["id"] == other_id), None)
                        if not (other_card or {}).get("headerColor"):
                            conn["color"] = new_color or DEFAULT_COLOR_NEUTRAL

            dx = payload.get("deltaX")
            dy = payload.get("deltaY")
            if dx is not None or dy is not None:
                dx_val = float(dx or 0)
                dy_val = float(dy or 0)
                member_ids = set(group["cardIds"])
                for card in self.state["cards"]:
                    if card["id"] in member_ids:
                        card["x"] = int(round(card["x"] + dx_val))
                        card["y"] = int(round(card["y"] + dy_val))

            self._commit("GROUP_UPDATED", {"groupId": group_id})
            item = copy.deepcopy(group)
            item["bounds"] = self._calc_group_bounds(group)
            return item

    def add_card_to_group(self, group_id: str, card_id: str) -> dict[str, Any]:
        with self._lock:
            group = next((g for g in self.state.get("groups", []) if g["id"] == group_id), None)
            if not group:
                raise ApiError(404, "GROUP_NOT_FOUND", f"Group '{group_id}' not found.")
            if not any(c["id"] == card_id for c in self.state["cards"]):
                raise ApiError(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found.")
            if card_id not in group["cardIds"]:
                group["cardIds"].append(card_id)
                self._commit("GROUP_UPDATED", {"groupId": group_id})
            item = copy.deepcopy(group)
            item["bounds"] = self._calc_group_bounds(group)
            return item

    def remove_card_from_group(self, group_id: str, card_id: str) -> dict[str, Any]:
        with self._lock:
            group = next((g for g in self.state.get("groups", []) if g["id"] == group_id), None)
            if not group:
                raise ApiError(404, "GROUP_NOT_FOUND", f"Group '{group_id}' not found.")
            if card_id not in group["cardIds"]:
                raise ApiError(404, "CARD_NOT_IN_GROUP", f"Card '{card_id}' is not in group '{group_id}'.")

            group["cardIds"] = [cid for cid in group["cardIds"] if cid != card_id]
            if len(group["cardIds"]) < 2:
                self._remove_group_internal(group_id)
                self._commit("GROUP_REMOVED", {"groupId": group_id})
                return {"dissolved": True, "groupId": group_id}
            self._commit("GROUP_UPDATED", {"groupId": group_id})
            item = copy.deepcopy(group)
            item["bounds"] = self._calc_group_bounds(group)
            return item

    def _remove_group_internal(self, group_id: str) -> bool:
        groups = self.state.get("groups", [])
        before = len(groups)
        self.state["groups"] = [g for g in groups if g["id"] != group_id]
        if len(self.state["groups"]) == before:
            return False
        lp = f"pin-group-left-{group_id}"
        rp = f"pin-group-right-{group_id}"
        self.state["connections"] = [
            c for c in self.state["connections"]
            if c["fromPinId"] not in (lp, rp) and c["toPinId"] not in (lp, rp)
        ]
        return True

    def delete_group(self, group_id: str) -> dict[str, Any]:
        with self._lock:
            if not self._remove_group_internal(group_id):
                raise ApiError(404, "GROUP_NOT_FOUND", f"Group '{group_id}' not found.")
            self._commit("GROUP_REMOVED", {"groupId": group_id})
            return {"deletedId": group_id}

    # ------------------------------------------------------------------
    # Layout & Alignment
    # ------------------------------------------------------------------

    def align_cards(self, card_ids: list[str], align_type: str) -> list[dict[str, Any]]:
        if align_type not in VALID_ALIGN_TYPES:
            raise ApiError(400, "INVALID_ALIGN_TYPE", f"Unsupported align type '{align_type}'.")
        if not isinstance(card_ids, list) or len(card_ids) < 2:
            raise ApiError(400, "INSUFFICIENT_CARDS", "At least 2 cards are required for alignment.")

        with self._lock:
            id_set = set(card_ids)
            cards = [c for c in self.state["cards"] if c["id"] in id_set]
            if len(cards) < 2:
                raise ApiError(400, "INSUFFICIENT_CARDS", "At least 2 existing cards are required.")
            if align_type in ("distribute-h", "distribute-v") and len(cards) < 3:
                raise ApiError(400, "INSUFFICIENT_CARDS", "At least 3 cards are required for distribution.")

            def w(c: dict[str, Any]) -> int:
                return int(c.get("width") or DEFAULT_CARD_WIDTH)

            def h(_c: dict[str, Any]) -> int:
                return DEFAULT_CARD_HEIGHT

            min_x = min(c["x"] for c in cards)
            max_x = max(c["x"] + w(c) for c in cards)
            min_y = min(c["y"] for c in cards)
            max_y = max(c["y"] + h(c) for c in cards)

            if align_type == "left":
                for c in cards:
                    c["x"] = min_x
            elif align_type == "center-h":
                cx = (min_x + max_x) / 2
                for c in cards:
                    c["x"] = int(round(cx - w(c) / 2))
            elif align_type == "right":
                for c in cards:
                    c["x"] = int(round(max_x - w(c)))
            elif align_type == "top":
                for c in cards:
                    c["y"] = min_y
            elif align_type == "center-v":
                cy = (min_y + max_y) / 2
                for c in cards:
                    c["y"] = int(round(cy - h(c) / 2))
            elif align_type == "bottom":
                for c in cards:
                    c["y"] = int(round(max_y - h(c)))
            elif align_type == "distribute-h":
                cards.sort(key=lambda c: c["x"])
                total_w = sum(w(c) for c in cards)
                span = (cards[-1]["x"] + w(cards[-1])) - cards[0]["x"]
                gap = (span - total_w) / (len(cards) - 1)
                cur_x = float(cards[0]["x"])
                for idx, c in enumerate(cards):
                    if 0 < idx < len(cards) - 1:
                        c["x"] = int(round(cur_x))
                    cur_x += w(c) + gap
            elif align_type == "distribute-v":
                cards.sort(key=lambda c: c["y"])
                total_h = sum(h(c) for c in cards)
                span = (cards[-1]["y"] + h(cards[-1])) - cards[0]["y"]
                gap = (span - total_h) / (len(cards) - 1)
                cur_y = float(cards[0]["y"])
                for idx, c in enumerate(cards):
                    if 0 < idx < len(cards) - 1:
                        c["y"] = int(round(cur_y))
                    cur_y += h(c) + gap

            self._commit("CARDS_ALIGNED", {"type": align_type, "cardIds": [c["id"] for c in cards]})
            return [self._card_to_view(c) for c in cards]

    def auto_layout(
        self,
        strategy: str = "layered",
        card_ids: list[str] | None = None,
        spacing_x: float = 96,
        spacing_y: float = 64,
    ) -> list[dict[str, Any]]:
        if strategy not in ("layered", "grid"):
            raise ApiError(400, "INVALID_LAYOUT_STRATEGY", f"Unsupported strategy '{strategy}'.")

        with self._lock:
            target_set = set(card_ids) if card_ids else {c["id"] for c in self.state["cards"]}
            cards = [c for c in self.state["cards"] if c["id"] in target_set]
            if not cards:
                return []

            start_x, start_y = 140, 180
            if strategy == "grid":
                cols = max(1, math.ceil(math.sqrt(len(cards))))
                col_w = max((c.get("width") or DEFAULT_CARD_WIDTH) for c in cards) + int(spacing_x)
                row_h = DEFAULT_CARD_HEIGHT + int(spacing_y)
                for idx, c in enumerate(cards):
                    r, col = divmod(idx, cols)
                    c["x"] = self._snap_coord(start_x + col * col_w)
                    c["y"] = self._snap_coord(start_y + r * row_h)
            else:
                # Layered topological assignment (left-to-right DAG with cycle breaking)
                adj: dict[str, list[str]] = {c["id"]: [] for c in cards}
                indeg: dict[str, int] = {c["id"]: 0 for c in cards}
                for conn in self.state["connections"]:
                    u = self._find_owner_id_by_pin(conn["fromPinId"])
                    v = self._find_owner_id_by_pin(conn["toPinId"])
                    if u in adj and v in adj and u != v and v not in adj[u]:
                        adj[u].append(v)
                        indeg[v] += 1

                layer: dict[str, int] = {}
                roots = [cid for cid, d in indeg.items() if d == 0]
                if not roots:
                    roots = [cards[0]["id"]]
                q = list(roots)
                for r in roots:
                    layer[r] = 0
                while q:
                    cur = q.pop(0)
                    for nxt in adj[cur]:
                        cand = layer[cur] + 1
                        if nxt not in layer or (cand > layer[nxt] and cand < len(cards)):
                            layer[nxt] = cand
                            q.append(nxt)
                for c in cards:
                    layer.setdefault(c["id"], 0)

                buckets: dict[int, list[dict[str, Any]]] = {}
                for c in cards:
                    buckets.setdefault(layer[c["id"]], []).append(c)

                cur_x = start_x
                for l_idx in sorted(buckets.keys()):
                    col_cards = buckets[l_idx]
                    max_col_w = max((c.get("width") or DEFAULT_CARD_WIDTH) for c in col_cards)
                    cur_y = start_y
                    for c in col_cards:
                        c["x"] = self._snap_coord(cur_x)
                        c["y"] = self._snap_coord(cur_y)
                        cur_y += DEFAULT_CARD_HEIGHT + int(spacing_y)
                    cur_x += max_col_w + int(spacing_x)

            self._commit("AUTO_LAYOUT_APPLIED", {"strategy": strategy})
            return [self._card_to_view(c) for c in cards]

    # ------------------------------------------------------------------
    # History
    # ------------------------------------------------------------------

    def get_history(self) -> dict[str, Any]:
        with self._lock:
            return {
                "canUndo": len(self.undo_stack) > 1,
                "canRedo": len(self.redo_stack) > 0,
                "undoDepth": len(self.undo_stack) - 1,
                "redoDepth": len(self.redo_stack),
            }

    def undo(self) -> dict[str, Any]:
        with self._lock:
            if len(self.undo_stack) <= 1:
                return {"undone": False, **self.get_history()}
            current = self.undo_stack.pop()
            self.redo_stack.append(current)
            prev_data = json.loads(self.undo_stack[-1])
            self.state["cards"] = prev_data["cards"]
            self.state["connections"] = prev_data["connections"]
            self.state["groups"] = prev_data.get("groups", [])
            self._publish("STATE_RESTORED", {"action": "undo"})
            return {"undone": True, **self.get_history()}

    def redo(self) -> dict[str, Any]:
        with self._lock:
            if not self.redo_stack:
                return {"redone": False, **self.get_history()}
            nxt = self.redo_stack.pop()
            self.undo_stack.append(nxt)
            next_data = json.loads(nxt)
            self.state["cards"] = next_data["cards"]
            self.state["connections"] = next_data["connections"]
            self.state["groups"] = next_data.get("groups", [])
            self._publish("STATE_RESTORED", {"action": "redo"})
            return {"redone": True, **self.get_history()}

    # ------------------------------------------------------------------
    # Viewport
    # ------------------------------------------------------------------

    def get_viewport(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self.state["viewport"])

    def update_viewport(self, patch: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            vp = self.state["viewport"]
            if "x" in patch:
                vp["x"] = float(patch["x"])
            if "y" in patch:
                vp["y"] = float(patch["y"])
            if "zoom" in patch:
                vp["zoom"] = max(MIN_ZOOM, min(MAX_ZOOM, float(patch["zoom"])))
            self._publish("VIEWPORT_CHANGED", vp)
            return copy.deepcopy(vp)

    def fit_viewport(self, viewport_width: float = 1440, viewport_height: float = 900) -> dict[str, Any]:
        with self._lock:
            cards = self.state["cards"]
            if not cards:
                self.state["viewport"] = {"x": 0.0, "y": 0.0, "zoom": 1.0}
                self._publish("VIEWPORT_CHANGED", self.state["viewport"])
                return copy.deepcopy(self.state["viewport"])

            min_x = min(c["x"] for c in cards)
            min_y = min(c["y"] for c in cards)
            max_x = max(c["x"] + (c.get("width") or DEFAULT_CARD_WIDTH) for c in cards)
            max_y = max(c["y"] + DEFAULT_CARD_HEIGHT for c in cards)

            padding = 120
            content_w = (max_x - min_x) + padding * 2
            content_h = (max_y - min_y) + padding * 2
            zoom = min(max(min(viewport_width / content_w, viewport_height / content_h), MIN_ZOOM), 1.3)
            mid_x = (min_x + max_x) / 2
            mid_y = (min_y + max_y) / 2
            self.state["viewport"] = {
                "zoom": zoom,
                "x": viewport_width / 2 - mid_x * zoom,
                "y": viewport_height / 2 - mid_y * zoom,
            }
            self._publish("VIEWPORT_CHANGED", self.state["viewport"])
            return copy.deepcopy(self.state["viewport"])

    def focus_viewport(
        self,
        card_ids: list[str] | None = None,
        group_id: str | None = None,
        viewport_width: float = 1440,
        viewport_height: float = 900,
    ) -> dict[str, Any]:
        with self._lock:
            target_ids = set(card_ids or [])
            if group_id:
                group = next((g for g in self.state.get("groups", []) if g["id"] == group_id), None)
                if not group:
                    raise ApiError(404, "GROUP_NOT_FOUND", f"Group '{group_id}' not found.")
                target_ids.update(group.get("cardIds", []))

            targets = [c for c in self.state["cards"] if c["id"] in target_ids]
            if not targets:
                raise ApiError(404, "TARGET_NOT_FOUND", "No matching cards found to focus.")

            min_x = min(c["x"] for c in targets)
            min_y = min(c["y"] for c in targets)
            max_x = max(c["x"] + (c.get("width") or DEFAULT_CARD_WIDTH) for c in targets)
            max_y = max(c["y"] + DEFAULT_CARD_HEIGHT for c in targets)
            mid_x = (min_x + max_x) / 2
            mid_y = (min_y + max_y) / 2
            zoom = self.state["viewport"].get("zoom", 1.0)
            self.state["viewport"]["x"] = viewport_width / 2 - mid_x * zoom
            self.state["viewport"]["y"] = viewport_height / 2 - mid_y * zoom
            self._publish("VIEWPORT_CHANGED", self.state["viewport"])
            return copy.deepcopy(self.state["viewport"])

    # ------------------------------------------------------------------
    # Settings
    # ------------------------------------------------------------------

    def get_settings(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self.state["settings"])

    def update_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            settings = self.state["settings"]
            if "alignMode" in patch:
                settings["alignMode"] = bool(patch["alignMode"])
            if "gridSnapMode" in patch:
                settings["gridSnapMode"] = bool(patch["gridSnapMode"])
            if "palette" in patch:
                palette = patch["palette"]
                if not isinstance(palette, list) or not (2 <= len(palette) <= 10):
                    raise ApiError(400, "INVALID_PALETTE", "Palette must contain between 2 and 10 colors.")
                settings["palette"] = list(palette)
            if "minimap" in patch:
                mm_patch = patch["minimap"]
                if not isinstance(mm_patch, dict):
                    raise ApiError(400, "INVALID_MINIMAP_SETTINGS", "'minimap' must be an object.")
                mm = settings["minimap"]
                if "enabled" in mm_patch:
                    mm["enabled"] = bool(mm_patch["enabled"])
                if "position" in mm_patch:
                    pos = mm_patch["position"]
                    if pos not in VALID_MINIMAP_POSITIONS:
                        raise ApiError(400, "INVALID_MINIMAP_POSITION", f"Position must be one of {sorted(VALID_MINIMAP_POSITIONS)}.")
                    mm["position"] = pos
                if "size" in mm_patch:
                    sz = mm_patch["size"]
                    if not isinstance(sz, (int, float)) or isinstance(sz, bool):
                        raise ApiError(400, "INVALID_MINIMAP_SIZE", "Minimap size must be a number.")
                    mm["size"] = int(max(140, min(320, sz)))

            self._publish("SETTINGS_CHANGED", settings)
            return copy.deepcopy(settings)

    def reset_palette(self) -> dict[str, Any]:
        with self._lock:
            self.state["settings"]["palette"] = list(DEFAULT_PALETTE)
            self._publish("SETTINGS_CHANGED", self.state["settings"])
            return copy.deepcopy(self.state["settings"])

    # ------------------------------------------------------------------
    # Transient Selection State (Live UI <-> MCP)
    # ------------------------------------------------------------------

    def _find_capsule_info(self, pin_id: str | None) -> dict[str, Any] | None:
        if not pin_id:
            return None
        for card in self.state["cards"]:
            _, capsules, _ = parse_content(card.get("contentHtml", ""))
            for cap in capsules:
                if cap["pinId"] == pin_id:
                    return {
                        "pinId": cap["pinId"],
                        "cardId": card["id"],
                        "text": cap["text"],
                        "color": cap.get("color"),
                    }
        return None

    def _prune_selection(self) -> None:
        existing_ids = {c["id"] for c in self.state["cards"]}
        seen: set[str] = set()
        pruned_ids: list[str] = []
        for cid in self.selection.get("cardIds", []):
            if cid in existing_ids and cid not in seen:
                seen.add(cid)
                pruned_ids.append(cid)
        self.selection["cardIds"] = pruned_ids

        cap_id = self.selection.get("capsulePinId")
        if cap_id and not self._find_capsule_info(cap_id):
            self.selection["capsulePinId"] = None

        text_sel = self.selection.get("textSelection")
        if text_sel:
            cid = text_sel.get("cardId")
            txt = (text_sel.get("text") or "").strip()
            if not cid or cid not in existing_ids or not txt:
                self.selection["textSelection"] = None

    def get_selection(self) -> dict[str, Any]:
        with self._lock:
            self._prune_selection()
            card_map = {c["id"]: c for c in self.state["cards"]}
            card_ids = list(self.selection["cardIds"])
            selected_cards = [self._card_to_view(card_map[cid]) for cid in card_ids if cid in card_map]
            capsule_info = self._find_capsule_info(self.selection.get("capsulePinId"))
            text_sel = copy.deepcopy(self.selection.get("textSelection"))
            return {
                "cardIds": card_ids,
                "count": len(card_ids),
                "cards": selected_cards,
                "capsulePinId": capsule_info["pinId"] if capsule_info else None,
                "capsule": capsule_info,
                "textSelection": text_sel,
            }

    def update_selection(self, payload: dict[str, Any], strict: bool = False) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            existing_ids = {c["id"] for c in self.state["cards"]}
            next_card_ids = list(self.selection.get("cardIds", []))
            next_capsule_id = self.selection.get("capsulePinId")
            next_text_sel = copy.deepcopy(self.selection.get("textSelection"))

            if "cardIds" in payload or "groupId" in payload:
                raw_ids: list[str] = []
                if "cardIds" in payload:
                    if not isinstance(payload["cardIds"], list):
                        raise ApiError(400, "INVALID_CARD_IDS", "'cardIds' must be an array of strings.")
                    raw_ids.extend(str(cid) for cid in payload["cardIds"])
                if payload.get("groupId"):
                    gid = str(payload["groupId"])
                    grp = next((g for g in self.state.get("groups", []) if g["id"] == gid), None)
                    if not grp:
                        if strict:
                            raise ApiError(404, "GROUP_NOT_FOUND", f"Group '{gid}' not found.")
                    else:
                        raw_ids.extend(grp.get("cardIds", []))

                if strict:
                    missing = [cid for cid in raw_ids if cid not in existing_ids]
                    if missing:
                        raise ApiError(404, "CARD_NOT_FOUND", f"Card '{missing[0]}' not found.")

                seen: set[str] = set()
                next_card_ids = []
                for cid in raw_ids:
                    if cid in existing_ids and cid not in seen:
                        seen.add(cid)
                        next_card_ids.append(cid)

            if "capsulePinId" in payload:
                raw_pin = payload["capsulePinId"]
                if raw_pin is None or raw_pin == "":
                    next_capsule_id = None
                else:
                    pin_str = str(raw_pin)
                    if not self._find_capsule_info(pin_str):
                        if strict:
                            raise ApiError(404, "CAPSULE_NOT_FOUND", f"Capsule '{pin_str}' not found.")
                        next_capsule_id = None
                    else:
                        next_capsule_id = pin_str

            if "textSelection" in payload:
                raw_ts = payload["textSelection"]
                if not raw_ts:
                    next_text_sel = None
                elif isinstance(raw_ts, dict) and raw_ts.get("cardId") in existing_ids and str(raw_ts.get("text") or "").strip():
                    next_text_sel = {
                        "cardId": str(raw_ts["cardId"]),
                        "text": str(raw_ts["text"]).strip(),
                    }
                else:
                    next_text_sel = None

            self.selection = {
                "cardIds": next_card_ids,
                "capsulePinId": next_capsule_id,
                "textSelection": next_text_sel,
            }
            self._publish(
                "SELECTION_CHANGED",
                {
                    "cardIds": list(next_card_ids),
                    "capsulePinId": next_capsule_id,
                    "textSelection": copy.deepcopy(next_text_sel),
                },
            )
            return self.get_selection()
