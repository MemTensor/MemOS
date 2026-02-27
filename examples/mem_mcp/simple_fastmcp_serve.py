import argparse
import json
import os

import requests

from dotenv import load_dotenv
from fastmcp import FastMCP


load_dotenv()

# Configuration
# This points to the Server API base URL (e.g., started via server_api.py)
API_BASE_URL = os.getenv("MEMOS_API_BASE_URL", "http://localhost:8001/product")

# Create MCP Server
mcp = FastMCP("MemOS MCP via Server API")


@mcp.tool()
def add_memory(memory_content: str, user_id: str, cube_id: str | None = None):
    """Add memory using the Server API."""
    payload = {
        "user_id": user_id,
        "messages": memory_content,
        "writable_cube_ids": [cube_id] if cube_id else None,
    }
    try:
        resp = requests.post(f"{API_BASE_URL}/add", json=payload)
        resp.raise_for_status()
        return resp.json()["message"]
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def search_memories(query: str, user_id: str, cube_ids: str | None = None):
    """Search memories using the Server API."""
    payload = {"query": query, "user_id": user_id, "readable_cube_ids": cube_ids}
    try:
        resp = requests.post(f"{API_BASE_URL}/search", json=payload)
        resp.raise_for_status()
        # The Server API search response structure matches product API mostly
        return json.dumps(resp.json()["data"], ensure_ascii=False)
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
def chat(query: str, user_id: str):
    """Chat using the Server API."""
    payload = {"query": query, "user_id": user_id}
    try:
        resp = requests.post(f"{API_BASE_URL}/chat/complete", json=payload)
        resp.raise_for_status()
        return resp.json()["data"]["response"]
    except Exception as e:
        return f"Error: {e}"


if __name__ == "__main__":
    # Parse command line arguments
    parser = argparse.ArgumentParser(description="MOS MCP Server via API")
    parser.add_argument(
        "--transport",
        choices=["stdio", "http", "sse"],
        default="stdio",
        help="Transport method (default: stdio)",
    )
    parser.add_argument("--host", default="localhost", help="Host for HTTP/SSE transport")
    parser.add_argument("--port", type=int, default=8000, help="Port for HTTP/SSE transport")

    args = parser.parse_args()

    # For stdio transport, don't pass host and port
    if args.transport == "stdio":
        mcp.run(transport=args.transport)
    else:
        mcp.run(transport=args.transport, host=args.host, port=args.port)
