# PinPoint MCP Server 使用指南

PinPoint MCP Server 基于 RESTful API（`/api/v1`）封装，采用 **零第三方依赖** Python 3.12 标准库实现，支持 **Stdio** 与 **Streamable HTTP** 两种接入方式。

---

## 方式一：HTTP MCP（推荐配合实时画布同步）

启动 PinPoint 主服务后，`/mcp` 端点即可直接接收 JSON-RPC 2.0 MCP 请求，并且所有改动会通过 SSE（`/api/v1/events`）实时渲染到浏览器画布：

```bash
python server.py
```

- Web 画布：`http://localhost:5173/index.html`
- OpenAPI 规范：`http://localhost:5173/api/v1/openapi.json`
- MCP HTTP 端点：`http://localhost:5173/mcp`

---

## 方式二：Stdio MCP（适配 Claude Code / Claude Desktop / Cursor）

先启动 `python server.py`（保持浏览器与服务端同步），再让客户端通过 `stdio` 启动 `mcp_server.py` 转发到 `http://localhost:5173/api/v1`：

```json
{
  "mcpServers": {
    "pinpoint": {
      "command": "python",
      "args": ["E:/Projects/PinPoint/mcp_server.py"]
    }
  }
}
```

如需连接自定义端口的 `server.py`，或脱离 `server.py` 独立测试协议（不带浏览器实时同步），可使用以下可选参数：

```bash
# 连接到自定义端口的 server.py
python mcp_server.py --api-base http://localhost:5173/api/v1

# 脱离 server.py 独立运行（可选加载指定 .pinpoint 文件）
python mcp_server.py --embedded --workspace path/to/file.pinpoint
```

---

## 已封装的工具列表（25 个 Tools）

- **图谱读取与保存**：`get_graph_summary`、`get_card`、`search_cards`、`save_graph`
- **实时选区同步**：`get_selection`（读取画布当前选中的卡片、胶囊以及卡片正文划选文本 `textSelection`）、`set_selection`（高亮/设置前端选区）
- **节点操作**：`create_card`、`update_card`、`delete_card`、`batch_mutate_cards`、`clone_card`
- **胶囊操作**：`create_capsule`、`update_capsule`、`delete_capsule`
- **连线操作**：`connect_nodes`（支持精确 `pinId` 或卡片 ID + 胶囊文本语义连线）、`update_connection`、`delete_connection`
- **组管理**：`create_group`、`update_group`、`delete_group`、`manage_group_members`（增删组成员）
- **排版与视口历史**：`align_cards`、`auto_layout`（分层拓扑/网格）、`focus_viewport`、`undo_redo`

## 已暴露资源（Resources）

- `pinpoint://graph/summary`：AI 友好的轻量拓扑摘要 JSON
- `pinpoint://graph`：完整图谱工作区状态 JSON
- `pinpoint://selection`：画布当前选中节点与胶囊 JSON
- `pinpoint://openapi`：底层 RESTful API OpenAPI 3.1 规范
