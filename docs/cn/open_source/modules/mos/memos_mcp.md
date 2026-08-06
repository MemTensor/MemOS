---
title: MCP (Model Context Protocol) Setup Guide
desc: Model Context Protocol（MCP）是一种标准协议，使 AI 助手能够安全地访问和交互本地及远程资源。在 MemOS 项目中，MCP 为内存操作提供了标准化接口，使外部应用程序能够通过定义良好的工具和资源与内存系统进行交互。
---


## 配置

### 环境变量

在项目根目录下创建 `.env` 文件，并填写以下配置：

```bash
# OpenAI Configuration
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_API_BASE=https://api.openai.com/v1

# Memory System Configuration
MOS_TEXT_MEM_TYPE=tree_text

# Neo4j Configuration (required for tree_text memory type)
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_neo4j_password
```

## 启动 MCP 服务器

### 方式一：使用内置服务器脚本

```bash
# Navigate to the project root
cd /path/to/MemOS

# Run with default stdio transport
python src/memos/api/mcp_serve.py

# Run with HTTP transport
python src/memos/api/mcp_serve.py --transport http --host localhost --port 8000

# Run with SSE transport (deprecated but supported)
python src/memos/api/mcp_serve.py --transport sse --host localhost --port 8000
```

### 方式二：使用示例脚本

```bash
# Navigate to the examples directory
cd examples/mem_mcp

# Run the server
python simple_fastmcp_serve.py --transport http --port 8000
```

### 传输方式选项

MCP 服务器支持三种传输方式：

1. **stdio**（默认）：面向本地应用的标准输入/输出
2. **http**：面向 Web 应用的 HTTP 传输
3. **sse**：Server-Sent Events（已弃用，但仍受支持）

### 命令行参数

- `--transport`：选择传输方式（`stdio`、`http`、`sse`）
- `--host`：HTTP/SSE 传输的主机地址（默认：`localhost`）
- `--port`：HTTP/SSE 传输的端口号（默认：`8000`）

## MCP 客户端使用

### 基础客户端示例

项目包含一个示例客户端，演示如何与 MCP 服务器进行交互：

```bash
# Ensure the MCP server is running on HTTP transport
cd examples/mem_mcp
python simple_fastmcp_serve.py --transport http --port 8000

# In another terminal, run the client
cd examples/mem_mcp
python simple_fastmcp_client.py
```

## MCP 配置

如需将 Cursor IDE 与 MemOS MCP 服务器集成，请将以下配置添加到 `desktop_config.json` 及其他本地 MCP 配置文件中：

```json
{
  "mcpServers": {
    "memos-fastmcp": {
      "command": "/path/to/your/conda/envs/memos/bin/python",
      "args": [
        "-m", "memos.api.mcp_serve",
        "--transport", "stdio"
      ],
    //   "cwd": "/path/to/your/MemOS pip user is optional",
      "env": {
        "OPENAI_API_KEY": "sk-your-openai-key-here",
        "OPENAI_API_BASE": "https://api.openai.com/v1",
        "MOS_TEXT_MEM_TYPE": "tree_text",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "your-neo4j-password"
      }
    }
  }
}
```
