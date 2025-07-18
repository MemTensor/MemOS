import asyncio
import os

from typing import Any

from fastmcp import FastMCP
from mcp.types import Resource

# Assuming these are your imports
from memos.mem_os.main import MOS
from memos.mem_user.user_manager import UserRole


class MOSMCPServer:
    def __init__(self):
        self.mcp = FastMCP("MOS Memory System")
        self.mos_core = MOS.simple()
        self._setup_resources()
        self._setup_tools()

    def _setup_resources(self):
        """Setup MCP resources"""

        @self.mcp.resource("users://list")
        async def users_resource() -> Resource:
            """Get all users list"""
            return Resource(
                uri="users://list",
                name="All Users",
                description="List of all users in the system",
                mimeType="application/json",
            )

        @self.mcp.resource("users://{user_id}/info")
        async def user_info_resource(user_id: str) -> Resource:
            """Get specific user information"""
            try:
                # Temporarily switch to target user to get information
                original_user = self.mos_core.user_id
                self.mos_core.user_id = user_id
                self.mos_core.user_id = original_user

                return Resource(
                    uri=f"users://{user_id}/info",
                    name=f"User {user_id} Info",
                    description=f"Information about user {user_id}",
                    mimeType="application/json",
                )
            except Exception as e:
                return Resource(
                    uri=f"users://{user_id}/info",
                    name=f"User {user_id} Info",
                    description=f"Error getting user info: {e!s}",
                    mimeType="text/plain",
                )

        @self.mcp.resource("cubes://{cube_id}/memories")
        async def cube_memories_resource(cube_id: str) -> Resource:
            """Get all memories in the specified cube"""
            try:
                return Resource(
                    uri=f"cubes://{cube_id}/memories",
                    name=f"Cube {cube_id} Memories",
                    description=f"All memories in cube {cube_id}",
                    mimeType="application/json",
                )
            except Exception as e:
                return Resource(
                    uri=f"cubes://{cube_id}/memories",
                    name=f"Cube {cube_id} Memories",
                    description=f"Error getting memories: {e!s}",
                    mimeType="text/plain",
                )

        @self.mcp.resource("chat://{user_id}/history")
        async def chat_history_resource(user_id: str) -> Resource:
            """Get user's chat history"""
            try:
                return Resource(
                    uri=f"chat://{user_id}/history",
                    name=f"Chat History for {user_id}",
                    description=f"Chat history for user {user_id}",
                    mimeType="application/json",
                )
            except Exception as e:
                return Resource(
                    uri=f"chat://{user_id}/history",
                    name=f"Chat History for {user_id}",
                    description=f"Error getting chat history: {e!s}",
                    mimeType="text/plain",
                )

    def _setup_tools(self):
        """Setup MCP tools"""

        @self.mcp.tool()
        async def chat(query: str, user_id: str | None = None) -> str:
            """
            Chat with MOS system

            Args:
                query: User query
                user_id: Optional user ID, if not provided, uses default user

            Returns:
                Chat response
            """
            try:
                response = self.mos_core.chat(query, user_id)
                return response
            except Exception as e:
                return f"Chat error: {e!s}"

        @self.mcp.tool()
        async def create_user(
            user_id: str, role: str = "USER", user_name: str | None = None
        ) -> str:
            """
            Create new user

            Args:
                user_id: User ID
                role: User role (USER, ADMIN)
                user_name: User name, if not provided, uses user_id

            Returns:
                Created user ID
            """
            try:
                user_role = UserRole.ADMIN if role.upper() == "ADMIN" else UserRole.USER
                created_user_id = self.mos_core.create_user(user_id, user_role, user_name)
                return f"User created successfully: {created_user_id}"
            except Exception as e:
                return f"Error creating user: {e!s}"

        @self.mcp.tool()
        async def create_cube(
            cube_name: str, owner_id: str, cube_path: str | None = None, cube_id: str | None = None
        ) -> str:
            """
            Create new memory cube for user

            Args:
                cube_name: Cube name
                owner_id: Owner ID
                cube_path: Cube path (optional)
                cube_id: Custom cube ID (optional)

            Returns:
                Created cube ID
            """
            try:
                created_cube_id = self.mos_core.create_cube_for_user(
                    cube_name, owner_id, cube_path, cube_id
                )
                return f"Cube created successfully: {created_cube_id}"
            except Exception as e:
                return f"Error creating cube: {e!s}"

        @self.mcp.tool()
        async def register_cube(
            cube_name_or_path: str, cube_id: str | None = None, user_id: str | None = None
        ) -> str:
            """
            Register memory cube

            Args:
                cube_name_or_path: Cube name or path
                cube_id: Cube ID (optional)
                user_id: User ID (optional)

            Returns:
                Registration result
            """
            try:
                if not os.path.exists(cube_name_or_path):
                    mos_config, cube_name_or_path = self.mos_core._auto_configure()
                self.mos_core.register_mem_cube(
                    cube_name_or_path, mem_cube_id=cube_id, user_id=user_id
                )
                return f"Cube registered successfully: {cube_id or cube_name_or_path}"
            except Exception as e:
                return f"Error registering cube: {e!s}"

        @self.mcp.tool()
        async def unregister_cube(cube_id: str, user_id: str | None = None) -> str:
            """
            Unregister memory cube

            Args:
                cube_id: Cube ID
                user_id: User ID (optional)

            Returns:
                Unregistration result
            """
            try:
                self.mos_core.unregister_mem_cube(cube_id, user_id)
                return f"Cube unregistered successfully: {cube_id}"
            except Exception as e:
                return f"Error unregistering cube: {e!s}"

        @self.mcp.tool()
        async def search_memories(
            query: str, user_id: str | None = None, cube_ids: list[str] | None = None
        ) -> dict[str, Any]:
            """
            Search memories

            Args:
                query: Search query
                user_id: User ID (optional)
                cube_ids: List of cube IDs to search (optional)

            Returns:
                Search results
            """
            try:
                result = self.mos_core.search(query, user_id, cube_ids)
                return result
            except Exception as e:
                return {"error": str(e)}

        @self.mcp.tool()
        async def add_memory(
            memory_content: str | None = None,
            doc_path: str | None = None,
            messages: list[dict[str, str]] | None = None,
            cube_id: str | None = None,
            user_id: str | None = None,
        ) -> str:
            """
            Add memory

            Args:
                memory_content: Memory content
                doc_path: Document path
                messages: Messages list
                cube_id: Cube ID (optional)
                user_id: User ID (optional)

            Returns:
                Addition result
            """
            try:
                self.mos_core.add(
                    messages=messages,
                    memory_content=memory_content,
                    doc_path=doc_path,
                    mem_cube_id=cube_id,
                    user_id=user_id,
                )
                return "Memory added successfully"
            except Exception as e:
                return f"Error adding memory: {e!s}"

        @self.mcp.tool()
        async def get_memory(
            cube_id: str, memory_id: str, user_id: str | None = None
        ) -> dict[str, Any]:
            """
            Get specific memory

            Args:
                cube_id: Cube ID
                memory_id: Memory ID
                user_id: User ID (optional)

            Returns:
                Memory content
            """
            try:
                memory = self.mos_core.get(cube_id, memory_id, user_id)
                return {"memory": str(memory)}
            except Exception as e:
                return {"error": str(e)}

        @self.mcp.tool()
        async def update_memory(
            cube_id: str, memory_id: str, memory_content: str, user_id: str | None = None
        ) -> str:
            """
            Update memory

            Args:
                cube_id: Cube ID
                memory_id: Memory ID
                memory_content: New memory content
                user_id: User ID (optional)

            Returns:
                Update result
            """
            try:
                from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata

                metadata = TextualMemoryMetadata(
                    user_id=user_id or self.mos_core.user_id,
                    session_id=self.mos_core.session_id,
                    source="mcp_update",
                )
                memory_item = TextualMemoryItem(memory=memory_content, metadata=metadata)

                self.mos_core.update(cube_id, memory_id, memory_item, user_id)
                return f"Memory updated successfully: {memory_id}"
            except Exception as e:
                return f"Error updating memory: {e!s}"

        @self.mcp.tool()
        async def delete_memory(cube_id: str, memory_id: str, user_id: str | None = None) -> str:
            """
            Delete memory

            Args:
                cube_id: Cube ID
                memory_id: Memory ID
                user_id: User ID (optional)

            Returns:
                Deletion result
            """
            try:
                self.mos_core.delete(cube_id, memory_id, user_id)
                return f"Memory deleted successfully: {memory_id}"
            except Exception as e:
                return f"Error deleting memory: {e!s}"

        @self.mcp.tool()
        async def delete_all_memories(cube_id: str, user_id: str | None = None) -> str:
            """
            Delete all memories

            Args:
                cube_id: Cube ID
                user_id: User ID (optional)

            Returns:
                Deletion result
            """
            try:
                self.mos_core.delete_all(cube_id, user_id)
                return f"All memories deleted successfully from cube: {cube_id}"
            except Exception as e:
                return f"Error deleting all memories: {e!s}"

        @self.mcp.tool()
        async def clear_chat_history(user_id: str | None = None) -> str:
            """
            Clear chat history

            Args:
                user_id: User ID (optional)

            Returns:
                Clear result
            """
            try:
                self.mos_core.clear_messages(user_id)
                target_user = user_id or self.mos_core.user_id
                return f"Chat history cleared for user: {target_user}"
            except Exception as e:
                return f"Error clearing chat history: {e!s}"

        @self.mcp.tool()
        async def dump_cube(
            dump_dir: str, user_id: str | None = None, cube_id: str | None = None
        ) -> str:
            """
            Export cube data

            Args:
                dump_dir: Export directory
                user_id: User ID (optional)
                cube_id: Cube ID (optional)

            Returns:
                Export result
            """
            try:
                self.mos_core.dump(dump_dir, user_id, cube_id)
                return f"Cube dumped successfully to: {dump_dir}"
            except Exception as e:
                return f"Error dumping cube: {e!s}"

        @self.mcp.tool()
        async def share_cube(cube_id: str, target_user_id: str) -> str:
            """
            Share cube with other users

            Args:
                cube_id: Cube ID
                target_user_id: Target user ID

            Returns:
                Share result
            """
            try:
                success = self.mos_core.share_cube_with_user(cube_id, target_user_id)
                if success:
                    return f"Cube {cube_id} shared successfully with user {target_user_id}"
                else:
                    return f"Failed to share cube {cube_id} with user {target_user_id}"
            except Exception as e:
                return f"Error sharing cube: {e!s}"

        @self.mcp.tool()
        async def get_user_info(user_id: str | None = None) -> dict[str, Any]:
            """
            Get user information

            Args:
                user_id: User ID (optional, if not provided, uses current user)

            Returns:
                User information
            """
            try:
                if user_id and user_id != self.mos_core.user_id:
                    # Temporarily switch user
                    original_user = self.mos_core.user_id
                    self.mos_core.user_id = user_id
                    user_info = self.mos_core.get_user_info()
                    self.mos_core.user_id = original_user
                    return user_info
                else:
                    return self.mos_core.get_user_info()
            except Exception as e:
                return {"error": str(e)}

        @self.mcp.tool()
        async def control_memory_scheduler(action: str) -> str:
            """
            Control memory scheduler

            Args:
                action: Action type ("start" or "stop")

            Returns:
                Operation result
            """
            try:
                if action.lower() == "start":
                    success = self.mos_core.mem_scheduler_on()
                    return (
                        "Memory scheduler started"
                        if success
                        else "Failed to start memory scheduler"
                    )
                elif action.lower() == "stop":
                    success = self.mos_core.mem_scheduler_off()
                    return (
                        "Memory scheduler stopped" if success else "Failed to stop memory scheduler"
                    )
                else:
                    return "Invalid action. Use 'start' or 'stop'"
            except Exception as e:
                return f"Error controlling memory scheduler: {e!s}"

    def run(self, host: str = "localhost", port: int = 8000):
        """Run MCP server"""
        # 运行 HTTP 模式的 MCP 服务器
        asyncio.run(self.mcp.run_http_async(host=host, port=port))


# Usage example
if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv()
    os.environ["OPENAI_API_BASE"] = os.getenv("OPENAI_API_BASE")
    os.environ["OPENAI_API_KEY"] = os.getenv("OPENAI_API_KEY")
    os.environ["MOS_TEXT_MEM_TYPE"] = "general_text"  # "tree_text" need set neo4j

    # Create and run MCP server
    server = MOSMCPServer()
    server.run(host="0.0.0.0", port=9003)
