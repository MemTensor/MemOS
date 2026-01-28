import asyncio
import os

from typing import Any

from dotenv import load_dotenv
from fastmcp import FastMCP

# Assuming these are your imports
from memos.mem_os.main import MOS
from memos.mem_os.utils.default_config import get_default
from memos.mem_user.user_manager import UserRole


load_dotenv()


def load_default_config(user_id="default_user"):
    """
    Load MOS configuration from environment variables.

    IMPORTANT for Neo4j Community Edition:
    Community Edition does not support administrative commands like 'CREATE DATABASE'.
    To avoid errors, ensure the following environment variables are set correctly:
    - NEO4J_DB_NAME=neo4j (Must use the default database)
    - NEO4J_AUTO_CREATE=false (Disable automatic database creation)
    - NEO4J_USE_MULTI_DB=false (Disable multi-tenant database mode)
    """
    # Define mapping between environment variables and configuration parameters
    # We support both clean names and MOS_ prefixed names for compatibility
    env_mapping = {
        "OPENAI_API_KEY": "openai_api_key",
        "OPENAI_API_BASE": "openai_api_base",
        "MOS_TEXT_MEM_TYPE": "text_mem_type",
        "NEO4J_URI": "neo4j_uri",
        "NEO4J_USER": "neo4j_user",
        "NEO4J_PASSWORD": "neo4j_password",
        "NEO4J_DB_NAME": "neo4j_db_name",
        "NEO4J_AUTO_CREATE": "neo4j_auto_create",
        "NEO4J_USE_MULTI_DB": "use_multi_db",
        "MOS_NEO4J_SHARED_DB": "mos_shared_db",  # Special handle later
        "MODEL_NAME": "model_name",
        "MOS_CHAT_MODEL": "model_name",
        "EMBEDDER_MODEL": "embedder_model",
        "MOS_EMBEDDER_MODEL": "embedder_model",
        "CHUNK_SIZE": "chunk_size",
        "CHUNK_OVERLAP": "chunk_overlap",
        "ENABLE_MEM_SCHEDULER": "enable_mem_scheduler",
        "MOS_ENABLE_SCHEDULER": "enable_mem_scheduler",
        "ENABLE_ACTIVATION_MEMORY": "enable_activation_memory",
        "TEMPERATURE": "temperature",
        "MOS_CHAT_TEMPERATURE": "temperature",
        "MAX_TOKENS": "max_tokens",
        "MOS_MAX_TOKENS": "max_tokens",
        "TOP_P": "top_p",
        "MOS_TOP_P": "top_p",
        "TOP_K": "top_k",
        "MOS_TOP_K": "top_k",
        "SCHEDULER_TOP_K": "scheduler_top_k",
        "MOS_SCHEDULER_TOP_K": "scheduler_top_k",
        "SCHEDULER_TOP_N": "scheduler_top_n",
    }

    # Fields that should always be kept as strings (not converted to numbers)
    string_only_fields = {
        "openai_api_key",
        "openai_api_base",
        "neo4j_uri",
        "neo4j_user",
        "neo4j_password",
        "neo4j_db_name",
        "text_mem_type",
        "model_name",
        "embedder_model",
    }

    kwargs = {"user_id": user_id}
    for env_key, param_key in env_mapping.items():
        val = os.getenv(env_key)
        if val is not None:
            # Strip quotes if they exist (sometimes happens with .env)
            if (val.startswith('"') and val.endswith('"')) or (
                val.startswith("'") and val.endswith("'")
            ):
                val = val[1:-1]

            # Handle boolean conversions
            if val.lower() in ("true", "false"):
                kwargs[param_key] = val.lower() == "true"
            # Keep certain fields as strings
            elif param_key in string_only_fields:
                kwargs[param_key] = val
            else:
                # Try numeric conversions (int first, then float)
                try:
                    if "." in val:
                        kwargs[param_key] = float(val)
                    else:
                        kwargs[param_key] = int(val)
                except ValueError:
                    kwargs[param_key] = val

    # Logic handle for MOS_NEO4J_SHARED_DB vs use_multi_db
    if "mos_shared_db" in kwargs:
        kwargs["use_multi_db"] = not kwargs.pop("mos_shared_db")

    # Extract mandatory or special params
    openai_api_key = kwargs.pop("openai_api_key", os.getenv("OPENAI_API_KEY"))
    openai_api_base = kwargs.pop("openai_api_base", "https://api.openai.com/v1")
    text_mem_type = kwargs.pop("text_mem_type", "tree_text")

    # Ensure embedder_model has a default value if not set
    if "embedder_model" not in kwargs:
        kwargs["embedder_model"] = os.getenv("EMBEDDER_MODEL", "nomic-embed-text:latest")

    config, cube = get_default(
        openai_api_key=openai_api_key,
        openai_api_base=openai_api_base,
        text_mem_type=text_mem_type,
        **kwargs,
    )
    return config, cube


