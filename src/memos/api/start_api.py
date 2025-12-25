import logging
import os

from typing import Any, Generic, TypeVar

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.requests import Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from memos.api.middleware.request_context import RequestContextMiddleware
from memos.configs.mem_os import MOSConfig
from memos.mem_os.main import MOS
from memos.mem_user.user_manager import UserManager, UserRole


# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()

T = TypeVar("T")

# Default configuration
DEFAULT_CONFIG = {
    "user_id": os.getenv("MOS_USER_ID", "default_user"),
    "session_id": os.getenv("MOS_SESSION_ID", "default_session"),
    "enable_textual_memory": True,
    "enable_activation_memory": False,
    "top_k": int(os.getenv("MOS_TOP_K", "5")),
    "chat_model": {
        "backend": os.getenv("MOS_CHAT_MODEL_PROVIDER", "openai"),
        "config": {
            "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "gpt-3.5-turbo"),
            "api_key": os.getenv("OPENAI_API_KEY", "apikey"),
            "temperature": float(os.getenv("MOS_CHAT_TEMPERATURE", "0.7")),
            "api_base": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
        },
    },
}

# Initialize MOS instance with lazy initialization
MOS_INSTANCE = None


def get_mos_instance():
    """Get or create MOS instance with default user creation."""
    global MOS_INSTANCE
    if MOS_INSTANCE is None:
        # Create a temporary MOS instance to access user manager
        temp_config = MOSConfig(**DEFAULT_CONFIG)
        temp_mos = MOS.__new__(MOS)
        temp_mos.config = temp_config
        temp_mos.user_id = temp_config.user_id
        temp_mos.session_id = temp_config.session_id
        temp_mos.mem_cubes = {}
        temp_mos.chat_llm = None  # Will be initialized later
        temp_mos.user_manager = UserManager()

        # Create default user if it doesn't exist
        if not temp_mos.user_manager.validate_user(temp_config.user_id):
            temp_mos.user_manager.create_user(
                user_name=temp_config.user_id, role=UserRole.USER, user_id=temp_config.user_id
            )
            logger.info(f"Created default user: {temp_config.user_id}")

        # Now create the actual MOS instance
        MOS_INSTANCE = MOS(config=temp_config)

    return MOS_INSTANCE


app = FastAPI(
    title="MemOS REST APIs",
    description="A REST API for managing and searching memories using MemOS.",
    version="1.0.0",
)

app.add_middleware(RequestContextMiddleware)


class BaseRequest(BaseModel):
    """Base model for all requests."""

    user_id: str | None = Field(
        None, description="User ID for the request", json_schema_extra={"example": "user123"}
    )


class BaseResponse(BaseModel, Generic[T]):
    """Base model for all responses."""

    code: int = Field(200, description="Response status code", json_schema_extra={"example": 200})
    message: str = Field(
        ..., description="Response message", json_schema_extra={"example": "Operation successful"}
    )
    data: T | None = Field(None, description="Response data")


class Message(BaseModel):
    role: str = Field(
        ...,
        description="Role of the message (user or assistant).",
        json_schema_extra={"example": "user"},
    )
    content: str = Field(
        ...,
        description="Message content.",
        json_schema_extra={"example": "Hello, how can I help you?"},
    )


class MemoryCreate(BaseRequest):
    messages: list[Message] | None = Field(
        None,
        description="List of messages to store.",
        json_schema_extra={"example": [{"role": "user", "content": "Hello"}]},
    )
    mem_cube_id: str | None = Field(
        None, description="ID of the memory cube", json_schema_extra={"example": "cube123"}
    )
    memory_content: str | None = Field(
        None,
        description="Content to store as memory",
        json_schema_extra={"example": "This is a memory content"},
    )
    doc_path: str | None = Field(
        None,
        description="Path to document to store",
        json_schema_extra={"example": "/path/to/document.txt"},
    )


class SearchRequest(BaseRequest):
    query: str = Field(
        ...,
        description="Search query.",
        json_schema_extra={"example": "How to implement a feature?"},
    )
    install_cube_ids: list[str] | None = Field(
        None,
        description="List of cube IDs to search in",
        json_schema_extra={"example": ["cube123", "cube456"]},
    )


class MemCubeRegister(BaseRequest):
    mem_cube_name_or_path: str = Field(
        ...,
        description="Name or path of the MemCube to register.",
        json_schema_extra={"example": "/path/to/cube"},
    )
    mem_cube_id: str | None = Field(
        None, description="ID for the MemCube", json_schema_extra={"example": "cube123"}
    )


