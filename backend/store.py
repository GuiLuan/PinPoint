from __future__ import annotations

from contextlib import contextmanager
import copy
import html as html_lib
import json
import math
import queue
import random
import re
import threading
import time
from pathlib import Path
from typing import Any, Iterator

from .db import SQLiteDatabase
from .models import (
    DEFAULT_CARD_HEIGHT,
    DEFAULT_CARD_WIDTH,
    DEFAULT_COLOR_NEUTRAL,
    DEFAULT_PALETTE,
    DEFAULT_SAVE_SETTINGS,
    DEFAULT_STATE,
    DEFAULT_SUBCANVAS_HEIGHT,
    DEFAULT_SUBCANVAS_WIDTH,
    DEFAULT_TOAST_SETTINGS,
    GRID_SIZE,
    MAX_HISTORY_STACK,
    MAX_ZOOM,
    MIN_CARD_WIDTH,
    MIN_SUBCANVAS_HEIGHT,
    MIN_ZOOM,
    ROOT_CANVAS_ID,
    ROOT_CANVAS_TITLE,
    VALID_ALIGN_TYPES,
    VALID_LIBRARY_LAYOUTS,
    VALID_LIBRARY_POSITIONS,
    VALID_MINIMAP_POSITIONS,
    VALID_SAVE_MODES,
    VALID_TOAST_POSITIONS,
    ApiError,
    build_capsule_html,
    parse_content,
    render_segments_to_html,
    text_and_capsules_to_html,
)


_CAPSULE_SPAN_RE = re.compile(r"(<span\b[^>]*\btext-capsule\b[^>]*>)", re.IGNORECASE)
_DATA_PIN_RE = re.compile(r'(\bdata-pin-id=)(["\'])([^"\']*)\2', re.IGNORECASE)


