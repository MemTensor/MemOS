#!/usr/bin/env python3
"""Working FastMCP Client"""

import asyncio

from fastmcp import Client


async def main():
    """Main function using FastMCP Client"""

    print("Working FastMCP Client")
    print("=" * 40)

    async with Client("http://127.0.0.1:8000/mcp") as client:
        print("Connected to MOS MCP server!")

        print("Available tools:")
        tools = await client.list_tools()
        for tool in tools:
            print("**" * 20)
            print(f"  - {tool.name}: {tool.description}")

        print("Available resources:")
        resources = await client.list_resources()
        for resource in resources:
            print(f"  - {resource.uri}: {resource.description}")

        print("Testing tool calls...")

        print("  Getting user info...")
        result = await client.call_tool("get_user_info", {})
        print(f"    Result: {result.content[0].text}")

        print("  Creating user...")
        result = await client.call_tool(
            "create_user",
            {"user_id": "fastmcp_user", "role": "USER", "user_name": "FastMCP Test User"},
        )
        print(f"Result: {result.content[0].text}")

        print(" register cube...")
        result = await client.call_tool(
            "register_cube",
            {
                "cube_name_or_path": "cube_default_user",
                "user_id": "fastmcp_user",
                "cube_id": "fastmcp_user",
            },
        )
        print(f"    Result: {result}")

        print("  Adding memory...")
        result = await client.call_tool(
            "add_memory",
            {
                "memory_content": "This is a test memory from FastMCP client.",
                "cube_id": "fastmcp_user",
                "user_id": "fastmcp_user",
            },
        )
        print(f"    Result: {result.content[0].text}")

        print("  Searching memories...")
        result = await client.call_tool(
            "search_memories", {"query": "test memory", "user_id": "fastmcp_user"}
        )
        print(f"    Result: {result.content[0].text[:200]}...")

        print("  Testing chat...")
        result = await client.call_tool(
            "chat", {"query": "Hello! Tell me about yourself.", "user_id": "fastmcp_user"}
        )
        print(f"    Result: {result.content[0].text[:200]}...")


if __name__ == "__main__":
    asyncio.run(main())