class MOSMCPStdioServer:
    def __init__(self):
        self.mcp = FastMCP("MOS Memory System")
        config, cube = load_default_config()
        self.mos_core = MOS(config=config)
        self.mos_core.register_mem_cube(cube)
        self._setup_tools()


class MOSMCPServer:
    """MCP Server that accepts an existing MOS instance."""

    def __init__(self, mos_instance: MOS | None = None):
        self.mcp = FastMCP("MOS Memory System")
        if mos_instance is None:
            # Fall back to creating from default config
            config, cube = load_default_config()
            self.mos_core = MOS(config=config)
            self.mos_core.register_mem_cube(cube)
        else:
            self.mos_core = mos_instance
        self._setup_tools()

    def _setup_tools(self):
        """Setup MCP tools"""

        @self.mcp.tool()
        async def chat(query: str, user_id: str | None = None) -> str:
            """
            Chat with MOS system using memory-enhanced responses.

            This method provides intelligent responses by searching through user's memory cubes
            and incorporating relevant context. It supports both standard chat mode and enhanced
            Chain of Thought (CoT) mode for complex queries when PRO_MODE is enabled.

            Args:
                query (str): The user's query or question to be answered
                user_id (str, optional): User ID for the chat session. If not provided, uses the default user

            Returns:
                str: AI-generated response incorporating relevant memories and context
            """
            try:
                response = self.mos_core.chat(query, user_id)
                return response
            except Exception as e:
                import traceback

                error_details = traceback.format_exc()
                return f"Chat error: {e!s}\nTraceback:\n{error_details}"

        @self.mcp.tool()
        async def create_user(
            user_id: str, role: str = "USER", user_name: str | None = None
        ) -> str:
            """
            Create a new user in the MOS system.

            This method creates a new user account with specified role and name.
            Users can have different access levels and can own or access memory cubes.

            Args:
                user_id (str): Unique identifier for the user
                role (str): User role - "USER" for regular users, "ADMIN" for administrators
                user_name (str, optional): Display name for the user. If not provided, uses user_id

            Returns:
                str: Success message with the created user ID
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
            Create a new memory cube for a user.

            Memory cubes are containers that store different types of memories (textual, activation, parametric).
            Each cube can be owned by a user and shared with other users.

            Args:
                cube_name (str): Human-readable name for the memory cube
                owner_id (str): User ID of the cube owner who has full control
                cube_path (str, optional): File system path where cube data will be stored
                cube_id (str, optional): Custom unique identifier for the cube. If not provided, one will be generated

            Returns:
                str: Success message with the created cube ID
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
            Register an existing memory cube with the MOS system.

            This method loads and registers a memory cube from a file path or creates a new one
            if the path doesn't exist. The cube becomes available for memory operations.

            Args:
                cube_name_or_path (str): File path to the memory cube or name for a new cube
                cube_id (str, optional): Custom identifier for the cube. If not provided, one will be generated
                user_id (str, optional): User ID to associate with the cube. If not provided, uses default user

            Returns:
                str: Success message with the registered cube ID
            """
            try:
                if not os.path.exists(cube_name_or_path):
                    _, cube = load_default_config(user_id=user_id)
                    cube_to_register = cube
                else:
                    cube_to_register = cube_name_or_path
                self.mos_core.register_mem_cube(
                    cube_to_register, mem_cube_id=cube_id, user_id=user_id
                )
                return f"Cube registered successfully: {cube_id or cube_to_register}"
            except Exception as e:
                return f"Error registering cube: {e!s}"

        @self.mcp.tool()
        async def unregister_cube(cube_id: str, user_id: str | None = None) -> str:
            """
            Unregister a memory cube from the MOS system.

            This method removes a memory cube from the active session, making it unavailable
            for memory operations. The cube data remains intact on disk.

            Args:
                cube_id (str): Unique identifier of the cube to unregister
                user_id (str, optional): User ID for access validation. If not provided, uses default user

            Returns:
                str: Success message confirming the cube was unregistered
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
            Search for memories across user's accessible memory cubes.

            This method performs semantic search through textual memories stored in the specified
            cubes, returning relevant memories based on the query. Results are ranked by relevance.

            Args:
                query (str): Search query to find relevant memories
                user_id (str, optional): User ID whose cubes to search. If not provided, uses default user
                cube_ids (list[str], optional): Specific cube IDs to search. If not provided, searches all user's cubes

            Returns:
                dict: Search results containing text_mem, act_mem, and para_mem categories with relevant memories
            """
            try:
                result = self.mos_core.search(query, user_id, cube_ids)
                return result
            except Exception as e:
                import traceback

                error_details = traceback.format_exc()
                return {"error": str(e), "traceback": error_details}

        @self.mcp.tool()
        async def add_memory(
            memory_content: str | None = None,
            doc_path: str | None = None,
            messages: list[dict[str, str]] | None = None,
            cube_id: str | None = None,
            user_id: str | None = None,
        ) -> str:
            """
            Add memories to a memory cube.

            This method can add memories from different sources: direct text content, document files,
            or conversation messages. The memories are processed and stored in the specified cube.

            Args:
                memory_content (str, optional): Direct text content to add as memory
                doc_path (str, optional): Path to a document file to process and add as memories
                messages (list[dict[str, str]], optional): List of conversation messages to add as memories
                cube_id (str, optional): Target cube ID. If not provided, uses user's default cube
                user_id (str, optional): User ID for access validation. If not provided, uses default user

            Returns:
                str: Success message confirming memories were added
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
            Retrieve a specific memory from a memory cube.

            This method fetches a single memory item by its unique identifier from the specified cube.

            Args:
                cube_id (str): Unique identifier of the cube containing the memory
                memory_id (str): Unique identifier of the specific memory to retrieve
                user_id (str, optional): User ID for access validation. If not provided, uses default user

            Returns:
                dict: Memory content with metadata including memory text, creation time, and source
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
            Update an existing memory in a memory cube.

            This method modifies the content of a specific memory while preserving its metadata.
            Note: Update functionality may not be supported by all memory backends (e.g., tree_text).

            Args:
                cube_id (str): Unique identifier of the cube containing the memory
                memory_id (str): Unique identifier of the memory to update
                memory_content (str): New content to replace the existing memory
                user_id (str, optional): User ID for access validation. If not provided, uses default user

            Returns:
                str: Success message confirming the memory was updated
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
            Delete a specific memory from a memory cube.

            This method permanently removes a memory item from the specified cube.
            The operation cannot be undone.

            Args:
                cube_id (str): Unique identifier of the cube containing the memory
                memory_id (str): Unique identifier of the memory to delete
                user_id (str, optional): User ID for access validation. If not provided, uses default user

            Returns:
                str: Success message confirming the memory was deleted
            """
            try:
                self.mos_core.delete(cube_id, memory_id, user_id)
                return f"Memory deleted successfully: {memory_id}"
            except Exception as e:
                return f"Error deleting memory: {e!s}"

        @self.mcp.tool()
        async def delete_all_memories(cube_id: str, user_id: str | None = None) -> str:
            """
            Delete all memories from a memory cube.

            This method permanently removes all memory items from the specified cube.
            The operation cannot be undone and will clear all textual memories.

            Args:
                cube_id (str): Unique identifier of the cube to clear
                user_id (str, optional): User ID for access validation. If not provided, uses default user

            Returns:
                str: Success message confirming all memories were deleted
            """
            try:
                self.mos_core.delete_all(cube_id, user_id)
                return f"All memories deleted successfully from cube: {cube_id}"
            except Exception as e:
                return f"Error deleting all memories: {e!s}"

        @self.mcp.tool()
        async def clear_chat_history(user_id: str | None = None) -> str:
            """
            Clear the chat history for a user.

            This method resets the conversation history, removing all previous messages
            while keeping the memory cubes and stored memories intact.

            Args:
                user_id (str, optional): User ID whose chat history to clear. If not provided, uses default user

            Returns:
                str: Success message confirming chat history was cleared
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
            Export a memory cube to a directory.

            This method creates a backup or export of a memory cube, including all memories
            and metadata, to the specified directory for backup or migration purposes.

            Args:
                dump_dir (str): Directory path where the cube data will be exported
                user_id (str, optional): User ID for access validation. If not provided, uses default user
                cube_id (str, optional): Cube ID to export. If not provided, uses user's default cube

            Returns:
                str: Success message with the export directory path
            """
            try:
                self.mos_core.dump(dump_dir, user_id, cube_id)
                return f"Cube dumped successfully to: {dump_dir}"
            except Exception as e:
                return f"Error dumping cube: {e!s}"

        @self.mcp.tool()
        async def share_cube(cube_id: str, target_user_id: str) -> str:
            """
            Share a memory cube with another user.

            This method grants access to a memory cube to another user, allowing them
            to read and search through the memories stored in that cube.

            Args:
                cube_id (str): Unique identifier of the cube to share
                target_user_id (str): User ID of the person to share the cube with

            Returns:
                str: Success message confirming the cube was shared or error message if failed
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
            Get detailed information about a user and their accessible memory cubes.

            This method returns comprehensive user information including profile details,
            role, creation time, and a list of all memory cubes the user can access.

            Args:
                user_id (str, optional): User ID to get information for. If not provided, uses current user

            Returns:
                dict: User information including user_id, user_name, role, created_at, and accessible_cubes
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
            Control the memory scheduler service.

            The memory scheduler is responsible for processing and organizing memories
            in the background. This method allows starting or stopping the scheduler service.

            Args:
                action (str): Action to perform - "start" to enable the scheduler, "stop" to disable it

            Returns:
                str: Success message confirming the scheduler action or error message if failed
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


def _run_mcp(self, transport: str = "stdio", **kwargs):
    if transport == "stdio":
        self.mcp.run(transport="stdio")
    elif transport == "http":
        host = kwargs.get("host", "localhost")
        port = kwargs.get("port", 8000)
        asyncio.run(self.mcp.run_http_async(host=host, port=port))
    elif transport == "sse":
        host = kwargs.get("host", "localhost")
        port = kwargs.get("port", 8000)
        self.mcp.run(transport="sse", host=host, port=port)
    else:
        raise ValueError(f"Unsupported transport: {transport}")


MOSMCPStdioServer.run = _run_mcp
MOSMCPServer.run = _run_mcp


# Usage example
if __name__ == "__main__":
    import argparse

    from dotenv import load_dotenv

    load_dotenv()

    # Parse command line arguments
    parser = argparse.ArgumentParser(description="MOS MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "http", "sse"],
        default="stdio",
        help="Transport method (default: stdio)",
    )
    parser.add_argument("--host", default="localhost", help="Host for HTTP/SSE transport")
    parser.add_argument("--port", type=int, default=8000, help="Port for HTTP/SSE transport")

    args = parser.parse_args()

    # Create and run MCP server
    server = MOSMCPStdioServer()
    server.run(transport=args.transport, host=args.host, port=args.port)