class GraphStore:
    """Thread-safe PinPoint workspace store backed by SQLite with hierarchical subcanvases."""

    def __init__(
        self,
        workspace_file: str | Path | None = None,
        base_dir: str | Path | None = None,
        library_file: str | Path | None = None,
        db_path: str | Path | None = None,
    ) -> None:
        self._lock = threading.RLock()
        self._local = threading.local()
        self._subscribers: set[queue.Queue[dict[str, Any]]] = set()
        self._base_dir = Path(base_dir).resolve() if base_dir else Path.cwd().resolve()
        self.workspace_file: Path | None = Path(workspace_file).resolve() if workspace_file else None
        if library_file is not None:
            self.library_file: Path | None = Path(library_file).resolve()
        elif self.workspace_file is not None:
            self.library_file = self.workspace_file.with_name("library.json")
        else:
            self.library_file = None

        resolved_db: str | Path | None = db_path
        if resolved_db is None and self.workspace_file is not None:
            resolved_db = self.workspace_file.with_suffix(".db")
        self.db = SQLiteDatabase(resolved_db)
        self.has_workspace_file: bool = bool(
            (resolved_db is not None and str(resolved_db) != ":memory:")
            or (self.workspace_file and self.workspace_file.exists())
        )
        self._id_counter = 0

        self._canvases: dict[str, dict[str, Any]] = {}
        self.undo_stacks: dict[str, list[str]] = {}
        self.redo_stacks: dict[str, list[str]] = {}

        self.settings: dict[str, Any] = self._bootstrap_settings()
        self._bootstrap_root_canvas()
        self.library: list[dict[str, Any]] = self._bootstrap_library()
        self.revision = self.db.get_revision()
        self.selection: dict[str, Any] = {
            "canvasId": ROOT_CANVAS_ID,
            "cardIds": [],
            "capsulePinId": None,
            "textSelection": None,
        }
        self.undo_stacks[ROOT_CANVAS_ID] = [self._snapshot(ROOT_CANVAS_ID)]
        self.redo_stacks[ROOT_CANVAS_ID] = []

    def _current_canvas_id(self) -> str:
        return getattr(self._local, "active_canvas_id", None) or ROOT_CANVAS_ID

    @contextmanager
    def _use_canvas(self, canvas_id: str | None) -> Iterator[str]:
        cid = canvas_id or ROOT_CANVAS_ID
        self._get_canvas_state(cid)
        prev = getattr(self._local, "active_canvas_id", None)
        self._local.active_canvas_id = cid
        try:
            yield cid
        finally:
            self._local.active_canvas_id = prev

    @property
    def state(self) -> dict[str, Any]:
        cid = self._current_canvas_id()
        return self._get_canvas_state(cid)

    @state.setter
    def state(self, value: dict[str, Any]) -> None:
        cid = self._current_canvas_id()
        self._canvases[cid] = value

    @property
    def undo_stack(self) -> list[str]:
        cid = self._current_canvas_id()
        return self.undo_stacks.setdefault(cid, [self._snapshot(cid)])

    @undo_stack.setter
    def undo_stack(self, value: list[str]) -> None:
        cid = self._current_canvas_id()
        self.undo_stacks[cid] = value

    @property
    def redo_stack(self) -> list[str]:
        cid = self._current_canvas_id()
        return self.redo_stacks.setdefault(cid, [])

    @redo_stack.setter
    def redo_stack(self, value: list[str]) -> None:
        cid = self._current_canvas_id()
        self.redo_stacks[cid] = value

    def close(self) -> None:
        with self._lock:
            self.db.close()

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

    def _bootstrap_settings(self) -> dict[str, Any]:
        stored = self.db.load_settings()
        if stored is not None:
            return self._normalize_settings(stored)
        if self.workspace_file and self.workspace_file.exists():
            try:
                raw = json.loads(self.workspace_file.read_text(encoding="utf-8"))
                if isinstance(raw, dict) and isinstance(raw.get("settings"), dict):
                    norm = self._normalize_settings(raw["settings"])
                    self.db.save_settings(norm)
                    return norm
            except Exception:
                pass
        norm = self._normalize_settings(DEFAULT_STATE.get("settings"))
        self.db.save_settings(norm)
        return norm

    def _bootstrap_root_canvas(self) -> dict[str, Any]:
        loaded = self.db.load_canvas_data(ROOT_CANVAS_ID)
        if loaded is not None:
            norm = self._normalize_state({
                "viewport": loaded["viewport"],
                "settings": self.settings,
                "cards": loaded["cards"],
                "connections": loaded["connections"],
                "groups": loaded["groups"],
            })
            self._canvases[ROOT_CANVAS_ID] = norm
            self.has_workspace_file = True
            self.db.prune_orphan_canvases()
            return norm

        if self.workspace_file and self.workspace_file.exists():
            try:
                raw = json.loads(self.workspace_file.read_text(encoding="utf-8"))
                if isinstance(raw, dict) and isinstance(raw.get("cards"), list) and isinstance(raw.get("connections"), list):
                    norm = self._normalize_state(raw)
                    self.db.save_canvas_data(ROOT_CANVAS_ID, norm, parent_canvas_id=None, title=raw.get("title") or ROOT_CANVAS_TITLE)
                    self._import_subcanvases_dict(ROOT_CANVAS_ID, raw.get("subcanvases"))
                    self._canvases[ROOT_CANVAS_ID] = norm
                    self.has_workspace_file = True
                    return norm
            except Exception:
                pass

        norm = self._normalize_state(copy.deepcopy(DEFAULT_STATE))
        self.db.save_canvas_data(ROOT_CANVAS_ID, norm, parent_canvas_id=None, title=ROOT_CANVAS_TITLE)
        self._canvases[ROOT_CANVAS_ID] = norm
        return norm

    def _bootstrap_library(self) -> list[dict[str, Any]]:
        db_items = self.db.load_library()
        if db_items:
            return db_items
        if self.library_file and self.library_file.exists():
            try:
                raw = json.loads(self.library_file.read_text(encoding="utf-8"))
                raw_items = raw.get("items") if isinstance(raw, dict) else raw
                if isinstance(raw_items, list):
                    items: list[dict[str, Any]] = []
                    for entry in raw_items:
                        try:
                            items.append(self._normalize_library_item(entry, preserve_id=True))
                        except ApiError:
                            continue
                    if items:
                        self.db.save_library(items)
                    return items
            except Exception:
                pass
        return []

    def _persist_library(self) -> None:
        self.db.save_library(self.library)

    def _publish_library(self, sub_type: str, payload: dict[str, Any] | None = None) -> None:
        self.revision += 1
        self.db.set_revision(self.revision)
        self._persist_library()
        client_id = getattr(self._local, "client_id", None)
        event = {
            "type": "LIBRARY_CHANGED",
            "subType": sub_type,
            "revision": self.revision,
            "clientId": client_id,
            "timestamp": int(time.time() * 1000),
            "payload": payload or {},
            "library": copy.deepcopy(self.library),
        }
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except queue.Full:
                pass

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

        lib_raw = s.get("library") if isinstance(s.get("library"), dict) else {}
        lib_pos = lib_raw.get("position")
        if lib_pos not in VALID_LIBRARY_POSITIONS:
            lib_pos = "left"
        lib_layout = lib_raw.get("layout")
        if lib_layout not in VALID_LIBRARY_LAYOUTS:
            lib_layout = "grid"
        lib_width = lib_raw.get("width", 348)
        if not isinstance(lib_width, (int, float)) or isinstance(lib_width, bool):
            lib_width = 348
        lib_width = int(max(260, min(800, lib_width)))

        save_raw = s.get("save") if isinstance(s.get("save"), dict) else {}
        save_mode = save_raw.get("mode", DEFAULT_SAVE_SETTINGS["mode"])
        if save_mode not in VALID_SAVE_MODES:
            save_mode = DEFAULT_SAVE_SETTINGS["mode"]
        interval_sec = save_raw.get("intervalSec", DEFAULT_SAVE_SETTINGS["intervalSec"])
        if not isinstance(interval_sec, (int, float)) or isinstance(interval_sec, bool):
            interval_sec = DEFAULT_SAVE_SETTINGS["intervalSec"]
        interval_sec = int(max(1, min(300, interval_sec)))

        toast_raw = s.get("toast") if isinstance(s.get("toast"), dict) else {}
        toast_pos = toast_raw.get("position", DEFAULT_TOAST_SETTINGS["position"])
        if toast_pos not in VALID_TOAST_POSITIONS:
            toast_pos = DEFAULT_TOAST_SETTINGS["position"]
        toast_dur = toast_raw.get("durationSec", DEFAULT_TOAST_SETTINGS["durationSec"])
        if not isinstance(toast_dur, (int, float)) or isinstance(toast_dur, bool):
            toast_dur = DEFAULT_TOAST_SETTINGS["durationSec"]
        toast_dur = int(max(2, min(30, toast_dur)))

        return {
            "alignMode": bool(s.get("alignMode", False)),
            "gridSnapMode": bool(s.get("gridSnapMode", False)),
            "palette": list(palette),
            "minimap": {
                "enabled": bool(mm_raw.get("enabled", True)),
                "position": pos,
                "size": size,
            },
            "library": {
                "position": lib_pos,
                "layout": lib_layout,
                "width": lib_width,
            },
            "save": {
                "mode": save_mode,
                "intervalSec": interval_sec,
            },
            "toast": {
                "position": toast_pos,
                "durationSec": toast_dur,
            },
        }

    def _normalize_viewport(self, raw_vp: dict[str, Any] | None) -> dict[str, Any]:
        vp = raw_vp or {}
        x = float(vp.get("x", 0))
        y = float(vp.get("y", 0))
        zoom = float(vp.get("zoom", 1.0))
        zoom = max(MIN_ZOOM, min(MAX_ZOOM, zoom))
        return {"x": x, "y": y, "zoom": zoom}

    def _normalize_card_dict(self, raw: dict[str, Any]) -> dict[str, Any]:
        card = copy.deepcopy(raw)
        kind = card.get("kind") or "card"
        if kind == "subcanvas":
            card["kind"] = "subcanvas"
            card["title"] = (str(card.get("title") or "").strip()) or "子画布"
            w = card.get("width", DEFAULT_SUBCANVAS_WIDTH)
            h = card.get("height", DEFAULT_SUBCANVAS_HEIGHT)
            card["width"] = int(max(MIN_CARD_WIDTH, round(float(w))))
            card["height"] = int(max(MIN_SUBCANVAS_HEIGHT, round(float(h))))
            card["contentHtml"] = ""
            if not card.get("subcanvasId"):
                card["subcanvasId"] = self._next_id("canvas")
            card.pop("thumbnail", None)
        else:
            card.pop("kind", None)
            card.pop("subcanvasId", None)
            card.pop("thumbnail", None)
            card["title"] = (str(card.get("title") or "").strip()) or "未命名节点"
            w = card.get("width", DEFAULT_CARD_WIDTH)
            card["width"] = int(max(MIN_CARD_WIDTH, round(float(w))))
            card["contentHtml"] = str(card.get("contentHtml") or "")
        card["x"] = int(round(float(card.get("x", 0))))
        card["y"] = int(round(float(card.get("y", 0))))
        return card

    def _normalize_state(self, data: dict[str, Any]) -> dict[str, Any]:
        cards = [self._normalize_card_dict(c) for c in (data.get("cards") or []) if isinstance(c, dict) and c.get("id")]
        groups = copy.deepcopy(data.get("groups", []))
        raw_conns = copy.deepcopy(data.get("connections", []))
        valid_conns = [c for c in raw_conns if self._validate_connection_dict(c, cards, groups)]
        norm_settings = self._normalize_settings(data.get("settings") if data.get("settings") is not None else getattr(self, "settings", None))
        return {
            "viewport": self._normalize_viewport(data.get("viewport")),
            "settings": norm_settings,
            "cards": cards,
            "connections": valid_conns,
            "groups": groups,
        }

    def _get_canvas_state(self, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        cid = canvas_id or ROOT_CANVAS_ID
        if cid in self._canvases:
            return self._canvases[cid]
        loaded = self.db.load_canvas_data(cid)
        if loaded is None:
            raise ApiError(404, "CANVAS_NOT_FOUND", f"Canvas '{cid}' not found.")
        norm = self._normalize_state({
            "viewport": loaded["viewport"],
            "settings": self.settings,
            "cards": loaded["cards"],
            "connections": loaded["connections"],
            "groups": loaded["groups"],
        })
        self._canvases[cid] = norm
        self.undo_stacks.setdefault(cid, [self._snapshot(cid)])
        self.redo_stacks.setdefault(cid, [])
        return norm

    def _snapshot(self, canvas_id: str = ROOT_CANVAS_ID) -> str:
        st = self._canvases.get(canvas_id) or self.state
        return json.dumps(
            {
                "cards": st["cards"],
                "connections": st["connections"],
                "groups": st.get("groups", []),
            },
            ensure_ascii=False,
        )

    def _commit(
        self,
        event_type: str,
        payload: dict[str, Any] | None = None,
        canvas_id: str | None = None,
    ) -> None:
        cid = canvas_id or self._current_canvas_id()
        stack = self.undo_stacks.setdefault(cid, [self._snapshot(cid)])
        rstack = self.redo_stacks.setdefault(cid, [])
        snap = self._snapshot(cid)
        if not stack or stack[-1] != snap:
            stack.append(snap)
            if len(stack) > MAX_HISTORY_STACK:
                stack.pop(0)
            rstack.clear()
        self._publish(event_type, payload, canvas_id=cid)

    def _persist_workspace(self, canvas_id: str = ROOT_CANVAS_ID) -> None:
        cid = canvas_id or ROOT_CANVAS_ID
        st = self._get_canvas_state(cid)
        self.db.save_canvas_data(cid, st)
        self.db.save_settings(self.settings)
        self.has_workspace_file = True

    def _publish(
        self,
        event_type: str,
        payload: dict[str, Any] | None = None,
        canvas_id: str | None = None,
    ) -> None:
        cid = canvas_id or self._current_canvas_id()
        self.revision += 1
        self.db.set_revision(self.revision)
        if event_type not in ("FILE_SAVED", "SELECTION_CHANGED"):
            self._persist_workspace(cid)
        client_id = getattr(self._local, "client_id", None)
        event = {
            "type": event_type,
            "canvasId": cid,
            "revision": self.revision,
            "clientId": client_id,
            "timestamp": int(time.time() * 1000),
            "payload": payload or {},
            "state": self.get_graph(canvas_id=cid),
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
        if self.settings.get("gridSnapMode"):
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
        if view.get("kind") == "subcanvas" and view.get("subcanvasId"):
            view["thumbnail"] = self.db.compute_canvas_thumbnail(view["subcanvasId"])
        return view

    def _attach_thumbnails(self, cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = copy.deepcopy(cards)
        for c in out:
            if c.get("kind") == "subcanvas" and c.get("subcanvasId"):
                c["thumbnail"] = self.db.compute_canvas_thumbnail(c["subcanvasId"])
        return out

    def _calc_group_bounds(self, group: dict[str, Any]) -> dict[str, float] | None:
        card_ids = set(group.get("cardIds") or [])
        members = [c for c in self.state["cards"] if c["id"] in card_ids]
        if not members:
            return None
        pad_x = 24
        pad_top = 24
        pad_bottom = 24
        min_width = 288
        min_x = min(c["x"] for c in members)
        max_x = max(c["x"] + (c.get("width") or DEFAULT_CARD_WIDTH) for c in members)
        min_y = min(c["y"] for c in members)
        max_y = max(c["y"] + DEFAULT_CARD_HEIGHT for c in members)
        if self.settings.get("gridSnapMode"):
            x = math.floor((min_x - pad_x) / GRID_SIZE) * GRID_SIZE
            y = math.floor((min_y - pad_top) / GRID_SIZE) * GRID_SIZE
            right = math.ceil((max_x + 16) / GRID_SIZE) * GRID_SIZE
            bottom = math.ceil((max_y + 16) / GRID_SIZE) * GRID_SIZE
            return {
                "x": x,
                "y": y,
                "width": max(min_width, right - x),
                "height": max(GRID_SIZE * 2, bottom - y),
            }
        return {
            "x": min_x - pad_x,
            "y": min_y - pad_top,
            "width": max(min_width, (max_x - min_x) + pad_x * 2),
            "height": (max_y - min_y) + pad_top + pad_bottom,
        }

    # ------------------------------------------------------------------
    # Canvases / Subcanvases / Graph / Workspace
    # ------------------------------------------------------------------

    def list_canvases(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.db.list_canvases()
            by_id = {r["id"]: r for r in rows}
            for r in rows:
                path_items: list[dict[str, str]] = []
                cur_id: str | None = r["id"]
                seen: set[str] = set()
                while cur_id and cur_id in by_id and cur_id not in seen:
                    seen.add(cur_id)
                    node = by_id[cur_id]
                    path_items.append({"id": node["id"], "title": node["title"]})
                    cur_id = node.get("parentCanvasId")
                path_items.reverse()
                r["breadcrumbs"] = path_items
                r["depth"] = max(0, len(path_items) - 1)
            return rows

    def get_canvas(self, canvas_id: str = ROOT_CANVAS_ID, include: set[str] | None = None) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id) as cid:
            meta = self.db.get_canvas_row(cid)
            if meta is None:
                raise ApiError(404, "CANVAS_NOT_FOUND", f"Canvas '{cid}' not found.")
            result: dict[str, Any] = {
                "id": cid,
                "canvasId": cid,
                "parentCanvasId": meta["parentCanvasId"],
                "title": meta["title"],
                "breadcrumbs": self.db.get_breadcrumbs(cid),
                "cards": self._attach_thumbnails(self.state["cards"]),
                "connections": copy.deepcopy(self.state["connections"]),
                "groups": copy.deepcopy(self.state.get("groups", [])),
            }
            if include is None or "viewport" in include:
                result["viewport"] = copy.deepcopy(self.state["viewport"])
            if include is None or "settings" in include:
                result["settings"] = copy.deepcopy(self.settings)
            return result

    def get_canvas_thumbnail(self, canvas_id: str) -> dict[str, Any]:
        with self._lock:
            if not self.db.has_canvas(canvas_id):
                raise ApiError(404, "CANVAS_NOT_FOUND", f"Canvas '{canvas_id}' not found.")
            return self.db.compute_canvas_thumbnail(canvas_id)

    def create_subcanvas(
        self,
        parent_canvas_id: str = ROOT_CANVAS_ID,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = payload if isinstance(payload, dict) else {}
        with self._lock, self._use_canvas(parent_canvas_id) as parent_cid:
            subcanvas_id = str(body.get("subcanvasId") or "").strip() or self._next_id("canvas")
            if self.db.has_canvas(subcanvas_id):
                raise ApiError(409, "DUPLICATE_CANVAS_ID", f"Canvas ID '{subcanvas_id}' already exists.")

            title = (str(body.get("title") or "").strip()) or "未命名子画布"
            width = body.get("width", DEFAULT_SUBCANVAS_WIDTH)
            height = body.get("height", DEFAULT_SUBCANVAS_HEIGHT)
            if not isinstance(width, (int, float)) or isinstance(width, bool) or width < MIN_CARD_WIDTH:
                raise ApiError(400, "INVALID_CARD_WIDTH", f"Subcanvas width must be >= {MIN_CARD_WIDTH}.")
            if not isinstance(height, (int, float)) or isinstance(height, bool) or height < MIN_SUBCANVAS_HEIGHT:
                raise ApiError(400, "INVALID_SUBCANVAS_HEIGHT", f"Subcanvas height must be >= {MIN_SUBCANVAS_HEIGHT}.")

            if "x" in body and "y" in body:
                x = self._snap_coord(float(body["x"]))
                y = self._snap_coord(float(body["y"]))
            else:
                auto_x, auto_y = self._auto_spawn_position()
                x = self._snap_coord(float(body.get("x", auto_x)))
                y = self._snap_coord(float(body.get("y", auto_y)))

            self.db.ensure_canvas(subcanvas_id, parent_canvas_id=parent_cid, title=title)
            sub_state = self._normalize_state({
                "viewport": {"x": 0, "y": 0, "zoom": 1.0},
                "settings": self.settings,
                "cards": [],
                "connections": [],
                "groups": [],
            })

            pack_ids = body.get("cardIds")
            if isinstance(pack_ids, list) and len(pack_ids) > 0:
                pack_set = set(str(cid) for cid in pack_ids)
                moved_cards = [copy.deepcopy(c) for c in self.state["cards"] if c["id"] in pack_set]
                if moved_cards:
                    min_x = min(c["x"] for c in moved_cards)
                    min_y = min(c["y"] for c in moved_cards)
                    for mc in moved_cards:
                        mc["x"] = int(mc["x"] - min_x + 140)
                        mc["y"] = int(mc["y"] - min_y + 180)
                    moved_groups = [
                        copy.deepcopy(g)
                        for g in self.state.get("groups", [])
                        if g.get("cardIds") and all(mid in pack_set for mid in g["cardIds"])
                    ]
                    moved_owners = pack_set | {g["id"] for g in moved_groups}
                    moved_conns = [
                        copy.deepcopy(cn)
                        for cn in self.state["connections"]
                        if self._find_owner_id_by_pin(cn["fromPinId"]) in moved_owners
                        and self._find_owner_id_by_pin(cn["toPinId"]) in moved_owners
                    ]
                    sub_state["cards"] = moved_cards
                    sub_state["groups"] = moved_groups
                    sub_state["connections"] = moved_conns
                    self._remove_cards_internal(list(pack_set), delete_subcanvases=False)
                    self.db.save_canvas_data(parent_cid, self.state)

            self._canvases[subcanvas_id] = sub_state
            self.undo_stacks[subcanvas_id] = [self._snapshot(subcanvas_id)]
            self.redo_stacks[subcanvas_id] = []
            self.db.save_canvas_data(subcanvas_id, sub_state, parent_canvas_id=parent_cid, title=title)

            card_id = body.get("cardId") or self._next_id("card")
            card: dict[str, Any] = {
                "id": card_id,
                "kind": "subcanvas",
                "subcanvasId": subcanvas_id,
                "title": title,
                "x": x,
                "y": y,
                "width": int(round(width)),
                "height": int(round(height)),
                "contentHtml": "",
            }
            if body.get("headerColor"):
                card["headerColor"] = body["headerColor"]

            self.state["cards"].append(card)
            self._commit("CARD_ADDED", {"cardId": card["id"], "subcanvasId": subcanvas_id}, canvas_id=parent_cid)

            return {
                "canvas": self.get_canvas(subcanvas_id),
                "card": self._card_to_view(card),
            }

    def update_canvas(self, canvas_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock, self._use_canvas(canvas_id) as cid:
            meta = self.db.get_canvas_row(cid)
            if meta is None:
                raise ApiError(404, "CANVAS_NOT_FOUND", f"Canvas '{cid}' not found.")

            new_title = None
            if "title" in patch:
                new_title = (str(patch["title"] or "").strip()) or (ROOT_CANVAS_TITLE if cid == ROOT_CANVAS_ID else "子画布")
                self.db.update_canvas_meta(cid, title=new_title)
                parent_cid = meta.get("parentCanvasId")
                if parent_cid and parent_cid in self._canvases:
                    for c in self._canvases[parent_cid]["cards"]:
                        if c.get("kind") == "subcanvas" and c.get("subcanvasId") == cid:
                            c["title"] = new_title

            if "viewport" in patch and isinstance(patch["viewport"], dict):
                self.state["viewport"] = self._normalize_viewport({**self.state["viewport"], **patch["viewport"]})
                self.db.update_canvas_meta(cid, viewport=self.state["viewport"])

            self._publish("CANVAS_UPDATED", {"canvasId": cid, "title": new_title or meta["title"]}, canvas_id=cid)
            return self.get_canvas(cid)

    def delete_canvas(self, canvas_id: str) -> dict[str, Any]:
        if canvas_id == ROOT_CANVAS_ID:
            raise ApiError(400, "CANNOT_DELETE_ROOT_CANVAS", "Root canvas cannot be deleted.")
        with self._lock:
            meta = self.db.get_canvas_row(canvas_id)
            if meta is None:
                raise ApiError(404, "CANVAS_NOT_FOUND", f"Canvas '{canvas_id}' not found.")
            parent_cid = meta.get("parentCanvasId")
            deleted_ids = self.db.delete_canvas_subtree(canvas_id)
            for did in deleted_ids:
                self._canvases.pop(did, None)
                self.undo_stacks.pop(did, None)
                self.redo_stacks.pop(did, None)

            if parent_cid and self.db.has_canvas(parent_cid):
                with self._use_canvas(parent_cid):
                    orphan_card_ids = [
                        c["id"] for c in self.state["cards"]
                        if c.get("kind") == "subcanvas" and c.get("subcanvasId") == canvas_id
                    ]
                    if orphan_card_ids:
                        self._remove_cards_internal(orphan_card_ids, delete_subcanvases=False)
                        self._commit("CARD_REMOVED", {"cardIds": orphan_card_ids}, canvas_id=parent_cid)

            return {"deletedCanvasIds": deleted_ids}

    def export_canvas(self, canvas_id: str = ROOT_CANVAS_ID, include_subcanvases: bool = True) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id) as cid:
            meta = self.db.get_canvas_row(cid)
            if meta is None:
                raise ApiError(404, "CANVAS_NOT_FOUND", f"Canvas '{cid}' not found.")

            export_data: dict[str, Any] = {
                "version": 1,
                "timestamp": int(time.time() * 1000),
                "canvasId": cid,
                "title": meta["title"],
                "viewport": copy.deepcopy(self.state["viewport"]),
                "settings": copy.deepcopy(self.settings),
                "cards": copy.deepcopy(self.state["cards"]),
                "connections": copy.deepcopy(self.state["connections"]),
                "groups": copy.deepcopy(self.state.get("groups", [])),
            }
            for c in export_data["cards"]:
                c.pop("thumbnail", None)

            if include_subcanvases:
                descendant_ids = self.db.get_descendant_canvas_ids(cid)
                if descendant_ids:
                    sub_map: dict[str, Any] = {}
                    for did in descendant_ids:
                        d_data = self.db.load_canvas_data(did)
                        if d_data is None:
                            continue
                        d_cards = copy.deepcopy(d_data["cards"])
                        for dc in d_cards:
                            dc.pop("thumbnail", None)
                        sub_map[did] = {
                            "id": d_data["id"],
                            "parentCanvasId": d_data["parentCanvasId"],
                            "title": d_data["title"],
                            "viewport": d_data["viewport"],
                            "cards": d_cards,
                            "connections": d_data["connections"],
                            "groups": d_data["groups"],
                        }
                    if sub_map:
                        export_data["subcanvases"] = sub_map
            return export_data

    def _import_subcanvases_dict(self, root_parent_id: str, subcanvases: Any) -> None:
        if not isinstance(subcanvases, dict):
            return
        pending = dict(subcanvases)
        queue_ids = list(self.db.get_subcanvas_ids_on_canvas(root_parent_id))
        seen: set[str] = set()
        while queue_ids:
            sid = queue_ids.pop(0)
            if sid in seen:
                continue
            seen.add(sid)
            raw_sub = pending.get(sid)
            if not isinstance(raw_sub, dict):
                continue
            parent_id = raw_sub.get("parentCanvasId")
            if not parent_id or not self.db.has_canvas(parent_id):
                parent_id = root_parent_id
            norm_sub = self._normalize_state(raw_sub)
            title = (str(raw_sub.get("title") or "").strip()) or "子画布"
            self.db.save_canvas_data(sid, norm_sub, parent_canvas_id=parent_id, title=title)
            self._canvases[sid] = norm_sub
            self.undo_stacks[sid] = [self._snapshot(sid)]
            self.redo_stacks[sid] = []
            for next_sid in self.db.get_subcanvas_ids_on_canvas(sid):
                if next_sid not in seen:
                    queue_ids.append(next_sid)

    def import_canvas(self, canvas_id: str, data: dict[str, Any]) -> dict[str, Any]:
        return self.replace_graph(data, canvas_id=canvas_id)

    def get_graph(self, include: set[str] | None = None, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id) as cid:
            result: dict[str, Any] = {
                "cards": self._attach_thumbnails(self.state["cards"]),
                "connections": copy.deepcopy(self.state["connections"]),
                "groups": copy.deepcopy(self.state.get("groups", [])),
            }
            if include is None or "viewport" in include:
                result["viewport"] = copy.deepcopy(self.state["viewport"])
            if include is None or "settings" in include:
                result["settings"] = copy.deepcopy(self.settings)
            if include and "meta" in include:
                meta = self.db.get_canvas_row(cid)
                result["canvasId"] = cid
                result["title"] = meta["title"] if meta else ROOT_CANVAS_TITLE
                result["breadcrumbs"] = self.db.get_breadcrumbs(cid)
            return result

    def get_summary(self, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id) as cid:
            cards_summary = []
            for card in self.state["cards"]:
                plain_text, capsules, _ = parse_content(card.get("contentHtml", ""))
                entry: dict[str, Any] = {
                    "id": card["id"],
                    "kind": card.get("kind", "card"),
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
                }
                if card.get("kind") == "subcanvas" and card.get("subcanvasId"):
                    entry["subcanvasId"] = card["subcanvasId"]
                    entry["thumbnail"] = self.db.compute_canvas_thumbnail(card["subcanvasId"])
                cards_summary.append(entry)
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
                "canvasId": cid,
                "cardCount": len(cards_summary),
                "connectionCount": len(self.state["connections"]),
                "groupCount": len(groups_summary),
                "cards": cards_summary,
                "connections": copy.deepcopy(self.state["connections"]),
                "groups": groups_summary,
            }

    def replace_graph(self, data: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(data, dict) or not isinstance(data.get("cards"), list) or not isinstance(data.get("connections"), list):
            raise ApiError(400, "INVALID_GRAPH_PAYLOAD", "Graph payload must include 'cards' and 'connections' arrays.")
        with self._lock, self._use_canvas(canvas_id) as cid:
            for old_desc in self.db.get_descendant_canvas_ids(cid):
                self.db.delete_canvas_subtree(old_desc)
                self._canvases.pop(old_desc, None)
                self.undo_stacks.pop(old_desc, None)
                self.redo_stacks.pop(old_desc, None)

            if "settings" in data and isinstance(data["settings"], dict):
                self.settings = self._normalize_settings(data["settings"])
                self.db.save_settings(self.settings)

            self.state = self._normalize_state(data)
            if "title" in data:
                self.db.update_canvas_meta(
                    cid,
                    title=str(data.get("title") or "").strip() or (ROOT_CANVAS_TITLE if cid == ROOT_CANVAS_ID else "子画布"),
                )
            self.db.save_canvas_data(cid, self.state)
            self._import_subcanvases_dict(cid, data.get("subcanvases"))
            self.undo_stack = [self._snapshot(cid)]
            self.redo_stack = []
            self._publish("GRAPH_REPLACED", canvas_id=cid)
            return self.get_graph(canvas_id=cid)

    def sync_from_client(self, data: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(data, dict) or not isinstance(data.get("cards"), list) or not isinstance(data.get("connections"), list):
            raise ApiError(400, "INVALID_GRAPH_PAYLOAD", "Graph payload must include 'cards' and 'connections' arrays.")
        target_cid = canvas_id or ROOT_CANVAS_ID
        with self._lock:
            if target_cid != ROOT_CANVAS_ID and not self.db.has_canvas(target_cid):
                parent_cid = data.get("parentCanvasId") or ROOT_CANVAS_ID
                if not self.db.has_canvas(parent_cid):
                    parent_cid = ROOT_CANVAS_ID
                if target_cid not in self.db.get_subcanvas_ids_on_canvas(parent_cid):
                    return {"id": target_cid, "skippedOrphan": True}
                self.db.ensure_canvas(
                    target_cid,
                    parent_canvas_id=parent_cid,
                    title=str(data.get("title") or "").strip() or "子画布",
                    viewport=self._normalize_viewport(data.get("viewport")),
                )
            with self._use_canvas(target_cid) as cid:
                if "title" in data:
                    self.db.update_canvas_meta(
                        cid,
                        title=str(data.get("title") or "").strip() or (ROOT_CANVAS_TITLE if cid == ROOT_CANVAS_ID else "子画布"),
                    )
                prev_snap = self._snapshot(cid)
                prev_vp = copy.deepcopy(self.state["viewport"])
                prev_settings = copy.deepcopy(self.settings)

                old_sub_ids = {
                    c.get("subcanvasId")
                    for c in self.state["cards"]
                    if c.get("kind") == "subcanvas" and c.get("subcanvasId")
                }

                if "settings" in data and isinstance(data["settings"], dict):
                    self.settings = self._normalize_settings(data["settings"])
                    self.db.save_settings(self.settings)

                next_state = self._normalize_state({
                    "viewport": data.get("viewport", self.state["viewport"]),
                    "settings": self.settings,
                    "cards": data["cards"],
                    "connections": data["connections"],
                    "groups": data.get("groups", []),
                })
                self.state = next_state

                new_sub_ids = {
                    c.get("subcanvasId")
                    for c in next_state["cards"]
                    if c.get("kind") == "subcanvas" and c.get("subcanvasId")
                }
                removed_subs = old_sub_ids - new_sub_ids
                for rsid in removed_subs:
                    if rsid and rsid != ROOT_CANVAS_ID and self.db.has_canvas(rsid):
                        deleted = self.db.delete_canvas_subtree(rsid)
                        for did in deleted:
                            self._canvases.pop(did, None)
                            self.undo_stacks.pop(did, None)
                            self.redo_stacks.pop(did, None)

                next_snap = self._snapshot(cid)
                if next_snap != prev_snap:
                    self._commit("GRAPH_SYNCED", canvas_id=cid)
                elif self.state["viewport"] != prev_vp or self.settings != prev_settings:
                    self._publish("GRAPH_SYNCED", canvas_id=cid)
                else:
                    self._persist_workspace(cid)
                pruned_orphans = self.db.prune_orphan_canvases()
                for did in pruned_orphans:
                    self._canvases.pop(did, None)
                    self.undo_stacks.pop(did, None)
                    self.redo_stacks.pop(did, None)
                return self.get_graph(canvas_id=cid)

    def reset(self, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id) as cid:
            for desc_id in self.db.get_descendant_canvas_ids(cid):
                self.db.delete_canvas_subtree(desc_id)
                self._canvases.pop(desc_id, None)
                self.undo_stacks.pop(desc_id, None)
                self.redo_stacks.pop(desc_id, None)

            if cid == ROOT_CANVAS_ID:
                self.settings = self._normalize_settings(DEFAULT_STATE["settings"])
                self.db.save_settings(self.settings)
                self.state = self._normalize_state(copy.deepcopy(DEFAULT_STATE))
            else:
                self.state = self._normalize_state({
                    "viewport": {"x": 0, "y": 0, "zoom": 1.0},
                    "settings": self.settings,
                    "cards": [],
                    "connections": [],
                    "groups": [],
                })
            self.selection = {"canvasId": cid, "cardIds": [], "capsulePinId": None, "textSelection": None}
            self.undo_stack = [self._snapshot(cid)]
            self.redo_stack = []
            self._publish("STATE_RESET", canvas_id=cid)
            return self.get_graph(canvas_id=cid)

    def save_to_file(self, path_str: str | None = None, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock:
            target = self.workspace_file
            if path_str:
                candidate = (self._base_dir / path_str).resolve()
                if not candidate.is_relative_to(self._base_dir):
                    raise ApiError(400, "INVALID_SAVE_PATH", "Target path must stay within the workspace directory.")
                target = candidate
            if target is None:
                target = self._base_dir / "graph.pinpoint"

            export_data = self.export_canvas(canvas_id=canvas_id, include_subcanvases=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(export_data, indent=2, ensure_ascii=False), encoding="utf-8")
            self.workspace_file = target
            self.has_workspace_file = True
            self._publish("FILE_SAVED", {"fileName": target.name}, canvas_id=canvas_id)
            rel = str(target.relative_to(self._base_dir)) if target.is_relative_to(self._base_dir) else str(target)
            return {"fileName": target.name, "path": rel}

    # ------------------------------------------------------------------
    # Cards
    # ------------------------------------------------------------------

    def list_cards(self, q: str | None = None, group_id: str | None = None, canvas_id: str = ROOT_CANVAS_ID) -> list[dict[str, Any]]:
        with self._lock, self._use_canvas(canvas_id):
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

    def get_card(self, card_id: str, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
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

        kind = payload.get("kind") or "card"
        title = (payload.get("title") or "").strip() or ("未命名子画布" if kind == "subcanvas" else "未命名节点")
        width = payload.get("width", DEFAULT_SUBCANVAS_WIDTH if kind == "subcanvas" else DEFAULT_CARD_WIDTH)
        if not isinstance(width, (int, float)) or isinstance(width, bool) or width < MIN_CARD_WIDTH:
            raise ApiError(400, "INVALID_CARD_WIDTH", f"Card width must be >= {MIN_CARD_WIDTH}.")

        if "x" in payload and "y" in payload:
            x = self._snap_coord(float(payload["x"]))
            y = self._snap_coord(float(payload["y"]))
        else:
            auto_x, auto_y = self._auto_spawn_position()
            x = self._snap_coord(float(payload.get("x", auto_x)))
            y = self._snap_coord(float(payload.get("y", auto_y)))

        if kind == "subcanvas":
            height = payload.get("height", DEFAULT_SUBCANVAS_HEIGHT)
            if not isinstance(height, (int, float)) or isinstance(height, bool) or height < MIN_SUBCANVAS_HEIGHT:
                raise ApiError(400, "INVALID_SUBCANVAS_HEIGHT", f"Subcanvas height must be >= {MIN_SUBCANVAS_HEIGHT}.")
            subcanvas_id = str(payload.get("subcanvasId") or "").strip() or self._next_id("canvas")
            self.db.ensure_canvas(subcanvas_id, parent_canvas_id=self._current_canvas_id(), title=title)
            card: dict[str, Any] = {
                "id": card_id,
                "kind": "subcanvas",
                "subcanvasId": subcanvas_id,
                "title": title,
                "x": x,
                "y": y,
                "width": int(round(width)),
                "height": int(round(height)),
                "contentHtml": "",
            }
            if payload.get("headerColor"):
                card["headerColor"] = payload["headerColor"]
            return card

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

        card = {
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

    def create_card(self, payload: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock, self._use_canvas(canvas_id):
            card = self._build_card_dict(payload)
            self.state["cards"].append(card)
            self._commit("CARD_ADDED", {"cardId": card["id"]})
            return self._card_to_view(card)

    def _apply_card_patch(self, card: dict[str, Any], patch: dict[str, Any]) -> None:
        if "title" in patch:
            default_t = "子画布" if card.get("kind") == "subcanvas" else "未命名节点"
            card["title"] = (str(patch["title"] or "").strip()) or default_t
            if card.get("kind") == "subcanvas" and card.get("subcanvasId"):
                self.db.update_canvas_meta(card["subcanvasId"], title=card["title"])
        if "x" in patch:
            card["x"] = int(round(float(patch["x"])))
        if "y" in patch:
            card["y"] = int(round(float(patch["y"])))
        if "width" in patch:
            w = patch["width"]
            if not isinstance(w, (int, float)) or isinstance(w, bool) or w < MIN_CARD_WIDTH:
                raise ApiError(400, "INVALID_CARD_WIDTH", f"Card width must be >= {MIN_CARD_WIDTH}.")
            card["width"] = int(round(w))
        if "height" in patch and card.get("kind") == "subcanvas":
            h = patch["height"]
            if not isinstance(h, (int, float)) or isinstance(h, bool) or h < MIN_SUBCANVAS_HEIGHT:
                raise ApiError(400, "INVALID_SUBCANVAS_HEIGHT", f"Subcanvas height must be >= {MIN_SUBCANVAS_HEIGHT}.")
            card["height"] = int(round(h))
        if card.get("kind") != "subcanvas":
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

    def update_card(self, card_id: str, patch: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock, self._use_canvas(canvas_id):
            card = next((c for c in self.state["cards"] if c["id"] == card_id), None)
            if not card:
                raise ApiError(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found.")
            self._apply_card_patch(card, patch)
            self._commit("CARD_UPDATED", {"cardId": card_id})
            return self._card_to_view(card)

    def _remove_cards_internal(self, card_ids: list[str], delete_subcanvases: bool = True) -> list[str]:
        id_set = set(card_ids)
        existing_ids = {c["id"] for c in self.state["cards"]}
        removed = [cid for cid in card_ids if cid in existing_ids]
        if not removed:
            return []

        if delete_subcanvases:
            for c in self.state["cards"]:
                if c["id"] in id_set and c.get("kind") == "subcanvas" and c.get("subcanvasId"):
                    sub_id = c["subcanvasId"]
                    if sub_id != ROOT_CANVAS_ID and self.db.has_canvas(sub_id):
                        deleted = self.db.delete_canvas_subtree(sub_id)
                        for did in deleted:
                            self._canvases.pop(did, None)
                            self.undo_stacks.pop(did, None)
                            self.redo_stacks.pop(did, None)

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

    def delete_card(self, card_id: str, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
            removed = self._remove_cards_internal([card_id])
            if not removed:
                raise ApiError(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found.")
            self._commit("CARD_REMOVED", {"cardIds": removed})
            return {"deletedIds": removed}

    def batch_cards(self, payload: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock, self._use_canvas(canvas_id):
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

    def _clone_canvas_subtree(self, src_canvas_id: str, new_parent_id: str) -> str:
        exported = self.export_canvas(src_canvas_id, include_subcanvases=True)
        new_cid = self._next_id("canvas")
        norm = self._normalize_state(exported)
        self.db.save_canvas_data(new_cid, norm, parent_canvas_id=new_parent_id, title=exported.get("title") or "子画布")
        self._canvases[new_cid] = norm
        self.undo_stacks[new_cid] = [self._snapshot(new_cid)]
        self.redo_stacks[new_cid] = []
        if "subcanvases" in exported:
            self._import_subcanvases_dict(new_cid, exported["subcanvases"])
        return new_cid

    def clone_card(self, card_id: str, offset_x: float = 32, offset_y: float = 32, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id) as cid:
            src = next((c for c in self.state["cards"] if c["id"] == card_id), None)
            if not src:
                raise ApiError(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found.")

            new_card = copy.deepcopy(src)
            new_card["id"] = self._next_id("card")
            new_card["x"] = self._snap_coord(src["x"] + offset_x)
            new_card["y"] = self._snap_coord(src["y"] + offset_y)

            if new_card.get("kind") == "subcanvas" and new_card.get("subcanvasId"):
                new_card["subcanvasId"] = self._clone_canvas_subtree(new_card["subcanvasId"], cid)
            else:
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

    def list_capsules(self, card_id: str, canvas_id: str = ROOT_CANVAS_ID) -> list[dict[str, Any]]:
        with self._lock, self._use_canvas(canvas_id):
            card = next((c for c in self.state["cards"] if c["id"] == card_id), None)
            if not card:
                raise ApiError(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found.")
            _, capsules, _ = parse_content(card.get("contentHtml", ""))
            return capsules

    def create_capsule(self, card_id: str, payload: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock, self._use_canvas(canvas_id):
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

    def update_capsule(self, pin_id: str, payload: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock, self._use_canvas(canvas_id):
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

    def delete_capsule(self, pin_id: str, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
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
        canvas_id: str = ROOT_CANVAS_ID,
    ) -> list[dict[str, Any]]:
        with self._lock, self._use_canvas(canvas_id):
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

    def create_connection(self, payload: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock, self._use_canvas(canvas_id):
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

    def update_connection(self, conn_id: str, payload: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock, self._use_canvas(canvas_id):
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

    def delete_connection(self, conn_id: str, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
            before = len(self.state["connections"])
            self.state["connections"] = [c for c in self.state["connections"] if c["id"] != conn_id]
            if len(self.state["connections"]) == before:
                raise ApiError(404, "CONNECTION_NOT_FOUND", f"Connection '{conn_id}' not found.")
            self._commit("CONNECTION_REMOVED", {"connId": conn_id})
            return {"deletedId": conn_id}

    # ------------------------------------------------------------------
    # Groups
    # ------------------------------------------------------------------

    def list_groups(self, canvas_id: str = ROOT_CANVAS_ID) -> list[dict[str, Any]]:
        with self._lock, self._use_canvas(canvas_id):
            out = []
            for g in self.state.get("groups", []):
                item = copy.deepcopy(g)
                item["bounds"] = self._calc_group_bounds(g)
                out.append(item)
            return out

    def create_group(self, payload: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock, self._use_canvas(canvas_id):
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

    def update_group(self, group_id: str, payload: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock, self._use_canvas(canvas_id):
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

    def add_card_to_group(self, group_id: str, card_id: str, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
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

    def remove_card_from_group(self, group_id: str, card_id: str, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
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

    def delete_group(self, group_id: str, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
            if not self._remove_group_internal(group_id):
                raise ApiError(404, "GROUP_NOT_FOUND", f"Group '{group_id}' not found.")
            self._commit("GROUP_REMOVED", {"groupId": group_id})
            return {"deletedId": group_id}

    # ------------------------------------------------------------------
    # Layout & Alignment
    # ------------------------------------------------------------------

    def align_cards(self, card_ids: list[str], align_type: str, canvas_id: str = ROOT_CANVAS_ID) -> list[dict[str, Any]]:
        if align_type not in VALID_ALIGN_TYPES:
            raise ApiError(400, "INVALID_ALIGN_TYPE", f"Unsupported align type '{align_type}'.")
        if not isinstance(card_ids, list) or len(card_ids) < 2:
            raise ApiError(400, "INSUFFICIENT_CARDS", "At least 2 cards are required for alignment.")

        with self._lock, self._use_canvas(canvas_id):
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
        canvas_id: str = ROOT_CANVAS_ID,
    ) -> list[dict[str, Any]]:
        if strategy not in ("layered", "grid"):
            raise ApiError(400, "INVALID_LAYOUT_STRATEGY", f"Unsupported strategy '{strategy}'.")

        with self._lock, self._use_canvas(canvas_id):
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

    def get_history(self, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
            return {
                "canUndo": len(self.undo_stack) > 1,
                "canRedo": len(self.redo_stack) > 0,
                "undoDepth": len(self.undo_stack) - 1,
                "redoDepth": len(self.redo_stack),
            }

    def undo(self, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
            if len(self.undo_stack) <= 1:
                return {"undone": False, **self.get_history(canvas_id)}
            current = self.undo_stack.pop()
            self.redo_stack.append(current)
            prev_data = json.loads(self.undo_stack[-1])
            self.state["cards"] = prev_data["cards"]
            self.state["connections"] = prev_data["connections"]
            self.state["groups"] = prev_data.get("groups", [])
            self._publish("STATE_RESTORED", {"action": "undo"})
            return {"undone": True, **self.get_history(canvas_id)}

    def redo(self, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
            if not self.redo_stack:
                return {"redone": False, **self.get_history(canvas_id)}
            nxt = self.redo_stack.pop()
            self.undo_stack.append(nxt)
            next_data = json.loads(nxt)
            self.state["cards"] = next_data["cards"]
            self.state["connections"] = next_data["connections"]
            self.state["groups"] = next_data.get("groups", [])
            self._publish("STATE_RESTORED", {"action": "redo"})
            return {"redone": True, **self.get_history(canvas_id)}

    # ------------------------------------------------------------------
    # Viewport
    # ------------------------------------------------------------------

    def get_viewport(self, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
            return copy.deepcopy(self.state["viewport"])

    def update_viewport(self, patch: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock, self._use_canvas(canvas_id):
            vp = self.state["viewport"]
            if "x" in patch:
                vp["x"] = float(patch["x"])
            if "y" in patch:
                vp["y"] = float(patch["y"])
            if "zoom" in patch:
                vp["zoom"] = max(MIN_ZOOM, min(MAX_ZOOM, float(patch["zoom"])))
            self._publish("VIEWPORT_CHANGED", vp)
            return copy.deepcopy(vp)

    def fit_viewport(self, viewport_width: float = 1440, viewport_height: float = 900, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
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
        canvas_id: str = ROOT_CANVAS_ID,
    ) -> dict[str, Any]:
        with self._lock, self._use_canvas(canvas_id):
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
            return copy.deepcopy(self.settings)

    def update_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(patch, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            settings = self.settings
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
            if "library" in patch:
                lib_patch = patch["library"]
                if not isinstance(lib_patch, dict):
                    raise ApiError(400, "INVALID_LIBRARY_SETTINGS", "'library' must be an object.")
                lib = settings.setdefault("library", {"position": "left", "layout": "grid", "width": 348})
                if "position" in lib_patch:
                    lib_pos = lib_patch["position"]
                    if lib_pos not in VALID_LIBRARY_POSITIONS:
                        raise ApiError(400, "INVALID_LIBRARY_POSITION", f"Library position must be one of {sorted(VALID_LIBRARY_POSITIONS)}.")
                    lib["position"] = lib_pos
                if "layout" in lib_patch:
                    lib_layout = lib_patch["layout"]
                    if lib_layout not in VALID_LIBRARY_LAYOUTS:
                        raise ApiError(400, "INVALID_LIBRARY_LAYOUT", f"Library layout must be one of {sorted(VALID_LIBRARY_LAYOUTS)}.")
                    lib["layout"] = lib_layout
                if "width" in lib_patch:
                    lib_w = lib_patch["width"]
                    if not isinstance(lib_w, (int, float)) or isinstance(lib_w, bool):
                        raise ApiError(400, "INVALID_LIBRARY_WIDTH", "Library width must be a number.")
                    lib["width"] = int(max(260, min(800, lib_w)))
            if "save" in patch:
                save_patch = patch["save"]
                if not isinstance(save_patch, dict):
                    raise ApiError(400, "INVALID_SAVE_SETTINGS", "'save' must be an object.")
                sv = settings.setdefault("save", dict(DEFAULT_SAVE_SETTINGS))
                if "mode" in save_patch:
                    m = save_patch["mode"]
                    if m not in VALID_SAVE_MODES:
                        raise ApiError(400, "INVALID_SAVE_MODE", f"Save mode must be one of {sorted(VALID_SAVE_MODES)}.")
                    sv["mode"] = m
                if "intervalSec" in save_patch:
                    iv = save_patch["intervalSec"]
                    if not isinstance(iv, (int, float)) or isinstance(iv, bool):
                        raise ApiError(400, "INVALID_SAVE_INTERVAL", "Save intervalSec must be a number.")
                    sv["intervalSec"] = int(max(1, min(300, iv)))
            if "toast" in patch:
                toast_patch = patch["toast"]
                if not isinstance(toast_patch, dict):
                    raise ApiError(400, "INVALID_TOAST_SETTINGS", "'toast' must be an object.")
                ts = settings.setdefault("toast", dict(DEFAULT_TOAST_SETTINGS))
                if "position" in toast_patch:
                    tp = toast_patch["position"]
                    if tp not in VALID_TOAST_POSITIONS:
                        raise ApiError(400, "INVALID_TOAST_POSITION", f"Toast position must be one of {sorted(VALID_TOAST_POSITIONS)}.")
                    ts["position"] = tp
                if "durationSec" in toast_patch:
                    td = toast_patch["durationSec"]
                    if not isinstance(td, (int, float)) or isinstance(td, bool):
                        raise ApiError(400, "INVALID_TOAST_DURATION", "Toast durationSec must be a number.")
                    ts["durationSec"] = int(max(2, min(30, td)))

            for st in self._canvases.values():
                st["settings"] = self.settings
            self.db.save_settings(self.settings)
            self._publish("SETTINGS_CHANGED", settings)
            return copy.deepcopy(settings)

    def reset_palette(self) -> dict[str, Any]:
        with self._lock:
            self.settings["palette"] = list(DEFAULT_PALETTE)
            for st in self._canvases.values():
                st["settings"] = self.settings
            self.db.save_settings(self.settings)
            self._publish("SETTINGS_CHANGED", self.settings)
            return copy.deepcopy(self.settings)

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

    def get_selection(self, canvas_id: str | None = None) -> dict[str, Any]:
        with self._lock:
            target_cid = canvas_id or self.selection.get("canvasId") or ROOT_CANVAS_ID
            with self._use_canvas(target_cid):
                self._prune_selection()
                card_map = {c["id"]: c for c in self.state["cards"]}
                card_ids = list(self.selection["cardIds"])
                selected_cards = [self._card_to_view(card_map[cid]) for cid in card_ids if cid in card_map]
                capsule_info = self._find_capsule_info(self.selection.get("capsulePinId"))
                text_sel = copy.deepcopy(self.selection.get("textSelection"))
                return {
                    "canvasId": target_cid,
                    "cardIds": card_ids,
                    "count": len(card_ids),
                    "cards": selected_cards,
                    "capsulePinId": capsule_info["pinId"] if capsule_info else None,
                    "capsule": capsule_info,
                    "textSelection": text_sel,
                }

    def update_selection(self, payload: dict[str, Any], strict: bool = False, canvas_id: str | None = None) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            target_cid = str(payload.get("canvasId") or canvas_id or self.selection.get("canvasId") or ROOT_CANVAS_ID)
            with self._use_canvas(target_cid):
                existing_ids = {c["id"] for c in self.state["cards"]}
                next_card_ids = list(self.selection.get("cardIds", [])) if self.selection.get("canvasId") == target_cid else []
                next_capsule_id = self.selection.get("capsulePinId") if self.selection.get("canvasId") == target_cid else None
                next_text_sel = copy.deepcopy(self.selection.get("textSelection")) if self.selection.get("canvasId") == target_cid else None

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
                    "canvasId": target_cid,
                    "cardIds": next_card_ids,
                    "capsulePinId": next_capsule_id,
                    "textSelection": next_text_sel,
                }
                self._publish(
                    "SELECTION_CHANGED",
                    {
                        "canvasId": target_cid,
                        "cardIds": list(next_card_ids),
                        "capsulePinId": next_capsule_id,
                        "textSelection": copy.deepcopy(next_text_sel),
                    },
                    canvas_id=target_cid,
                )
                return self.get_selection(target_cid)

    # ------------------------------------------------------------------
    # Reusable Node Library ("库")
    # ------------------------------------------------------------------

    def _normalize_library_item(self, raw: dict[str, Any], preserve_id: bool = False) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Library item must be a JSON object.")

        raw_cards = raw.get("cards")
        if not isinstance(raw_cards, list) or len(raw_cards) == 0:
            raise ApiError(400, "EMPTY_LIBRARY_ITEM", "Library item must contain at least 1 card.")

        cards: list[dict[str, Any]] = []
        seen_card_ids: set[str] = set()
        for idx, rc in enumerate(raw_cards):
            if not isinstance(rc, dict):
                raise ApiError(400, "INVALID_CARD", "Each card in library item must be an object.")
            cid = str(rc.get("id") or f"lib-card-{idx + 1}")
            if cid in seen_card_ids:
                cid = self._next_id("card")
            seen_card_ids.add(cid)

            width = rc.get("width", DEFAULT_CARD_WIDTH)
            if not isinstance(width, (int, float)) or isinstance(width, bool) or width < MIN_CARD_WIDTH:
                width = DEFAULT_CARD_WIDTH

            card_obj: dict[str, Any] = {
                "id": cid,
                "title": str(rc.get("title") or "").strip() or "未命名节点",
                "x": float(rc.get("x", 0)),
                "y": float(rc.get("y", 0)),
                "width": int(round(width)),
                "contentHtml": str(rc.get("contentHtml") or ""),
            }
            if "headerColor" in rc and rc["headerColor"] is not None:
                card_obj["headerColor"] = str(rc["headerColor"])
            cards.append(card_obj)

        min_x = min(c["x"] for c in cards)
        min_y = min(c["y"] for c in cards)
        for c in cards:
            c["x"] = int(round(c["x"] - min_x))
            c["y"] = int(round(c["y"] - min_y))

        card_id_set = {c["id"] for c in cards}
        groups: list[dict[str, Any]] = []
        seen_group_ids: set[str] = set()
        for idx, rg in enumerate(raw.get("groups") or []):
            if not isinstance(rg, dict):
                continue
            member_ids = [str(mid) for mid in (rg.get("cardIds") or []) if str(mid) in card_id_set]
            member_ids = list(dict.fromkeys(member_ids))
            if len(member_ids) < 2:
                continue
            gid = str(rg.get("id") or f"lib-group-{idx + 1}")
            if gid in seen_group_ids:
                gid = self._next_id("group")
            seen_group_ids.add(gid)
            group_obj: dict[str, Any] = {
                "id": gid,
                "title": str(rg.get("title") or "").strip() or "节点组",
                "cardIds": member_ids,
            }
            if "headerColor" in rg:
                group_obj["headerColor"] = rg["headerColor"]
            groups.append(group_obj)

        connections: list[dict[str, Any]] = []
        seen_conn_ids: set[str] = set()
        for idx, rconn in enumerate(raw.get("connections") or []):
            if not isinstance(rconn, dict):
                continue
            if not self._validate_connection_dict(rconn, cards, groups):
                continue
            conn_id = str(rconn.get("id") or f"lib-conn-{idx + 1}")
            if conn_id in seen_conn_ids:
                conn_id = self._next_id("conn")
            seen_conn_ids.add(conn_id)
            connections.append({
                "id": conn_id,
                "fromPinId": str(rconn["fromPinId"]),
                "toPinId": str(rconn["toPinId"]),
                "color": rconn.get("color"),
            })

        default_name = cards[0]["title"] if len(cards) == 1 else f"{cards[0]['title']} 等 {len(cards)} 个节点"
        name = str(raw.get("name") or "").strip() or default_name
        description = str(raw.get("description") or "").strip()
        now_ms = int(time.time() * 1000)

        item_id = str(raw.get("id") or "").strip() if preserve_id else ""
        if not item_id:
            item_id = self._next_id("lib")

        created_at = raw.get("createdAt")
        if not isinstance(created_at, (int, float)) or isinstance(created_at, bool):
            created_at = now_ms
        updated_at = raw.get("updatedAt")
        if not isinstance(updated_at, (int, float)) or isinstance(updated_at, bool):
            updated_at = now_ms

        return {
            "id": item_id,
            "name": name,
            "description": description,
            "createdAt": int(created_at),
            "updatedAt": int(updated_at),
            "cards": cards,
            "connections": connections,
            "groups": groups,
        }

    def _remap_capsule_html(self, content_html: str, pin_id_map: dict[str, str]) -> str:
        if not content_html:
            return ""

        def _replace_span(match: re.Match[str]) -> str:
            tag = match.group(1)
            m_pin = _DATA_PIN_RE.search(tag)
            new_pin = self._next_id("pin")
            if m_pin:
                old_pin = html_lib.unescape(m_pin.group(3))
                if old_pin:
                    pin_id_map[old_pin] = new_pin
                safe_new = html_lib.escape(new_pin, quote=True)
                return _DATA_PIN_RE.sub(lambda pm: f'{pm.group(1)}{pm.group(2)}{safe_new}{pm.group(2)}', tag, count=1)
            safe_new = html_lib.escape(new_pin, quote=True)
            return tag[:-1] + f' data-pin-id="{safe_new}">'

        return _CAPSULE_SPAN_RE.sub(_replace_span, content_html)

    def list_library(self, q: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            needle = (q or "").strip().lower()
            out: list[dict[str, Any]] = []
            for item in self.library:
                if needle:
                    parts = [item.get("name", ""), item.get("description", "")]
                    for c in item.get("cards", []):
                        plain_text, _, _ = parse_content(c.get("contentHtml", ""))
                        parts.append(c.get("title", ""))
                        parts.append(plain_text)
                    haystack = "\n".join(parts).lower()
                    if needle not in haystack:
                        continue
                out.append(copy.deepcopy(item))
            return out

    def get_library_item(self, item_id: str) -> dict[str, Any]:
        with self._lock:
            item = next((it for it in self.library if it["id"] == item_id), None)
            if not item:
                raise ApiError(404, "LIBRARY_ITEM_NOT_FOUND", f"Library item '{item_id}' not found.")
            return copy.deepcopy(item)

    def create_library_item(self, payload: dict[str, Any], canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock, self._use_canvas(canvas_id):
            if "cards" in payload and payload["cards"] is not None:
                source_payload = copy.deepcopy(payload)
            elif "cardIds" in payload:
                raw_ids = payload.get("cardIds")
                if not isinstance(raw_ids, list) or len(raw_ids) == 0:
                    raise ApiError(400, "INVALID_CARD_IDS", "'cardIds' must be a non-empty array of card IDs.")
                unique_ids = list(dict.fromkeys(str(cid) for cid in raw_ids))
                card_map = {c["id"]: c for c in self.state["cards"]}
                missing = [cid for cid in unique_ids if cid not in card_map]
                if missing:
                    raise ApiError(404, "CARD_NOT_FOUND", f"Cards not found: {', '.join(missing)}")

                selected_set = set(unique_ids)
                selected_cards = [copy.deepcopy(card_map[cid]) for cid in unique_ids]
                selected_groups = [
                    copy.deepcopy(g)
                    for g in self.state.get("groups", [])
                    if g.get("cardIds") and all(mid in selected_set for mid in g["cardIds"])
                ]
                selected_group_ids = {g["id"] for g in selected_groups}
                relevant_owners = selected_set | selected_group_ids
                selected_conns = [
                    copy.deepcopy(conn)
                    for conn in self.state["connections"]
                    if self._find_owner_id_by_pin(conn["fromPinId"]) in relevant_owners
                    and self._find_owner_id_by_pin(conn["toPinId"]) in relevant_owners
                ]
                source_payload = {
                    "name": payload.get("name"),
                    "description": payload.get("description", ""),
                    "cards": selected_cards,
                    "groups": selected_groups,
                    "connections": selected_conns,
                }
            else:
                raise ApiError(400, "MISSING_LIBRARY_SOURCE", "Provide either 'cards' or 'cardIds' to create a library item.")

            item = self._normalize_library_item(source_payload, preserve_id=bool(payload.get("id")))
            if any(existing["id"] == item["id"] for existing in self.library):
                item["id"] = self._next_id("lib")

            self.library.insert(0, item)
            self._publish_library("LIBRARY_ITEM_CREATED", {"itemId": item["id"]})
            return copy.deepcopy(item)

    def update_library_item(self, item_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        with self._lock:
            idx = next((i for i, it in enumerate(self.library) if it["id"] == item_id), None)
            if idx is None:
                raise ApiError(404, "LIBRARY_ITEM_NOT_FOUND", f"Library item '{item_id}' not found.")

            current = self.library[idx]
            if "cards" in payload:
                merged = copy.deepcopy(current)
                merged.update({
                    "id": current["id"],
                    "createdAt": current["createdAt"],
                    "name": payload.get("name", current["name"]),
                    "description": payload.get("description", current.get("description", "")),
                    "cards": payload["cards"],
                    "groups": payload.get("groups", current.get("groups", [])),
                    "connections": payload.get("connections", current.get("connections", [])),
                    "updatedAt": int(time.time() * 1000),
                })
                updated = self._normalize_library_item(merged, preserve_id=True)
                self.library[idx] = updated
            else:
                if "name" in payload:
                    new_name = str(payload["name"] or "").strip()
                    if not new_name:
                        raise ApiError(400, "INVALID_LIBRARY_NAME", "Library item name cannot be empty.")
                    current["name"] = new_name
                if "description" in payload:
                    current["description"] = str(payload["description"] or "").strip()
                current["updatedAt"] = int(time.time() * 1000)

            self._publish_library("LIBRARY_ITEM_UPDATED", {"itemId": item_id})
            return copy.deepcopy(self.library[idx])

    def delete_library_item(self, item_id: str) -> dict[str, Any]:
        with self._lock:
            before = len(self.library)
            self.library = [it for it in self.library if it["id"] != item_id]
            if len(self.library) == before:
                raise ApiError(404, "LIBRARY_ITEM_NOT_FOUND", f"Library item '{item_id}' not found.")
            self._publish_library("LIBRARY_ITEM_DELETED", {"itemId": item_id})
            return {"deletedId": item_id}

    def instantiate_library_item(self, item_id: str, payload: dict[str, Any] | None = None, canvas_id: str = ROOT_CANVAS_ID) -> dict[str, Any]:
        if payload is not None and not isinstance(payload, dict):
            raise ApiError(400, "INVALID_PAYLOAD", "Request body must be a JSON object.")
        b = payload or {}
        with self._lock, self._use_canvas(canvas_id):
            item = next((it for it in self.library if it["id"] == item_id), None)
            if not item:
                raise ApiError(404, "LIBRARY_ITEM_NOT_FOUND", f"Library item '{item_id}' not found.")

            if "x" in b and "y" in b:
                base_x = float(b["x"])
                base_y = float(b["y"])
            else:
                auto_x, auto_y = self._auto_spawn_position()
                base_x = float(b.get("x", auto_x))
                base_y = float(b.get("y", auto_y))

            card_id_map: dict[str, str] = {}
            pin_id_map: dict[str, str] = {}
            new_cards: list[dict[str, Any]] = []
            new_groups: list[dict[str, Any]] = []
            new_connections: list[dict[str, Any]] = []

            for c in item["cards"]:
                new_cid = self._next_id("card")
                card_id_map[c["id"]] = new_cid
                pin_id_map[f"pin-head-left-{c['id']}"] = f"pin-head-left-{new_cid}"
                pin_id_map[f"pin-head-right-{c['id']}"] = f"pin-head-right-{new_cid}"
                pin_id_map[f"pin-head-{c['id']}"] = f"pin-head-left-{new_cid}"

            for g in item.get("groups", []):
                new_gid = self._next_id("group")
                pin_id_map[f"pin-group-left-{g['id']}"] = f"pin-group-left-{new_gid}"
                pin_id_map[f"pin-group-right-{g['id']}"] = f"pin-group-right-{new_gid}"
                pin_id_map[f"pin-group-{g['id']}"] = f"pin-group-left-{new_gid}"
                cloned_g = copy.deepcopy(g)
                cloned_g["id"] = new_gid
                cloned_g["cardIds"] = [card_id_map[mid] for mid in g.get("cardIds", []) if mid in card_id_map]
                if len(cloned_g["cardIds"]) >= 2:
                    new_groups.append(cloned_g)

            for c in item["cards"]:
                cloned_c = copy.deepcopy(c)
                cloned_c["id"] = card_id_map[c["id"]]
                cloned_c["x"] = self._snap_coord(base_x + float(c.get("x", 0)))
                cloned_c["y"] = self._snap_coord(base_y + float(c.get("y", 0)))
                cloned_c["contentHtml"] = self._remap_capsule_html(c.get("contentHtml", ""), pin_id_map)
                new_cards.append(cloned_c)

            for conn in item.get("connections", []):
                remapped_from = pin_id_map.get(conn.get("fromPinId"))
                remapped_to = pin_id_map.get(conn.get("toPinId"))
                if remapped_from and remapped_to:
                    new_connections.append({
                        "id": self._next_id("conn"),
                        "fromPinId": remapped_from,
                        "toPinId": remapped_to,
                        "color": conn.get("color"),
                    })

            self.state["cards"].extend(new_cards)
            self.state.setdefault("groups", []).extend(new_groups)
            self.state["connections"].extend(new_connections)

            self._commit(
                "LIBRARY_INSTANTIATED",
                {"itemId": item_id, "cardIds": [c["id"] for c in new_cards]},
            )
            return {
                "itemId": item_id,
                "cards": [self._card_to_view(c) for c in new_cards],
                "groups": copy.deepcopy(new_groups),
                "connections": copy.deepcopy(new_connections),
            }

