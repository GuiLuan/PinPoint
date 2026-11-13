from __future__ import annotations

import json
import subprocess
import sys
import threading
import unittest
import urllib.request
from pathlib import Path

from server import create_server


class PinPointMcpTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd, cls.store, cls.router = create_server(host="127.0.0.1", port=0)
        cls.port = cls.httpd.server_address[1]
        cls.mcp_url = f"http://127.0.0.1:{cls.port}/mcp"
        cls.api_base = f"http://127.0.0.1:{cls.port}/api/v1"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def setUp(self) -> None:
        self.store.reset()

    def _mcp_http(self, payload: dict) -> tuple[int, dict | None]:
        req = urllib.request.Request(
            self.mcp_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else None)

    def test_http_mcp_handshake_tools_resources_and_workflow(self) -> None:
        # 1. Initialize
        status, init_res = self._mcp_http({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "clientInfo": {"name": "test-client", "version": "1.0"}},
        })
        self.assertEqual(status, 200)
        self.assertEqual(init_res["result"]["protocolVersion"], "2025-03-26")
        self.assertEqual(init_res["result"]["serverInfo"]["name"], "pinpoint-mcp")

        # 2. notifications/initialized -> 202 empty
        status, notif_res = self._mcp_http({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        })
        self.assertEqual(status, 202)
        self.assertIsNone(notif_res)

        # 3. tools/list
        status, tools_res = self._mcp_http({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual(status, 200)
        tool_names = {t["name"] for t in tools_res["result"]["tools"]}
        self.assertIn("get_graph_summary", tool_names)
        self.assertIn("create_card", tool_names)
        self.assertIn("connect_nodes", tool_names)
        self.assertIn("auto_layout", tool_names)

        # 4. resources/list & resources/read
        status, res_list = self._mcp_http({"jsonrpc": "2.0", "id": 3, "method": "resources/list"})
        self.assertEqual(status, 200)
        uris = {r["uri"] for r in res_list["result"]["resources"]}
        self.assertIn("pinpoint://graph/summary", uris)

        status, res_read = self._mcp_http({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "resources/read",
            "params": {"uri": "pinpoint://graph/summary"},
        })
        self.assertEqual(status, 200)
        summary_data = json.loads(res_read["result"]["contents"][0]["text"])
        self.assertEqual(summary_data["cardCount"], 2)

        # 5. tools/call: create_card -> create_capsule -> connect_nodes -> auto_layout
        _, c_res = self._mcp_http({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "create_card",
                "arguments": {
                    "title": "MCP 验证节点",
                    "contentText": "通过协议调用自动创建并连线。",
                    "capsules": [{"text": "协议调用", "color": "#bf5af2"}],
                },
            },
        })
        self.assertFalse(c_res["result"]["isError"])
        new_card = json.loads(c_res["result"]["content"][0]["text"])
        new_card_id = new_card["id"]

        _, conn_res = self._mcp_http({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "connect_nodes",
                "arguments": {
                    "fromCardId": "card-1",
                    "fromCapsuleText": "核心词汇",
                    "toCardId": new_card_id,
                    "toCapsuleText": "协议调用",
                },
            },
        })
        self.assertFalse(conn_res["result"]["isError"])

        # Semantic error propagates as isError=true for model self-correction
        _, bad_conn = self._mcp_http({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {
                "name": "connect_nodes",
                "arguments": {
                    "fromCardId": new_card_id,
                    "fromSide": "left",
                    "toCardId": new_card_id,
                    "toSide": "right",
                },
            },
        })
        self.assertTrue(bad_conn["result"]["isError"])
        self.assertIn("SELF_CONNECTION_NOT_ALLOWED", bad_conn["result"]["content"][0]["text"])

        _, layout_res = self._mcp_http({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "tools/call",
            "params": {
                "name": "auto_layout",
                "arguments": {"strategy": "layered"},
            },
        })
        self.assertFalse(layout_res["result"]["isError"])

        # 6. set_selection & get_selection + pinpoint://selection resource
        _, set_sel = self._mcp_http({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {"name": "set_selection", "arguments": {"cardIds": ["card-1", new_card_id]}},
        })
        self.assertFalse(set_sel["result"]["isError"])

        _, get_sel = self._mcp_http({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {"name": "get_selection", "arguments": {}},
        })
        self.assertFalse(get_sel["result"]["isError"])
        sel_data = json.loads(get_sel["result"]["content"][0]["text"])
        self.assertEqual(sel_data["cardIds"], ["card-1", new_card_id])
        self.assertEqual(sel_data["count"], 2)

        _, sel_res = self._mcp_http({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "resources/read",
            "params": {"uri": "pinpoint://selection"},
        })
        self.assertEqual(sel_res["result"]["contents"][0]["uri"], "pinpoint://selection")

        # 7. create_group & manage_group_members
        _, grp_res = self._mcp_http({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": {"name": "create_group", "arguments": {"cardIds": ["card-1", "card-2"], "title": "测试组"}},
        })
        self.assertFalse(grp_res["result"]["isError"])
        gid = json.loads(grp_res["result"]["content"][0]["text"])["id"]

        _, add_res = self._mcp_http({
            "jsonrpc": "2.0",
            "id": 13,
            "method": "tools/call",
            "params": {"name": "manage_group_members", "arguments": {"groupId": gid, "action": "add", "cardId": new_card_id}},
        })
        self.assertFalse(add_res["result"]["isError"])
        self.assertEqual(len(json.loads(add_res["result"]["content"][0]["text"])["cardIds"]), 3)

        _, rem_res = self._mcp_http({
            "jsonrpc": "2.0",
            "id": 14,
            "method": "tools/call",
            "params": {"name": "manage_group_members", "arguments": {"groupId": gid, "action": "remove", "cardId": new_card_id}},
        })
        self.assertFalse(rem_res["result"]["isError"])
        self.assertEqual(len(json.loads(rem_res["result"]["content"][0]["text"])["cardIds"]), 2)

    def test_stdio_mcp_subprocess_bridge_to_http_api(self) -> None:
        proc = subprocess.Popen(
            [sys.executable, "mcp_server.py", "--api-base", self.api_base],
            cwd=str(Path(__file__).resolve().parent.parent),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        assert proc.stdin is not None and proc.stdout is not None

        requests = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "get_graph_summary", "arguments": {}}},
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "create_card", "arguments": {"title": "Stdio MCP 卡片", "contentText": "来自 stdio 客户端"}},
            },
        ]
        stdin_payload = "\n".join(json.dumps(r, ensure_ascii=False) for r in requests) + "\n"
        out, err = proc.communicate(input=stdin_payload, timeout=10)
        self.assertEqual(proc.returncode, 0, msg=f"stderr: {err}")

        lines = [json.loads(line) for line in out.strip().splitlines() if line.strip()]
        # 3 responses (notification produces none)
        self.assertEqual(len(lines), 3)
        self.assertEqual(lines[0]["id"], 1)
        summary = json.loads(lines[1]["result"]["content"][0]["text"])
        self.assertEqual(summary["cardCount"], 2)
        created = json.loads(lines[2]["result"]["content"][0]["text"])
        self.assertEqual(created["title"], "Stdio MCP 卡片")
        # Verify persisted in server store
        self.assertEqual(len(self.store.state["cards"]), 3)


if __name__ == "__main__":
    unittest.main()
