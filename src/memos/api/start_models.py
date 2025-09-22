"""
Data models for the basic MemOS API endpoints.
"""

from typing import Generic, TypeVar

from pydantic import BaseModel, Field


T = TypeVar("T")


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
    role: str = Field("USER", description="Role of the user", json_schema_extra={"example": "USER"})
    user_id: str = Field(..., description="User ID", json_schema_extra={"example": "user123"})


class CubeShare(BaseRequest):
    target_user_id: str = Field(
        ..., description="Target user ID to share with", json_schema_extra={"example": "user456"}
    )


# Response models
class SimpleResponse(BaseResponse[None]):
    """Simple response model for operations without data return."""


class ConfigRequest(BaseModel):
    """Configuration request model for basic settings."""

    user_id: str | None = Field(None, description="User ID to configure")
    session_id: str | None = Field(None, description="Session ID to configure")
    top_k: int | None = Field(None, description="Top K memories to retrieve")
    enable_textual_memory: bool | None = Field(None, description="Enable textual memory")
    enable_activation_memory: bool | None = Field(None, description="Enable activation memory")


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
