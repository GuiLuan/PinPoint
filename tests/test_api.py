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


if __name__ == "__main__":
    unittest.main()
