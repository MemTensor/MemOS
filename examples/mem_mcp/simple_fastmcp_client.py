#!/usr/bin/env python3
"""Working FastMCP Client"""

import asyncio

from fastmcp import Client


async def main():
    """Main function using FastMCP Client"""

    print("Working FastMCP Client")
    print("=" * 40)

    # Connect to MCP server via HTTP
    # FastMCP HTTP endpoint is at /mcp (not /mcp/v1)
    async with Client("http://localhost:8002/mcp") as client:
        print("Connected to MCP server")

        print("\nTesting tool calls via Server API...")

        # Note: 'create_user' and 'get_user_info' are not supported by the Server API.
        # We assume the user already exists or the Server API handles it implicitly.
        # Using a demo user ID.
        user_id = "fastmcp_demo_user"

        print("\n  1. Adding memory...")
        result = await client.call_tool(
            "add_memory",
            arguments={
                "memory_content": "MemOS is a great tool for memory management.",
                "user_id": user_id,
            },
        )
        print(f"    Result: {result}")

        print("\n  2. Searching memories...")
        result = await client.call_tool(
            "search_memories",
            arguments={"query": "MemOS", "user_id": user_id},
        )
        print(f"    Result: {result}")

        print("\n  3. Chatting...")
        result = await client.call_tool(
            "chat",
            arguments={"query": "What is MemOS?", "user_id": user_id},
        )
        print(f"    Result: {result}")

        print("\n✓ All tests completed!")


if __name__ == "__main__":
    asyncio.run(main())
