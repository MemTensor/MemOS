"""
Basic MemOS API router for core functionality.
This router provides basic CRUD operations for memories, users, and cubes.
"""

import traceback

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse

from memos.api.start_config import get_mos_instance
from memos.api.start_models import (
    ChatRequest,
    ChatResponse,
    ConfigRequest,
    ConfigResponse,
    CubeShare,
    MemCubeRegister,
    MemoryCreate,
    MemoryResponse,
    SearchRequest,
    SearchResponse,
    SimpleResponse,
    UserCreate,
    UserListResponse,
    UserResponse,
)
from memos.log import get_logger
from memos.mem_user.user_manager import UserRole


logger = get_logger(__name__)

router = APIRouter(tags=["Basic MemOS API"])


@router.post("/configure", summary="Configure MemOS", response_model=ConfigResponse)
async def set_config(config_request: ConfigRequest):
    """Set MemOS configuration with basic settings."""
    try:
        # Get current MOS instance
        mos = get_mos_instance()

        # Update configuration based on request
        if config_request.user_id is not None:
            mos.user_id = config_request.user_id
        if config_request.session_id is not None:
            mos.session_id = config_request.session_id
        if config_request.top_k is not None:
            mos.config.top_k = config_request.top_k
        if config_request.enable_textual_memory is not None:
            mos.config.enable_textual_memory = config_request.enable_textual_memory
        if config_request.enable_activation_memory is not None:
            mos.config.enable_activation_memory = config_request.enable_activation_memory

        return ConfigResponse(message="Configuration updated successfully")
    except Exception as err:
        logger.error(f"Failed to set configuration: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.post("/users", summary="Create a new user", response_model=UserResponse)
async def create_user(user_create: UserCreate):
    """Create a new user."""
    try:
        mos_instance = get_mos_instance()
        role = UserRole(user_create.role)
        user_id = mos_instance.create_user(
            user_id=user_create.user_id, role=role, user_name=user_create.user_name
        )
        return UserResponse(message="User created successfully", data={"user_id": user_id})
    except Exception as err:
        logger.error(f"Failed to create user: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.get("/users", summary="List all users", response_model=UserListResponse)
async def list_users():
    """List all active users."""
    try:
        mos_instance = get_mos_instance()
        users = mos_instance.list_users()
        return UserListResponse(message="Users retrieved successfully", data=users)
    except Exception as err:
        logger.error(f"Failed to list users: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.get("/users/me", summary="Get current user info", response_model=UserResponse)
async def get_user_info():
    """Get current user information including accessible cubes."""
    try:
        mos_instance = get_mos_instance()
        user_info = mos_instance.get_user_info()
        return UserResponse(message="User info retrieved successfully", data=user_info)
    except Exception as err:
        logger.error(f"Failed to get user info: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.post("/mem_cubes", summary="Register a MemCube", response_model=SimpleResponse)
async def register_mem_cube(mem_cube: MemCubeRegister):
    """Register a new MemCube."""
    try:
        mos_instance = get_mos_instance()
        mos_instance.register_mem_cube(
            mem_cube_name_or_path=mem_cube.mem_cube_name_or_path,
            mem_cube_id=mem_cube.mem_cube_id,
            user_id=mem_cube.user_id,
        )
        return SimpleResponse(message="MemCube registered successfully")
    except Exception as err:
        logger.error(f"Failed to register MemCube: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.delete(
    "/mem_cubes/{mem_cube_id}", summary="Unregister a MemCube", response_model=SimpleResponse
)
async def unregister_mem_cube(mem_cube_id: str, user_id: str | None = None):
    """Unregister a MemCube."""
    try:
        mos_instance = get_mos_instance()
        mos_instance.unregister_mem_cube(mem_cube_id=mem_cube_id, user_id=user_id)
        return SimpleResponse(message="MemCube unregistered successfully")
    except Exception as err:
        logger.error(f"Failed to unregister MemCube: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.post(
    "/mem_cubes/{cube_id}/share",
    summary="Share a cube with another user",
    response_model=SimpleResponse,
)
async def share_cube(cube_id: str, share_request: CubeShare):
    """Share a cube with another user."""
    try:
        mos_instance = get_mos_instance()
        success = mos_instance.share_cube_with_user(cube_id, share_request.target_user_id)
        if success:
            return SimpleResponse(message="Cube shared successfully")
        else:
            raise HTTPException(status_code=500, detail="Failed to share cube")
    except Exception as err:
        logger.error(f"Failed to share cube: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.post("/memories", summary="Create memories", response_model=SimpleResponse)
async def add_memory(memory_create: MemoryCreate):
    """Store new memories in a MemCube."""
    try:
        if not any([memory_create.messages, memory_create.memory_content, memory_create.doc_path]):
            raise HTTPException(
                status_code=400,
                detail="Either messages, memory_content, or doc_path must be provided",
            )

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
    except HTTPException:
        raise
    except Exception as err:
        logger.error(f"Failed to add memory: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.get("/memories", summary="Get all memories", response_model=MemoryResponse)
async def get_all_memories(
    mem_cube_id: str | None = None,
    user_id: str | None = None,
):
    """Retrieve all memories from a MemCube."""
    try:
        mos_instance = get_mos_instance()
        result = mos_instance.get_all(mem_cube_id=mem_cube_id, user_id=user_id)
        return MemoryResponse(message="Memories retrieved successfully", data=result)
    except Exception as err:
        logger.error(f"Failed to get memories: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.get(
    "/memories/{mem_cube_id}/{memory_id}", summary="Get a memory", response_model=MemoryResponse
)
async def get_memory(mem_cube_id: str, memory_id: str, user_id: str | None = None):
    """Retrieve a specific memory by ID from a MemCube."""
    try:
        mos_instance = get_mos_instance()
        result = mos_instance.get(mem_cube_id=mem_cube_id, memory_id=memory_id, user_id=user_id)
        return MemoryResponse(message="Memory retrieved successfully", data=result)
    except Exception as err:
        logger.error(f"Failed to get memory: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.post("/search", summary="Search memories", response_model=SearchResponse)
async def search_memories(search_req: SearchRequest):
    """Search for memories across MemCubes."""
    try:
        mos_instance = get_mos_instance()
        result = mos_instance.search(
            query=search_req.query,
            user_id=search_req.user_id,
            install_cube_ids=search_req.install_cube_ids,
        )
        return SearchResponse(message="Search completed successfully", data=result)
    except Exception as err:
        logger.error(f"Failed to search memories: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.put(
    "/memories/{mem_cube_id}/{memory_id}", summary="Update a memory", response_model=SimpleResponse
)
async def update_memory(
    mem_cube_id: str, memory_id: str, updated_memory: dict[str, Any], user_id: str | None = None
):
    """Update an existing memory in a MemCube."""
    try:
        mos_instance = get_mos_instance()
        mos_instance.update(
            mem_cube_id=mem_cube_id,
            memory_id=memory_id,
            text_memory_item=updated_memory,
            user_id=user_id,
        )
        return SimpleResponse(message="Memory updated successfully")
    except Exception as err:
        logger.error(f"Failed to update memory: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.delete(
    "/memories/{mem_cube_id}/{memory_id}", summary="Delete a memory", response_model=SimpleResponse
)
async def delete_memory(mem_cube_id: str, memory_id: str, user_id: str | None = None):
    """Delete a specific memory from a MemCube."""
    try:
        mos_instance = get_mos_instance()
        mos_instance.delete(mem_cube_id=mem_cube_id, memory_id=memory_id, user_id=user_id)
        return SimpleResponse(message="Memory deleted successfully")
    except Exception as err:
        logger.error(f"Failed to delete memory: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.delete(
    "/memories/{mem_cube_id}", summary="Delete all memories", response_model=SimpleResponse
)
async def delete_all_memories(mem_cube_id: str, user_id: str | None = None):
    """Delete all memories from a MemCube."""
    try:
        mos_instance = get_mos_instance()
        mos_instance.delete_all(mem_cube_id=mem_cube_id, user_id=user_id)
        return SimpleResponse(message="All memories deleted successfully")
    except Exception as err:
        logger.error(f"Failed to delete all memories: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.post("/chat", summary="Chat with MemOS", response_model=ChatResponse)
async def chat(chat_req: ChatRequest):
    """Chat with the MemOS system."""
    try:
        mos_instance = get_mos_instance()
        response = mos_instance.chat(query=chat_req.query, user_id=chat_req.user_id)
        if response is None:
            raise HTTPException(status_code=500, detail="No response generated")
        return ChatResponse(message="Chat response generated", data=response)
    except HTTPException:
        raise
    except Exception as err:
        logger.error(f"Failed to chat: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.get("/", summary="Redirect to the OpenAPI documentation", include_in_schema=False)
async def home():
    """Redirect to the OpenAPI documentation."""
    return RedirectResponse(url="/docs", status_code=307)