class ChatRequest(BaseRequest):
    query: str = Field(
        ...,
        description="Chat query message.",
        json_schema_extra={"example": "What is the latest update?"},
    )


class UserCreate(BaseRequest):
    user_name: str | None = Field(
        None, description="Name of the user", json_schema_extra={"example": "john_doe"}
    )
    role: str = Field("user", description="Role of the user", json_schema_extra={"example": "user"})
    user_id: str = Field(..., description="User ID", json_schema_extra={"example": "user123"})


class CubeShare(BaseRequest):
    target_user_id: str = Field(
        ..., description="Target user ID to share with", json_schema_extra={"example": "user456"}
    )


class SimpleResponse(BaseResponse[None]):
    """Simple response model for operations without data return."""


class ConfigResponse(BaseResponse[None]):
    """Response model for configuration endpoint."""


class MemoryResponse(BaseResponse[dict]):
    """Response model for memory operations."""


class SearchResponse(BaseResponse[dict]):
    """Response model for search operations."""


class ChatResponse(BaseResponse[str]):
    """Response model for chat operations."""


class UserResponse(BaseResponse[dict]):
    """Response model for user operations."""


class UserListResponse(BaseResponse[list]):
    """Response model for user list operations."""


@app.post("/configure", summary="Configure MemOS", response_model=ConfigResponse)
async def set_config(config: MOSConfig):
    """Set MemOS configuration."""
    global MOS_INSTANCE

    # Create a temporary user manager to check/create default user
    temp_user_manager = UserManager()

    # Create default user if it doesn't exist
    if not temp_user_manager.validate_user(config.user_id):
        temp_user_manager.create_user(
            user_name=config.user_id, role=UserRole.USER, user_id=config.user_id
        )
        logger.info(f"Created default user: {config.user_id}")

    # Now create the MOS instance
    MOS_INSTANCE = MOS(config=config)
    return ConfigResponse(message="Configuration set successfully")


@app.post("/users", summary="Create a new user", response_model=UserResponse)
async def create_user(user_create: UserCreate):
    """Create a new user."""
    mos_instance = get_mos_instance()
    role = UserRole(user_create.role)
    user_id = mos_instance.create_user(
        user_id=user_create.user_id, role=role, user_name=user_create.user_name
    )
    return UserResponse(message="User created successfully", data={"user_id": user_id})


@app.get("/users", summary="List all users", response_model=UserListResponse)
async def list_users():
    """List all active users."""
    mos_instance = get_mos_instance()
    users = mos_instance.list_users()
    return UserListResponse(message="Users retrieved successfully", data=users)


@app.get("/users/me", summary="Get current user info", response_model=UserResponse)
async def get_user_info():
    """Get current user information including accessible cubes."""
    mos_instance = get_mos_instance()
    user_info = mos_instance.get_user_info()
    return UserResponse(message="User info retrieved successfully", data=user_info)


@app.post("/mem_cubes", summary="Register a MemCube", response_model=SimpleResponse)
async def register_mem_cube(mem_cube: MemCubeRegister):
    """Register a new MemCube."""
    mos_instance = get_mos_instance()
    mos_instance.register_mem_cube(
        mem_cube_name_or_path=mem_cube.mem_cube_name_or_path,
        mem_cube_id=mem_cube.mem_cube_id,
        user_id=mem_cube.user_id,
    )
    return SimpleResponse(message="MemCube registered successfully")


@app.delete(
    "/mem_cubes/{mem_cube_id}", summary="Unregister a MemCube", response_model=SimpleResponse
)
async def unregister_mem_cube(mem_cube_id: str, user_id: str | None = None):
    """Unregister a MemCube."""
    mos_instance = get_mos_instance()
    mos_instance.unregister_mem_cube(mem_cube_id=mem_cube_id, user_id=user_id)
    return SimpleResponse(message="MemCube unregistered successfully")


@app.post(
    "/mem_cubes/{cube_id}/share",
    summary="Share a cube with another user",
    response_model=SimpleResponse,
)
async def share_cube(cube_id: str, share_request: CubeShare):
    """Share a cube with another user."""
    mos_instance = get_mos_instance()
    success = mos_instance.share_cube_with_user(cube_id, share_request.target_user_id)
    if success:
        return SimpleResponse(message="Cube shared successfully")
    else:
        raise ValueError("Failed to share cube")


