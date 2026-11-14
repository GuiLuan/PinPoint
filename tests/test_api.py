from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from server import create_server


class PinPointApiTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd, cls.store, cls.router = create_server(host="127.0.0.1", port=0)
        cls.port = cls.httpd.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}/api/v1"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self) -> None:
        self.store.reset()

    def _request(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Content-Type": "application/json"} if body is not None else {}
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read().decode("utf-8"))

    def test_health_and_openapi(self) -> None:
        status, res = self._request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(res["ok"])
        self.assertEqual(res["data"]["status"], "ok")

        status, spec = self._request("GET", "/openapi.json")
        self.assertEqual(status, 200)
        self.assertEqual(spec["openapi"], "3.1.0")
        self.assertIn("/cards", spec["paths"])
        self.assertIn("/connections", spec["paths"])
        self.assertIn("/groups", spec["paths"])

    def test_graph_summary_and_replace(self) -> None:
        status, summary = self._request("GET", "/graph/summary")
        self.assertEqual(status, 200)
        self.assertEqual(summary["data"]["cardCount"], 2)
        self.assertEqual(summary["data"]["connectionCount"], 1)
        self.assertEqual(len(summary["data"]["cards"][0]["capsules"]), 1)

        status, graph = self._request("GET", "/graph?include=viewport")
        self.assertEqual(status, 200)
        self.assertIn("viewport", graph["data"])
        self.assertNotIn("settings", graph["data"])

    def test_card_crud_capsule_and_connection_workflow(self) -> None:
        # 1. Create card with structured text & capsule
        status, created = self._request(
            "POST",
            "/cards",
            {
                "title": "API 设计",
                "x": 900,
                "y": 300,
                "headerColor": "#bf5af2",
                "contentText": "核心目标是支持 MCP 包装和实时同步。",
                "capsules": [{"text": "MCP 包装", "color": "#0a84ff"}],
            },
        )
        self.assertEqual(status, 201)
        card_id = created["data"]["id"]
        self.assertEqual(len(created["data"]["capsules"]), 1)
        cap_pin = created["data"]["capsules"][0]["pinId"]

        # 2. Create second capsule via matchText
        status, cap2 = self._request(
            "POST",
            f"/cards/{card_id}/capsules",
            {"matchText": "实时同步", "color": "#ff9f0a"},
        )
        self.assertEqual(status, 201)
        cap2_pin = cap2["data"]["pinId"]

        # 3. Self-connection inside same card must fail with 400
        status, err = self._request(
            "POST",
            "/connections",
            {"fromPinId": cap_pin, "toPinId": cap2_pin},
        )
        self.assertEqual(status, 400)
        self.assertFalse(err["ok"])
        self.assertEqual(err["error"]["code"], "SELF_CONNECTION_NOT_ALLOWED")

        # 4. Connect card-1 capsule to new card's capsule
        status, conn = self._request(
            "POST",
            "/connections",
            {"fromPinId": "pin-1", "toPinId": cap_pin},
        )
        self.assertEqual(status, 201)
        conn_id = conn["data"]["id"]

        # Duplicate connection must fail with 409
        status, dup = self._request(
            "POST",
            "/connections",
            {"fromPinId": cap_pin, "toPinId": "pin-1"},
        )
        self.assertEqual(status, 409)
        self.assertEqual(dup["error"]["code"], "DUPLICATE_CONNECTION")

        # 5. Update capsule color and verify connection color synced
        status, _ = self._request("PATCH", f"/capsules/{cap_pin}", {"color": "#ff453a"})
        self.assertEqual(status, 200)
        status, conns = self._request("GET", f"/connections?pinId={cap_pin}")
        self.assertEqual(conns["data"][0]["color"], "#ff453a")

        # 6. Delete capsule -> unwraps text and removes connection
        status, _ = self._request("DELETE", f"/capsules/{cap_pin}")
        self.assertEqual(status, 200)
        status, card_after = self._request("GET", f"/cards/{card_id}")
        self.assertIn("MCP 包装", card_after["data"]["contentText"])
        self.assertEqual(len(card_after["data"]["connections"]), 0)

        # 7. Batch + Clone + Delete
        status, cloned = self._request("POST", f"/cards/{card_id}/clone", {"offsetX": 40, "offsetY": 40})
        self.assertEqual(status, 201)
        clone_id = cloned["data"]["id"]
        self.assertNotEqual(clone_id, card_id)

        status, _ = self._request("DELETE", f"/cards/{clone_id}")
        self.assertEqual(status, 200)

        # Ensure deleted connection id check
        status, err_del = self._request("DELETE", f"/connections/{conn_id}")
        self.assertEqual(status, 404)

    def test_groups_layout_history_viewport_and_settings(self) -> None:
        status, c3 = self._request("POST", "/cards", {"title": "节点3", "x": 300, "y": 400})
        self.assertEqual(status, 201)
        c3_id = c3["data"]["id"]

        # Create group with 2 cards
        status, grp = self._request("POST", "/groups", {"title": "核心链路", "cardIds": ["card-1", "card-2"]})
        self.assertEqual(status, 201)
        gid = grp["data"]["id"]

        # Add 3rd card, then remove it
        status, grp2 = self._request("POST", f"/groups/{gid}/members", {"cardId": c3_id})
        self.assertEqual(status, 200)
        self.assertEqual(len(grp2["data"]["cardIds"]), 3)

        status, _ = self._request("DELETE", f"/groups/{gid}/members/{c3_id}")
        self.assertEqual(status, 200)

        # Removing another member (<2 remaining) dissolves group
        status, dissolved = self._request("DELETE", f"/groups/{gid}/members/card-2")
        self.assertEqual(status, 200)
        self.assertTrue(dissolved["data"]["dissolved"])

        # Align & Auto-layout
        status, aligned = self._request("POST", "/layout/align", {"cardIds": ["card-1", "card-2", c3_id], "type": "top"})
        self.assertEqual(status, 200)
        ys = {c["y"] for c in aligned["data"]}
        self.assertEqual(len(ys), 1)

        status, laid = self._request("POST", "/layout/auto", {"strategy": "layered"})
        self.assertEqual(status, 200)
        self.assertEqual(len(laid["data"]), 3)

        # Undo / Redo
        status, hist = self._request("GET", "/history")
        self.assertTrue(hist["data"]["canUndo"])
        status, undo_res = self._request("POST", "/history/undo")
        self.assertTrue(undo_res["data"]["undone"])
        status, redo_res = self._request("POST", "/history/redo")
        self.assertTrue(redo_res["data"]["redone"])

        # Viewport & Settings
        status, vp = self._request("PATCH", "/viewport", {"x": 100, "y": -50, "zoom": 1.25})
        self.assertEqual(status, 200)
        self.assertEqual(vp["data"]["zoom"], 1.25)

        status, fit = self._request("POST", "/viewport/fit", {})
        self.assertEqual(status, 200)
        self.assertGreaterEqual(fit["data"]["zoom"], 0.35)

        status, st = self._request("PATCH", "/settings", {"gridSnapMode": True, "minimap": {"position": "top-left", "size": 260}})
        self.assertEqual(status, 200)
        self.assertTrue(st["data"]["gridSnapMode"])
        self.assertEqual(st["data"]["minimap"]["position"], "top-left")

    def test_save_workspace_file(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as tmpdir:
            rel_path = f"{Path(tmpdir).name}/test_graph.pinpoint"
            status, saved = self._request("POST", "/graph/save", {"path": rel_path})
            self.assertEqual(status, 200)
            self.assertEqual(saved["data"]["fileName"], "test_graph.pinpoint")
            self.assertTrue(Path(rel_path).exists())

    def test_sse_sync_stream_and_client_id(self) -> None:
        url = f"{self.base_url}/events"
        with urllib.request.urlopen(url, timeout=5) as stream:
            # Read initial connected event
            lines = []
            while True:
                line = stream.readline().decode("utf-8")
                if line == "\n" or line == "\r\n":
                    break
                lines.append(line.strip())
            data_line = next(l for l in lines if l.startswith("data:"))
            hello = json.loads(data_line[5:].strip())
            self.assertEqual(hello["type"], "CONNECTED")
            self.assertIn("state", hello)
            self.assertIn("revision", hello)

            # Mutate via sync mode with X-PinPoint-Client header
            req = urllib.request.Request(
                f"{self.base_url}/graph?mode=sync",
                data=json.dumps({
                    "cards": [
                        {"id": "card-sync", "title": "Synced", "x": 100, "y": 100, "width": 310, "contentHtml": "hello"}
                    ],
                    "connections": [],
                    "groups": [],
                }).encode("utf-8"),
                headers={"Content-Type": "application/json", "X-PinPoint-Client": "web-tab-1"},
                method="PUT",
            )
            with urllib.request.urlopen(req, timeout=5) as put_resp:
                self.assertEqual(put_resp.status, 200)

            # Read SSE broadcast event
            evt_lines = []
            while True:
                line = stream.readline().decode("utf-8")
                if line == "\n" or line == "\r\n":
                    break
                evt_lines.append(line.strip())
            evt_data = next(l for l in evt_lines if l.startswith("data:"))
            evt = json.loads(evt_data[5:].strip())
            self.assertEqual(evt["type"], "GRAPH_SYNCED")
            self.assertEqual(evt["clientId"], "web-tab-1")
            self.assertGreater(evt["revision"], hello["revision"])
            self.assertEqual(evt["state"]["cards"][0]["id"], "card-sync")

    def test_delete_card_cascades_capsule_and_header_connections(self) -> None:
        _, created = self._request("POST", "/cards", {
            "title": "Temp Source",
            "contentText": "has capsule",
            "capsules": [{"text": "capsule", "color": "#0a84ff"}],
        })
        cid = created["data"]["id"]
        pin_id = created["data"]["capsules"][0]["pinId"]
        self._request("POST", "/connections", {
            "fromPinId": pin_id,
            "toCardId": "card-2",
            "toSide": "left",
        })
        self._request("POST", "/connections", {
            "fromCardId": "card-1",
            "fromSide": "right",
            "toCardId": cid,
            "toSide": "left",
        })
        _, summary_before = self._request("GET", "/graph/summary")
        self.assertEqual(summary_before["data"]["connectionCount"], 3)

        status, _ = self._request("DELETE", f"/cards/{cid}")
        self.assertEqual(status, 200)
        _, summary_after = self._request("GET", "/graph/summary")
        self.assertEqual(summary_after["data"]["connectionCount"], 1)

    def test_selection_sync_pruning_and_strict_mode(self) -> None:
        status, sel = self._request("PUT", "/selection", {"cardIds": ["card-1", "card-2"]})
        self.assertEqual(status, 200)
        self.assertEqual(sel["data"]["cardIds"], ["card-1", "card-2"])
        self.assertEqual(sel["data"]["count"], 2)
        self.assertEqual(len(sel["data"]["cards"]), 2)

        # Strict mode rejects missing card ID
        status_err, _ = self._request("PUT", "/selection", {"cardIds": ["nonexistent"], "strict": True})
        self.assertEqual(status_err, 404)

        # Inline textSelection sync & pruning
        status_ts, ts_res = self._request("PUT", "/selection", {
            "cardIds": [],
            "textSelection": {"cardId": "card-1", "text": "核心词汇"},
        })
        self.assertEqual(status_ts, 200)
        self.assertEqual(ts_res["data"]["textSelection"], {"cardId": "card-1", "text": "核心词汇"})

        # Deleting a selected card automatically prunes selection on read
        self._request("PUT", "/selection", {"cardIds": ["card-1", "card-2"]})
        self._request("DELETE", "/cards/card-2")
        status, sel_after = self._request("GET", "/selection")
        self.assertEqual(status, 200)
        self.assertEqual(sel_after["data"]["cardIds"], ["card-1"])

    def test_batch_atomicity_and_update_connection_duplicate_guard(self) -> None:
        # Batch failure must roll back earlier creations in the same batch
        status, _ = self._request("POST", "/cards/batch", {
            "create": [{"title": "Should Rollback", "contentText": "temp"}],
            "update": [{"id": "nonexistent-card", "title": "Nope"}],
        })
        self.assertEqual(status, 404)
        _, cards_after = self._request("GET", "/cards")
        self.assertFalse(any(c["title"] == "Should Rollback" for c in cards_after["data"]))

        # Reconnecting a wire onto an existing undirected pair must return 409
        _, c3 = self._request("POST", "/cards", {"title": "Third", "contentText": "body"})
        c3_id = c3["data"]["id"]
        _, conn2 = self._request("POST", "/connections", {
            "fromPinId": "pin-1",
            "toCardId": c3_id, "toSide": "left",
        })
        status_dup, _ = self._request("PATCH", f"/connections/{conn2['data']['id']}", {
            "toPinId": "pin-2",
        })
        self.assertEqual(status_dup, 409)

        # Updating card text removes obsolete capsule wires cleanly
        _, summary_before = self._request("GET", "/graph/summary")
        self.assertEqual(summary_before["data"]["connectionCount"], 2)
        self._request("PATCH", "/cards/card-1", {"contentText": "rewritten plain text"})
        _, summary_after = self._request("GET", "/graph/summary")
        self.assertEqual(summary_after["data"]["connectionCount"], 0)

    def test_workspace_auto_persistence_across_restarts(self) -> None:
        from backend import GraphStore

        with tempfile.TemporaryDirectory(dir=Path.cwd()) as tmpdir:
            ws_path = Path(tmpdir) / "nested" / "workspace.pinpoint"
            store1 = GraphStore(workspace_file=ws_path, base_dir=Path.cwd())
            created = store1.create_card({"title": "Persisted Card", "contentText": "Survives restart"})
            self.assertTrue(ws_path.exists())

            # Simulate container restart by reloading from the same workspace file
            store2 = GraphStore(workspace_file=ws_path, base_dir=Path.cwd())
            titles = [c["title"] for c in store2.list_cards()]
            self.assertIn("Persisted Card", titles)
            self.assertEqual(store2.get_card(created["id"])["contentText"], "Survives restart")

    def test_frontend_static_root_and_backend_isolation(self) -> None:
        root_url = f"http://127.0.0.1:{self.port}"
        with urllib.request.urlopen(f"{root_url}/index.html", timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            html = resp.read().decode("utf-8")
            self.assertIn('<script type="module" src="js/main.js"></script>', html)

        with urllib.request.urlopen(f"{root_url}/js/main.js", timeout=5) as resp:
            self.assertEqual(resp.status, 200)

        for forbidden_path in ("/server.py", "/backend/store.py", "/tests/test_api.py"):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(f"{root_url}{forbidden_path}", timeout=5)
            self.assertEqual(ctx.exception.code, 404)

    def test_library_crud_verbatim_capture_instantiate_and_persistence(self) -> None:
        # 1. Build 3 cards with distinct colors, capsules, a group, and connections
        _, c1 = self._request("POST", "/cards", {
            "title": "入口节点",
            "x": 200,
            "y": 150,
            "width": 340,
            "headerColor": "#bf5af2",
            "contentText": "包含关键实体 A 和指标 B",
            "capsules": [
                {"text": "关键实体 A", "color": "#0a84ff"},
                {"text": "指标 B", "color": "#ff9f0a"},
            ],
        })
        c1_id = c1["data"]["id"]
        c1_pin_a = c1["data"]["capsules"][0]["pinId"]
        c1_pin_b = c1["data"]["capsules"][1]["pinId"]

        _, c2 = self._request("POST", "/cards", {
            "title": "目标节点",
            "x": 680,
            "y": 290,
            "width": 310,
            "headerColor": "#30d158",
            "contentText": "接收来自入口的信号",
            "capsules": [{"text": "信号", "color": "#ff453a"}],
        })
        c2_id = c2["data"]["id"]
        c2_pin = c2["data"]["capsules"][0]["pinId"]

        _, c3 = self._request("POST", "/cards", {
            "title": "外部干扰节点",
            "x": 1100,
            "y": 500,
            "contentText": "不应被包含在库条目内",
        })
        c3_id = c3["data"]["id"]

        # Create group for [c1, c2]
        _, grp = self._request("POST", "/groups", {
            "title": "核心模块",
            "headerColor": "#5e5ce6",
            "cardIds": [c1_id, c2_id],
        })
        grp_id = grp["data"]["id"]

        # Connect c1_pin_a -> c2_pin (internal to selection)
        _, conn_in = self._request("POST", "/connections", {
            "fromPinId": c1_pin_a,
            "toPinId": c2_pin,
            "color": "#0a84ff",
        })
        self.assertEqual(conn_in["data"]["color"], "#0a84ff")

        # Connect group -> c2 header? No, connect c1_pin_b -> c3 header (external to selection - must be excluded)
        self._request("POST", "/connections", {
            "fromPinId": c1_pin_b,
            "toCardId": c3_id,
            "toSide": "left",
        })

        # 2. Save [c1_id, c2_id] into Library via cardIds capture
        status, lib_created = self._request("POST", "/library", {
            "name": "标准双节点模板",
            "description": "保留颜色、胶囊、分组和内部连线",
            "cardIds": [c1_id, c2_id],
        })
        self.assertEqual(status, 201)
        item = lib_created["data"]
        item_id = item["id"]
        self.assertEqual(item["name"], "标准双节点模板")
        self.assertEqual(len(item["cards"]), 2)
        self.assertEqual(len(item["groups"]), 1)
        self.assertEqual(len(item["connections"]), 1)

        # Verify relative coordinates normalized to (0, 0) top-left and verbatim colors preserved
        min_x = min(c["x"] for c in item["cards"])
        min_y = min(c["y"] for c in item["cards"])
        self.assertEqual(min_x, 0)
        self.assertEqual(min_y, 0)
        saved_c1 = next(c for c in item["cards"] if c["title"] == "入口节点")
        saved_c2 = next(c for c in item["cards"] if c["title"] == "目标节点")
        self.assertEqual(saved_c1["headerColor"], "#bf5af2")
        self.assertEqual(saved_c1["width"], 340)
        self.assertEqual(saved_c2["x"] - saved_c1["x"], 480)
        self.assertEqual(saved_c2["y"] - saved_c1["y"], 140)
        self.assertEqual(item["groups"][0]["headerColor"], "#5e5ce6")
        self.assertEqual(item["connections"][0]["color"], "#0a84ff")

        # 3. Rename & list
        status, updated = self._request("PATCH", f"/library/{item_id}", {"name": "标准模板 v2"})
        self.assertEqual(status, 200)
        self.assertEqual(updated["data"]["name"], "标准模板 v2")

        status, listed = self._request("GET", "/library")
        self.assertEqual(status, 200)
        self.assertTrue(any(it["id"] == item_id and it["name"] == "标准模板 v2" for it in listed["data"]))

        # 4. Instantiate onto canvas at (1200, 800)
        status, inst = self._request("POST", f"/library/{item_id}/instantiate", {"x": 1200, "y": 800})
        self.assertEqual(status, 201)
        new_cards = inst["data"]["cards"]
        new_groups = inst["data"]["groups"]
        new_conns = inst["data"]["connections"]
        self.assertEqual(len(new_cards), 2)
        self.assertEqual(len(new_groups), 1)
        self.assertEqual(len(new_conns), 1)

        # All IDs must be distinct from originals
        new_card_ids = {c["id"] for c in new_cards}
        self.assertTrue(new_card_ids.isdisjoint({c1_id, c2_id}))
        self.assertNotEqual(new_groups[0]["id"], grp_id)
        self.assertEqual(set(new_groups[0]["cardIds"]), new_card_ids)

        # New connection endpoints must reference new capsule pin IDs inside the new cards
        new_pin_ids = set()
        for nc in new_cards:
            for cap in nc.get("capsules", []):
                new_pin_ids.add(cap["pinId"])
        self.assertIn(new_conns[0]["fromPinId"], new_pin_ids)
        self.assertIn(new_conns[0]["toPinId"], new_pin_ids)
        self.assertNotEqual(new_conns[0]["fromPinId"], c1_pin_a)
        self.assertNotEqual(new_conns[0]["toPinId"], c2_pin)
        self.assertEqual(new_conns[0]["color"], "#0a84ff")

        # Relative positions preserved at new anchor
        inst_c1 = next(c for c in new_cards if c["title"] == "入口节点")
        inst_c2 = next(c for c in new_cards if c["title"] == "目标节点")
        self.assertEqual(inst_c1["x"], 1200)
        self.assertEqual(inst_c1["y"], 800)
        self.assertEqual(inst_c2["x"], 1680)
        self.assertEqual(inst_c2["y"], 940)
        self.assertEqual(inst_c1["headerColor"], "#bf5af2")

        # 5. Resetting canvas must preserve library, and deleting item removes it
        self.store.reset()
        _, after_reset = self._request("GET", "/library")
        self.assertTrue(any(it["id"] == item_id for it in after_reset["data"]))

        status, deleted = self._request("DELETE", f"/library/{item_id}")
        self.assertEqual(status, 200)
        self.assertEqual(deleted["data"]["deletedId"], item_id)

        status, not_found = self._request("GET", f"/library/{item_id}")
        self.assertEqual(status, 404)

    def test_library_sse_events_and_file_persistence(self) -> None:
        from backend import GraphStore

        # SSE CONNECTED includes library and POST /library emits LIBRARY_CHANGED
        url = f"{self.base_url}/events"
        with urllib.request.urlopen(url, timeout=5) as stream:
            lines = []
            while True:
                line = stream.readline().decode("utf-8")
                if line in ("\n", "\r\n"):
                    break
                lines.append(line.strip())
            hello = json.loads(next(l for l in lines if l.startswith("data:"))[5:].strip())
            self.assertIn("library", hello)

            req = urllib.request.Request(
                f"{self.base_url}/library",
                data=json.dumps({
                    "name": "SSE 模板",
                    "cards": [
                        {"id": "c-tmp", "title": "Solo", "x": 0, "y": 0, "width": 310, "headerColor": "#30d158", "contentHtml": "Body"}
                    ],
                }).encode("utf-8"),
                headers={"Content-Type": "application/json", "X-PinPoint-Client": "tab-lib-1"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                self.assertEqual(resp.status, 201)

            evt_lines = []
            while True:
                line = stream.readline().decode("utf-8")
                if line in ("\n", "\r\n"):
                    break
                evt_lines.append(line.strip())
            evt = json.loads(next(l for l in evt_lines if l.startswith("data:"))[5:].strip())
            self.assertEqual(evt["type"], "LIBRARY_CHANGED")
            self.assertEqual(evt["clientId"], "tab-lib-1")
            self.assertEqual(len(evt["library"]), 1)
            self.assertEqual(evt["library"][0]["name"], "SSE 模板")

        # File persistence alongside workspace
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as tmpdir:
            ws_path = Path(tmpdir) / "workspace.pinpoint"
            store1 = GraphStore(workspace_file=ws_path, base_dir=Path.cwd())
            created = store1.create_library_item({
                "name": "持久模板",
                "cards": [{"id": "c1", "title": "A", "x": 10, "y": 20, "headerColor": "#ff9f0a", "contentHtml": "Hi"}],
            })
            lib_path = ws_path.with_name("library.json")
            self.assertTrue(lib_path.exists())

            store2 = GraphStore(workspace_file=ws_path, base_dir=Path.cwd())
            items = store2.list_library()
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["id"], created["id"])
            self.assertEqual(items[0]["cards"][0]["headerColor"], "#ff9f0a")

    def test_library_settings_validation_and_update(self) -> None:
        _, initial = self._request("GET", "/settings")
        self.assertEqual(initial["data"]["library"], {"position": "left", "layout": "grid", "width": 348})

        status, updated = self._request("PATCH", "/settings", {
            "library": {"position": "right", "layout": "list", "width": 520},
        })
        self.assertEqual(status, 200)
        self.assertEqual(updated["data"]["library"], {"position": "right", "layout": "list", "width": 520})

        _, clamped_min = self._request("PATCH", "/settings", {
            "library": {"width": 120},
        })
        self.assertEqual(clamped_min["data"]["library"]["width"], 260)

        _, clamped_max = self._request("PATCH", "/settings", {
            "library": {"width": 1400},
        })
        self.assertEqual(clamped_max["data"]["library"]["width"], 800)

        bad_pos_status, bad_pos = self._request("PATCH", "/settings", {
            "library": {"position": "center"},
        })
        self.assertEqual(bad_pos_status, 400)
        self.assertEqual(bad_pos["error"]["code"], "INVALID_LIBRARY_POSITION")

        bad_layout_status, bad_layout = self._request("PATCH", "/settings", {
            "library": {"layout": "masonry"},
        })
        self.assertEqual(bad_layout_status, 400)
        self.assertEqual(bad_layout["error"]["code"], "INVALID_LIBRARY_LAYOUT")

        bad_width_status, bad_width = self._request("PATCH", "/settings", {
            "library": {"width": "wide"},
        })
        self.assertEqual(bad_width_status, 400)
        self.assertEqual(bad_width["error"]["code"], "INVALID_LIBRARY_WIDTH")


if __name__ == "__main__":
    unittest.main()
