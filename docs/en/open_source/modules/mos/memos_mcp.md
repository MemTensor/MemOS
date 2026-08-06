---
title: MCP (Model Context Protocol) Setup Guide
desc: The Model Context Protocol (MCP) is a standard protocol that enables AI assistants to securely access and interact with local and remote resources. In the MemOS project, MCP provides a standardized interface for memory operations, allowing external applications to interact with the memory system through well-defined tools and resources.
---


## Configuration

### Environment Variables

Create a `.env` file in your project root with the following configuration:

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

## Starting the MCP Server

### Method 1: Using the Built-in Server Script

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

### Method 2: Using the Example Script

```bash
# Navigate to the examples directory
cd examples/mem_mcp

# Run the server
python simple_fastmcp_serve.py --transport http --port 8000
```

### Transport Options

The MCP server supports three transport methods:

1. **stdio** (default): Standard input/output for local applications
2. **http**: HTTP-based transport for web applications
3. **sse**: Server-Sent Events (deprecated but still supported)

### Command Line Arguments

- `--transport`: Choose transport method (`stdio`, `http`, `sse`)
- `--host`: Host address for HTTP/SSE transport (default: `localhost`)
- `--port`: Port number for HTTP/SSE transport (default: `8000`)

## MCP Client Usage

### Basic Client Example

The project includes a sample client that demonstrates how to interact with the MCP server:

```bash
# Ensure the MCP server is running on HTTP transport
cd examples/mem_mcp
python simple_fastmcp_serve.py --transport http --port 8000

# In another terminal, run the client
cd examples/mem_mcp
python simple_fastmcp_client.py
```

## MCP Configuration

For Cursor IDE integration with MemOS MCP server, add this configuration to your `desktop_config.json` and other local MCP:

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