@app.post("/memories", summary="Create memories", response_model=SimpleResponse)
async def add_memory(memory_create: MemoryCreate):
    """Store new memories in a MemCube."""
    if not any([memory_create.messages, memory_create.memory_content, memory_create.doc_path]):
        raise ValueError("Either messages, memory_content, or doc_path must be provided")
    mos_instance = get_mos_instance()
    if memory_create.messages:
        messages = [m.model_dump() for m in memory_create.messages]
        mos_instance.add(
            messages=messages,
            mem_cube_id=memory_create.mem_cube_id,
            user_id=memory_create.user_id,
        )
    elif memory_create.memory_content:
        mos_instance.add(
            memory_content=memory_create.memory_content,
            mem_cube_id=memory_create.mem_cube_id,
            user_id=memory_create.user_id,
        )
    elif memory_create.doc_path:
        mos_instance.add(
            doc_path=memory_create.doc_path,
            mem_cube_id=memory_create.mem_cube_id,
            user_id=memory_create.user_id,
        )
    return SimpleResponse(message="Memories added successfully")


@app.get("/memories", summary="Get all memories", response_model=MemoryResponse)
async def get_all_memories(
    mem_cube_id: str | None = None,
    user_id: str | None = None,
):
    """Retrieve all memories from a MemCube."""
    mos_instance = get_mos_instance()
    result = mos_instance.get_all(mem_cube_id=mem_cube_id, user_id=user_id)
    return MemoryResponse(message="Memories retrieved successfully", data=result)


@app.get(
    "/memories/{mem_cube_id}/{memory_id}", summary="Get a memory", response_model=MemoryResponse
)
async def get_memory(mem_cube_id: str, memory_id: str, user_id: str | None = None):
    """Retrieve a specific memory by ID from a MemCube."""
    mos_instance = get_mos_instance()
    result = mos_instance.get(mem_cube_id=mem_cube_id, memory_id=memory_id, user_id=user_id)
    return MemoryResponse(message="Memory retrieved successfully", data=result)


@app.post("/search", summary="Search memories", response_model=SearchResponse)
async def search_memories(search_req: SearchRequest):
    """Search for memories across MemCubes."""
    mos_instance = get_mos_instance()
    result = mos_instance.search(
        query=search_req.query,
        user_id=search_req.user_id,
        install_cube_ids=search_req.install_cube_ids,
    )
    return SearchResponse(message="Search completed successfully", data=result)


@app.put(
    "/memories/{mem_cube_id}/{memory_id}", summary="Update a memory", response_model=SimpleResponse
)
async def update_memory(
    mem_cube_id: str, memory_id: str, updated_memory: dict[str, Any], user_id: str | None = None
):
    """Update an existing memory in a MemCube."""
    mos_instance = get_mos_instance()
    mos_instance.update(
        mem_cube_id=mem_cube_id,
        memory_id=memory_id,
        text_memory_item=updated_memory,
        user_id=user_id,
    )
    return SimpleResponse(message="Memory updated successfully")


@app.delete(
    "/memories/{mem_cube_id}/{memory_id}", summary="Delete a memory", response_model=SimpleResponse
)
async def delete_memory(mem_cube_id: str, memory_id: str, user_id: str | None = None):
    """Delete a specific memory from a MemCube."""
    mos_instance = get_mos_instance()
    mos_instance.delete(mem_cube_id=mem_cube_id, memory_id=memory_id, user_id=user_id)
    return SimpleResponse(message="Memory deleted successfully")


@app.delete("/memories/{mem_cube_id}", summary="Delete all memories", response_model=SimpleResponse)
async def delete_all_memories(mem_cube_id: str, user_id: str | None = None):
    """Delete all memories from a MemCube."""
    mos_instance = get_mos_instance()
    mos_instance.delete_all(mem_cube_id=mem_cube_id, user_id=user_id)
    return SimpleResponse(message="All memories deleted successfully")


@app.post("/chat", summary="Chat with MemOS", response_model=ChatResponse)
async def chat(chat_req: ChatRequest):
    """Chat with the MemOS system."""
    mos_instance = get_mos_instance()
    response = mos_instance.chat(query=chat_req.query, user_id=chat_req.user_id)
    if response is None:
        raise ValueError("No response generated")
    return ChatResponse(message="Chat response generated", data=response)


@app.get("/", summary="Redirect to the OpenAPI documentation", include_in_schema=False)
async def home():
    """Redirect to the OpenAPI documentation."""
    return RedirectResponse(url="/docs", status_code=307)


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    """Handle ValueError exceptions globally."""
    return JSONResponse(
        status_code=400,
        content={"code": 400, "message": str(exc), "data": None},
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Handle all unhandled exceptions globally."""
    logger.exception("Unhandled error:")
    return JSONResponse(
        status_code=500,
        content={"code": 500, "message": str(exc), "data": None},
    )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000, help="Port to run the server on")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to run the server on")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    args = parser.parse_args()
