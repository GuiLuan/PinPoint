from __future__ import annotations

import copy
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from .models import (
    DEFAULT_CARD_HEIGHT,
    DEFAULT_CARD_WIDTH,
    DEFAULT_COLOR_NEUTRAL,
    DEFAULT_SUBCANVAS_HEIGHT,
    GRID_SIZE,
    ROOT_CANVAS_ID,
    ROOT_CANVAS_TITLE,
    parse_content,
)


class SQLiteDatabase:
    """SQLite persistence backend for PinPoint hierarchical canvases, settings, and library."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        self.is_memory = db_path is None or str(db_path) == ":memory:"
        if self.is_memory:
            self.db_path: Path | None = None
            self.conn = sqlite3.connect(":memory:", check_same_thread=False)
        else:
            p = Path(db_path).resolve()
            p.parent.mkdir(parents=True, exist_ok=True)
            self.db_path = p
            self.conn = sqlite3.connect(str(p), check_same_thread=False)

        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON;")
        if not self.is_memory:
            # Use DELETE journal mode rather than WAL so SQLite works reliably
            # on Docker bind mounts (Windows/macOS 9P/VirtioFS) without -shm mmap errors.
            try:
                self.conn.execute("PRAGMA journal_mode = DELETE;")
            except sqlite3.OperationalError:
                pass
        self._init_schema()

    def _init_schema(self) -> None:
        with self.conn:
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS canvases (
                    id TEXT PRIMARY KEY,
                    parent_canvas_id TEXT NULL REFERENCES canvases(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    viewport_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS cards (
                    id TEXT NOT NULL,
                    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
                    kind TEXT NOT NULL DEFAULT 'card',
                    subcanvas_id TEXT NULL REFERENCES canvases(id) ON DELETE SET NULL,
                    title TEXT NOT NULL,
                    x INTEGER NOT NULL,
                    y INTEGER NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NULL,
                    header_color TEXT NULL,
                    content_html TEXT NOT NULL DEFAULT '',
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (canvas_id, id)
                );

                CREATE TABLE IF NOT EXISTS groups (
                    id TEXT NOT NULL,
                    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    card_ids_json TEXT NOT NULL,
                    header_color TEXT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (canvas_id, id)
                );

                CREATE TABLE IF NOT EXISTS connections (
                    id TEXT NOT NULL,
                    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
                    from_pin_id TEXT NOT NULL,
                    to_pin_id TEXT NOT NULL,
                    color TEXT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (canvas_id, id)
                );

                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS library_items (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    payload_json TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0
                );

                CREATE INDEX IF NOT EXISTS idx_cards_canvas ON cards(canvas_id, sort_order);
                CREATE INDEX IF NOT EXISTS idx_groups_canvas ON groups(canvas_id, sort_order);
                CREATE INDEX IF NOT EXISTS idx_conns_canvas ON connections(canvas_id, sort_order);
                CREATE INDEX IF NOT EXISTS idx_canvases_parent ON canvases(parent_canvas_id);
                """
            )

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Meta & Settings
    # ------------------------------------------------------------------

    def get_meta(self, key: str, default: str | None = None) -> str | None:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return str(row["value"]) if row is not None else default

    def set_meta(self, key: str, value: str) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO meta (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, str(value)),
            )

    def get_revision(self) -> int:
        raw = self.get_meta("revision", "0")
        try:
            return int(raw or "0")
        except ValueError:
            return 0

    def set_revision(self, revision: int) -> None:
        self.set_meta("revision", str(int(revision)))

    def load_settings(self) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT value_json FROM app_settings WHERE key = 'global'").fetchone()
        if row is None:
            return None
        try:
            parsed = json.loads(row["value_json"])
            return parsed if isinstance(parsed, dict) else None
        except Exception:
            return None

    def save_settings(self, settings: dict[str, Any]) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO app_settings (key, value_json) VALUES ('global', ?) "
                "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                (json.dumps(settings, ensure_ascii=False),),
            )

    # ------------------------------------------------------------------
    # Canvases & Hierarchy
    # ------------------------------------------------------------------

    def has_canvas(self, canvas_id: str) -> bool:
        row = self.conn.execute("SELECT 1 FROM canvases WHERE id = ?", (canvas_id,)).fetchone()
        return row is not None

    def get_canvas_row(self, canvas_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT id, parent_canvas_id, title, viewport_json, created_at, updated_at "
            "FROM canvases WHERE id = ?",
            (canvas_id,),
        ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "parentCanvasId": row["parent_canvas_id"],
            "title": row["title"],
            "viewport": json.loads(row["viewport_json"]),
            "createdAt": int(row["created_at"]),
            "updatedAt": int(row["updated_at"]),
        }

    def list_canvases(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            """
            SELECT
                c.id,
                c.parent_canvas_id,
                c.title,
                c.created_at,
                c.updated_at,
                COALESCE(SUM(CASE WHEN cd.kind = 'subcanvas' THEN 0 WHEN cd.id IS NOT NULL THEN 1 ELSE 0 END), 0) AS card_count,
                COALESCE(SUM(CASE WHEN cd.kind = 'subcanvas' THEN 1 ELSE 0 END), 0) AS subcanvas_count
            FROM canvases c
            LEFT JOIN cards cd ON cd.canvas_id = c.id
            GROUP BY c.id
            ORDER BY c.created_at ASC
            """
        ).fetchall()
        return [
            {
                "id": r["id"],
                "parentCanvasId": r["parent_canvas_id"],
                "title": r["title"],
                "createdAt": int(r["created_at"]),
                "updatedAt": int(r["updated_at"]),
                "cardCount": int(r["card_count"]),
                "subcanvasCount": int(r["subcanvas_count"]),
            }
            for r in rows
        ]

    def get_breadcrumbs(self, canvas_id: str) -> list[dict[str, str]]:
        crumbs: list[dict[str, str]] = []
        visited: set[str] = set()
        cur_id: str | None = canvas_id
        while cur_id and cur_id not in visited:
            visited.add(cur_id)
            row = self.conn.execute(
                "SELECT id, parent_canvas_id, title FROM canvases WHERE id = ?",
                (cur_id,),
            ).fetchone()
            if row is None:
                break
            crumbs.append({"id": row["id"], "title": row["title"]})
            cur_id = row["parent_canvas_id"]
        crumbs.reverse()
        return crumbs

    def get_descendant_canvas_ids(self, canvas_id: str) -> list[str]:
        result: list[str] = []
        queue_ids = [canvas_id]
        seen = {canvas_id}
        while queue_ids:
            cur = queue_ids.pop(0)
            rows = self.conn.execute(
                "SELECT id FROM canvases WHERE parent_canvas_id = ?",
                (cur,),
            ).fetchall()
            for r in rows:
                cid = r["id"]
                if cid not in seen:
                    seen.add(cid)
                    result.append(cid)
                    queue_ids.append(cid)
        return result

    def get_subcanvas_ids_on_canvas(self, canvas_id: str) -> list[str]:
        rows = self.conn.execute(
            "SELECT subcanvas_id FROM cards WHERE canvas_id = ? AND kind = 'subcanvas' AND subcanvas_id IS NOT NULL",
            (canvas_id,),
        ).fetchall()
        return [r["subcanvas_id"] for r in rows if r["subcanvas_id"]]

    def prune_orphan_canvases(self) -> list[str]:
        """Remove non-root canvas rows not reachable from root via any subcanvas card."""
        if not self.has_canvas(ROOT_CANVAS_ID):
            return []
        reachable: set[str] = {ROOT_CANVAS_ID}
        queue_ids: list[str] = [ROOT_CANVAS_ID]
        while queue_ids:
            cur = queue_ids.pop(0)
            for child_id in self.get_subcanvas_ids_on_canvas(cur):
                if child_id not in reachable and self.has_canvas(child_id):
                    reachable.add(child_id)
                    queue_ids.append(child_id)

        all_ids = [r["id"] for r in self.conn.execute("SELECT id FROM canvases").fetchall()]
        orphans = [cid for cid in all_ids if cid not in reachable]
        if orphans:
            with self.conn:
                placeholders = ",".join("?" for _ in orphans)
                self.conn.execute(f"DELETE FROM canvases WHERE id IN ({placeholders})", orphans)
        return orphans

    def ensure_canvas(
        self,
        canvas_id: str,
        parent_canvas_id: str | None = None,
        title: str | None = None,
        viewport: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        existing = self.get_canvas_row(canvas_id)
        if existing is not None:
            return existing
        now_ms = int(time.time() * 1000)
        eff_title = (title or "").strip() or (ROOT_CANVAS_TITLE if canvas_id == ROOT_CANVAS_ID else "子画布")
        eff_vp = viewport or {"x": 0.0, "y": 0.0, "zoom": 1.0}
        with self.conn:
            self.conn.execute(
                "INSERT INTO canvases (id, parent_canvas_id, title, viewport_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (canvas_id, parent_canvas_id, eff_title, json.dumps(eff_vp), now_ms, now_ms),
            )
        return self.get_canvas_row(canvas_id)  # type: ignore[return-value]

    def update_canvas_meta(
        self,
        canvas_id: str,
        title: str | None = None,
        viewport: dict[str, Any] | None = None,
    ) -> None:
        now_ms = int(time.time() * 1000)
        with self.conn:
            if title is not None and viewport is not None:
                self.conn.execute(
                    "UPDATE canvases SET title = ?, viewport_json = ?, updated_at = ? WHERE id = ?",
                    (title, json.dumps(viewport), now_ms, canvas_id),
                )
            elif title is not None:
                self.conn.execute(
                    "UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?",
                    (title, now_ms, canvas_id),
                )
            elif viewport is not None:
                self.conn.execute(
                    "UPDATE canvases SET viewport_json = ?, updated_at = ? WHERE id = ?",
                    (json.dumps(viewport), now_ms, canvas_id),
                )
            if title is not None:
                self.conn.execute(
                    "UPDATE cards SET title = ? WHERE subcanvas_id = ? AND kind = 'subcanvas'",
                    (title, canvas_id),
                )

    def load_canvas_data(self, canvas_id: str) -> dict[str, Any] | None:
        meta = self.get_canvas_row(canvas_id)
        if meta is None:
            return None

        card_rows = self.conn.execute(
            "SELECT id, kind, subcanvas_id, title, x, y, width, height, header_color, content_html "
            "FROM cards WHERE canvas_id = ? ORDER BY sort_order ASC",
            (canvas_id,),
        ).fetchall()

        cards: list[dict[str, Any]] = []
        for r in card_rows:
            c: dict[str, Any] = {
                "id": r["id"],
                "title": r["title"],
                "x": int(r["x"]),
                "y": int(r["y"]),
                "width": int(r["width"]),
                "contentHtml": r["content_html"] or "",
            }
            if r["kind"] and r["kind"] != "card":
                c["kind"] = r["kind"]
            if r["subcanvas_id"]:
                c["subcanvasId"] = r["subcanvas_id"]
            if r["height"] is not None:
                c["height"] = int(r["height"])
            if r["header_color"]:
                c["headerColor"] = r["header_color"]
            cards.append(c)

        group_rows = self.conn.execute(
            "SELECT id, title, card_ids_json, header_color FROM groups WHERE canvas_id = ? ORDER BY sort_order ASC",
            (canvas_id,),
        ).fetchall()
        groups: list[dict[str, Any]] = []
        for r in group_rows:
            g: dict[str, Any] = {
                "id": r["id"],
                "title": r["title"],
                "cardIds": json.loads(r["card_ids_json"]),
            }
            if r["header_color"] is not None:
                g["headerColor"] = r["header_color"]
            groups.append(g)

        conn_rows = self.conn.execute(
            "SELECT id, from_pin_id, to_pin_id, color FROM connections WHERE canvas_id = ? ORDER BY sort_order ASC",
            (canvas_id,),
        ).fetchall()
        connections: list[dict[str, Any]] = []
        for r in conn_rows:
            connections.append(
                {
                    "id": r["id"],
                    "fromPinId": r["from_pin_id"],
                    "toPinId": r["to_pin_id"],
                    "color": r["color"] or DEFAULT_COLOR_NEUTRAL,
                }
            )

        return {
            "id": meta["id"],
            "parentCanvasId": meta["parentCanvasId"],
            "title": meta["title"],
            "viewport": meta["viewport"],
            "cards": cards,
            "connections": connections,
            "groups": groups,
            "createdAt": meta["createdAt"],
            "updatedAt": meta["updatedAt"],
        }

    def save_canvas_data(
        self,
        canvas_id: str,
        data: dict[str, Any],
        parent_canvas_id: str | None = None,
        title: str | None = None,
    ) -> None:
        now_ms = int(time.time() * 1000)
        existing = self.get_canvas_row(canvas_id)
        eff_parent = existing["parentCanvasId"] if existing else parent_canvas_id
        eff_title = (
            (title or "").strip()
            or (existing["title"] if existing else "")
            or (ROOT_CANVAS_TITLE if canvas_id == ROOT_CANVAS_ID else "子画布")
        )
        created_at = existing["createdAt"] if existing else now_ms
        viewport = data.get("viewport") or (existing["viewport"] if existing else {"x": 0.0, "y": 0.0, "zoom": 1.0})
        cards = data.get("cards") or []
        groups = data.get("groups") or []
        connections = data.get("connections") or []

        with self.conn:
            self.conn.execute(
                "INSERT INTO canvases (id, parent_canvas_id, title, viewport_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET title = excluded.title, viewport_json = excluded.viewport_json, updated_at = excluded.updated_at",
                (canvas_id, eff_parent, eff_title, json.dumps(viewport), created_at, now_ms),
            )

            # Ensure child subcanvases referenced by subcanvas cards exist before inserting FK references
            for c in cards:
                if c.get("kind") == "subcanvas" and c.get("subcanvasId"):
                    sub_id = str(c["subcanvasId"])
                    sub_title = (c.get("title") or "").strip() or "子画布"
                    sub_exists = self.conn.execute("SELECT id FROM canvases WHERE id = ?", (sub_id,)).fetchone()
                    if sub_exists is None:
                        self.conn.execute(
                            "INSERT INTO canvases (id, parent_canvas_id, title, viewport_json, created_at, updated_at) "
                            "VALUES (?, ?, ?, ?, ?, ?)",
                            (sub_id, canvas_id, sub_title, json.dumps({"x": 0.0, "y": 0.0, "zoom": 1.0}), now_ms, now_ms),
                        )
                    else:
                        self.conn.execute(
                            "UPDATE canvases SET title = ? WHERE id = ?",
                            (sub_title, sub_id),
                        )

            self.conn.execute("DELETE FROM cards WHERE canvas_id = ?", (canvas_id,))
            self.conn.execute("DELETE FROM groups WHERE canvas_id = ?", (canvas_id,))
            self.conn.execute("DELETE FROM connections WHERE canvas_id = ?", (canvas_id,))

            for idx, c in enumerate(cards):
                kind = c.get("kind") or "card"
                sub_id = c.get("subcanvasId") if kind == "subcanvas" else None
                height = c.get("height")
                self.conn.execute(
                    "INSERT INTO cards (id, canvas_id, kind, subcanvas_id, title, x, y, width, height, header_color, content_html, sort_order) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        str(c["id"]),
                        canvas_id,
                        kind,
                        sub_id,
                        str(c.get("title") or "未命名节点"),
                        int(round(float(c.get("x", 0)))),
                        int(round(float(c.get("y", 0)))),
                        int(round(float(c.get("width", DEFAULT_CARD_WIDTH)))),
                        int(round(float(height))) if height is not None else None,
                        c.get("headerColor"),
                        str(c.get("contentHtml") or ""),
                        idx,
                    ),
                )

            for idx, g in enumerate(groups):
                self.conn.execute(
                    "INSERT INTO groups (id, canvas_id, title, card_ids_json, header_color, sort_order) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        str(g["id"]),
                        canvas_id,
                        str(g.get("title") or "未命名组"),
                        json.dumps(list(g.get("cardIds") or []), ensure_ascii=False),
                        g.get("headerColor"),
                        idx,
                    ),
                )

            for idx, conn in enumerate(connections):
                self.conn.execute(
                    "INSERT INTO connections (id, canvas_id, from_pin_id, to_pin_id, color, sort_order) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        str(conn["id"]),
                        canvas_id,
                        str(conn["fromPinId"]),
                        str(conn["toPinId"]),
                        conn.get("color") or DEFAULT_COLOR_NEUTRAL,
                        idx,
                    ),
                )

    def delete_canvas_subtree(self, canvas_id: str) -> list[str]:
        """Delete canvas_id and all its descendant canvases in SQLite."""
        descendants = self.get_descendant_canvas_ids(canvas_id)
        all_ids = [canvas_id] + descendants
        with self.conn:
            for cid in reversed(all_ids):
                self.conn.execute("DELETE FROM connections WHERE canvas_id = ?", (cid,))
                self.conn.execute("DELETE FROM groups WHERE canvas_id = ?", (cid,))
                self.conn.execute("DELETE FROM cards WHERE canvas_id = ?", (cid,))
                self.conn.execute("DELETE FROM canvases WHERE id = ?", (cid,))
        return all_ids

    def compute_canvas_thumbnail(self, canvas_id: str) -> dict[str, Any]:
        """Compute lightweight minimap-style thumbnail summary for a subcanvas without recursive loading."""
        meta = self.get_canvas_row(canvas_id)
        if meta is None:
            return {
                "canvasId": canvas_id,
                "title": "子画布",
                "cardCount": 0,
                "subcanvasCount": 0,
                "groupCount": 0,
                "connectionCount": 0,
                "bounds": None,
                "cards": [],
                "groups": [],
                "connections": [],
            }

        card_rows = self.conn.execute(
            "SELECT id, kind, x, y, width, height, header_color, content_html "
            "FROM cards WHERE canvas_id = ? ORDER BY sort_order ASC",
            (canvas_id,),
        ).fetchall()
        group_rows = self.conn.execute(
            "SELECT id, card_ids_json, header_color FROM groups WHERE canvas_id = ? ORDER BY sort_order ASC",
            (canvas_id,),
        ).fetchall()
        conn_rows = self.conn.execute(
            "SELECT from_pin_id, to_pin_id, color FROM connections WHERE canvas_id = ? ORDER BY sort_order ASC",
            (canvas_id,),
        ).fetchall()

        card_map: dict[str, dict[str, Any]] = {}
        thumb_cards: list[dict[str, Any]] = []
        subcanvas_count = 0
        normal_card_count = 0

        for r in card_rows:
            kind = r["kind"] or "card"
            if kind == "subcanvas":
                subcanvas_count += 1
                default_h = DEFAULT_SUBCANVAS_HEIGHT
            else:
                normal_card_count += 1
                default_h = DEFAULT_CARD_HEIGHT
            w = int(r["width"] or DEFAULT_CARD_WIDTH)
            h = int(r["height"] or default_h)
            entry = {
                "id": r["id"],
                "kind": kind,
                "x": int(r["x"]),
                "y": int(r["y"]),
                "width": w,
                "height": h,
                "headerColor": r["header_color"],
            }
            card_map[r["id"]] = {**entry, "contentHtml": r["content_html"] or ""}
            thumb_cards.append(entry)

        thumb_groups: list[dict[str, Any]] = []
        group_bounds_map: dict[str, dict[str, Any]] = {}
        for gr in group_rows:
            cids = json.loads(gr["card_ids_json"])
            members = [card_map[cid] for cid in cids if cid in card_map]
            if not members:
                continue
            gx = min(m["x"] for m in members) - GRID_SIZE
            gy = min(m["y"] for m in members) - GRID_SIZE
            gx2 = max(m["x"] + m["width"] for m in members) + GRID_SIZE
            gy2 = max(m["y"] + m["height"] for m in members) + GRID_SIZE
            gb = {
                "x": gx,
                "y": gy,
                "width": max(288, gx2 - gx),
                "height": gy2 - gy,
                "headerColor": gr["header_color"],
            }
            group_bounds_map[gr["id"]] = gb
            thumb_groups.append(gb)

        def _pin_point(pin_id: str) -> tuple[float, float] | None:
            if not pin_id:
                return None
            for prefix in ("pin-group-left-", "pin-group-right-", "pin-group-"):
                if pin_id.startswith(prefix):
                    gid = pin_id[len(prefix):]
                    gb = group_bounds_map.get(gid)
                    if not gb:
                        return None
                    px = gb["x"] + (gb["width"] if "right" in prefix else 0)
                    return float(px), float(gb["y"] + gb["height"] / 2)
            for prefix in ("pin-head-left-", "pin-head-right-", "pin-head-"):
                if pin_id.startswith(prefix):
                    cid = pin_id[len(prefix):]
                    cm = card_map.get(cid)
                    if not cm:
                        return None
                    px = cm["x"] + (cm["width"] if "right" in prefix else 0)
                    return float(px), float(cm["y"] + 20)
            for cm in card_map.values():
                if pin_id in cm.get("contentHtml", ""):
                    return float(cm["x"] + cm["width"] * 0.5), float(cm["y"] + cm["height"] * 0.6)
            return None

        thumb_conns: list[dict[str, Any]] = []
        for cr in conn_rows:
            p1 = _pin_point(cr["from_pin_id"])
            p2 = _pin_point(cr["to_pin_id"])
            if p1 and p2:
                thumb_conns.append(
                    {
                        "x1": round(p1[0], 1),
                        "y1": round(p1[1], 1),
                        "x2": round(p2[0], 1),
                        "y2": round(p2[1], 1),
                        "color": cr["color"] or DEFAULT_COLOR_NEUTRAL,
                    }
                )

        bounds = None
        if thumb_cards or thumb_groups:
            xs = [c["x"] for c in thumb_cards] + [g["x"] for g in thumb_groups]
            ys = [c["y"] for c in thumb_cards] + [g["y"] for g in thumb_groups]
            x2s = [c["x"] + c["width"] for c in thumb_cards] + [g["x"] + g["width"] for g in thumb_groups]
            y2s = [c["y"] + c["height"] for c in thumb_cards] + [g["y"] + g["height"] for g in thumb_groups]
            bounds = {
                "minX": min(xs),
                "minY": min(ys),
                "maxX": max(x2s),
                "maxY": max(y2s),
            }

        return {
            "canvasId": canvas_id,
            "title": meta["title"],
            "cardCount": normal_card_count,
            "subcanvasCount": subcanvas_count,
            "groupCount": len(thumb_groups),
            "connectionCount": len(conn_rows),
            "bounds": bounds,
            "cards": thumb_cards,
            "groups": thumb_groups,
            "connections": thumb_conns,
        }

    # ------------------------------------------------------------------
    # Library
    # ------------------------------------------------------------------

    def load_library(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT id, name, description, created_at, updated_at, payload_json "
            "FROM library_items ORDER BY sort_order ASC"
        ).fetchall()
        items: list[dict[str, Any]] = []
        for r in rows:
            try:
                payload = json.loads(r["payload_json"])
            except Exception:
                payload = {}
            items.append(
                {
                    "id": r["id"],
                    "name": r["name"],
                    "description": r["description"],
                    "createdAt": int(r["created_at"]),
                    "updatedAt": int(r["updated_at"]),
                    "cards": payload.get("cards", []),
                    "connections": payload.get("connections", []),
                    "groups": payload.get("groups", []),
                }
            )
        return items

    def save_library(self, items: list[dict[str, Any]]) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM library_items")
            for idx, item in enumerate(items):
                payload = {
                    "cards": item.get("cards", []),
                    "connections": item.get("connections", []),
                    "groups": item.get("groups", []),
                }
                self.conn.execute(
                    "INSERT INTO library_items (id, name, description, created_at, updated_at, payload_json, sort_order) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        str(item["id"]),
                        str(item.get("name") or "未命名模板"),
                        str(item.get("description") or ""),
                        int(item.get("createdAt") or int(time.time() * 1000)),
                        int(item.get("updatedAt") or int(time.time() * 1000)),
                        json.dumps(payload, ensure_ascii=False),
                        idx,
                    ),
                )
