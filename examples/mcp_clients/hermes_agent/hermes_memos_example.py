#!/usr/bin/env python3
"""
Example: Hermes Agent with MemOS Memory Backend

This demonstrates how to use MemOS as a memory backend for Hermes Agent
via the MCP (Model Context Protocol) interface.

Prerequisites:
1. Install memos: pip install MemoryOS
2. Start memos MCP server: python -m memos.api.mcp_serve --transport http --port 8766
3. Install Hermes: https://github.com/NousResearch/hermes-agent
4. Run setup: bash setup.sh

Usage:
    python hermes_memos_example.py
"""


import requests


class MemOSClient:
    """Simple HTTP client for MemOS MCP server."""

    def __init__(self, mcp_url: str = "http://127.0.0.1:8766/mcp"):
        self.mcp_url = mcp_url
        self.session_id = None

    def _call_tool(self, tool_name: str, arguments: dict) -> dict:
        """Call an MCP tool."""
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }

        headers = {"Content-Type": "application/json", "Accept": "application/json"}

        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id

        response = requests.post(self.mcp_url, json=payload, headers=headers)
        return response.json()

    def initialize(self) -> bool:
        """Initialize MCP session."""
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "hermes-memos-example", "version": "1.0.0"},
            },
        }

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }

        try:
            response = requests.post(self.mcp_url, json=payload, headers=headers, timeout=5)
            if response.status_code == 200:
                self.session_id = response.headers.get("Mcp-Session-Id")
                print(f"✓ Initialized MCP session: {self.session_id}")
                return True
        except Exception as e:
            print(f"✗ Failed to initialize: {e}")

        return False

    def add_memory(self, content: str, cube_id: str | None = None) -> bool:
        """Add memory to MemOS."""
        arguments = {"memory_content": content}
        if cube_id:
            arguments["cube_id"] = cube_id

        result = self._call_tool("add_memory", arguments)

        if "result" in result:
            print(f"✓ Added memory: {content[:50]}...")
            return True
        else:
            print(f"✗ Failed to add memory: {result}")
            return False

    def search_memories(self, query: str, top_k: int = 5) -> list:
        """Search memories in MemOS."""
        result = self._call_tool("search_memories", {"query": query, "top_k": top_k})

        if "result" in result:
            memories = result["result"].get("content", [])
            print(f"✓ Found {len(memories)} memories for: {query}")
            return memories
        else:
            print(f"✗ Search failed: {result}")
            return []

    def list_tools(self) -> list:
        """List available MCP tools."""
        payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}

        headers = {"Content-Type": "application/json", "Accept": "application/json"}

        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id

        response = requests.post(self.mcp_url, json=payload, headers=headers)
        result = response.json()

        if "result" in result:
            tools = result["result"].get("tools", [])
            print(f"✓ Available tools: {len(tools)}")
            for tool in tools:
                print(f"  - {tool['name']}: {tool.get('description', '')[:60]}")
            return tools
        else:
            print(f"✗ Failed to list tools: {result}")
            return []


def main():
    """Demonstrate MemOS integration with Hermes Agent."""
    print("=== MemOS Hermes Agent Integration Example ===\n")

    # Initialize client
    client = MemOSClient()

    if not client.initialize():
        print("\n⚠️  Make sure memos MCP server is running:")
        print("   python -m memos.api.mcp_serve --transport http --port 8766")
        return

    print()

    # List available tools
    print("1. Listing available MCP tools:")
    client.list_tools()
    print()

    # Add some memories
    print("2. Adding memories:")
    client.add_memory("用户喜欢简洁的回答，使用 analytics databases do analytics")
    client.add_memory("项目使用 Python 3.11，部署在 Kubernetes 集群")
    client.add_memory("用户偏好中文沟通，技术栈包括 Java、Python、SQL")
    print()

    # Search memories
    print("3. Searching memories:")
    memories = client.search_memories("技术栈")
    for i, mem in enumerate(memories, 1):
        if isinstance(mem, dict) and "text" in mem:
            print(f"  {i}. {mem['text'][:80]}...")
    print()

    memories = client.search_memories("用户偏好")
    for i, mem in enumerate(memories, 1):
        if isinstance(mem, dict) and "text" in mem:
            print(f"  {i}. {mem['text'][:80]}...")
    print()

    print("=== Integration Example Complete ===")
    print("\nNext steps:")
    print("1. Run: bash setup.sh")
    print("2. Start Hermes: hermes")
    print("3. Test memory: 'Remember that I use analytics databases'")


if __name__ == "__main__":
    main()
