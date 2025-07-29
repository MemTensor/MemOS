import uuid

from typing import Generic, Literal, TypeAlias, TypeVar

from pydantic import BaseModel, Field
from typing_extensions import TypedDict


T = TypeVar("T")


# ─── Message Types ──────────────────────────────────────────────────────────────

# Chat message roles
MessageRole: TypeAlias = Literal["user", "assistant", "system"]


# Message structure
class MessageDict(TypedDict):
    """Typed dictionary for chat message dictionaries."""

    role: MessageRole
    content: str


class BaseRequest(BaseModel):
    """Base model for all requests."""


class BaseResponse(BaseModel, Generic[T]):
    """Base model for all responses."""

    code: int = Field(200, description="Response status code")
    message: str = Field(..., description="Response message")
    data: T | None = Field(None, description="Response data")


# Product API Models
class UserRegisterRequest(BaseRequest):
    """Request model for user registration."""

    user_id: str = Field(
        default_factory=lambda: str(uuid.uuid4()), description="User ID for registration"
    )
    user_name: str | None = Field(None, description="User name for registration")
    interests: str | None = Field(None, description="User interests")


class GetMemoryRequest(BaseRequest):
    """Request model for getting memories."""

    user_id: str = Field(..., description="User ID")
    memory_type: Literal["text_mem", "act_mem", "param_mem", "para_mem"] = Field(
        ..., description="Memory type"
    )
    mem_cube_ids: list[str] | None = Field(None, description="Cube IDs")
    search_query: str | None = Field(None, description="Search query")


# Start API Models
class Message(BaseModel):
    role: str = Field(..., description="Role of the message (user or assistant).")
    content: str = Field(..., description="Message content.")


class MemoryCreate(BaseRequest):
    user_id: str = Field(..., description="User ID")
    messages: list[Message] | None = Field(None, description="List of messages to store.")
    memory_content: str | None = Field(None, description="Content to store as memory")
    doc_path: str | None = Field(None, description="Path to document to store")
    mem_cube_id: str | None = Field(None, description="ID of the memory cube")


class MemCubeRegister(BaseRequest):
    mem_cube_name_or_path: str = Field(..., description="Name or path of the MemCube to register.")
    mem_cube_id: str | None = Field(None, description="ID for the MemCube")


class ChatRequest(BaseRequest):
    """Request model for chat operations."""

    user_id: str = Field(..., description="User ID")
    query: str = Field(..., description="Chat query message")
    mem_cube_id: str | None = Field(None, description="Cube ID to use for chat")
    history: list[MessageDict] | None = Field(None, description="Chat history")
    internet_search: bool = Field(True, description="Whether to use internet search")


class UserCreate(BaseRequest):
    user_name: str | None = Field(None, description="Name of the user")
    role: str = Field("USER", description="Role of the user")
    user_id: str = Field(..., description="User ID")


class CubeShare(BaseRequest):
    target_user_id: str = Field(..., description="Target user ID to share with")


# Response Models
class SimpleResponse(BaseResponse[None]):
    """Simple response model for operations without data return."""


class UserRegisterResponse(BaseResponse[dict]):
    """Response model for user registration."""


class MemoryResponse(BaseResponse[list]):
    """Response model for memory operations."""


class SuggestionResponse(BaseResponse[list]):
    """Response model for suggestion operations."""

    data: dict[str, list[str]] | None = Field(None, description="Response data")


class ConfigResponse(BaseResponse[None]):
    """Response model for configuration endpoint."""


class SearchResponse(BaseResponse[dict]):
    """Response model for search operations."""


class ChatResponse(BaseResponse[str]):
    """Response model for chat operations."""


class UserResponse(BaseResponse[dict]):
    """Response model for user operations."""


class UserListResponse(BaseResponse[list]):
    """Response model for user list operations."""


class MemoryCreateRequest(BaseRequest):
    """Request model for creating memories."""

    user_id: str = Field(..., description="User ID")
    messages: list[MessageDict] | None = Field(None, description="List of messages to store.")
    memory_content: str | None = Field(None, description="Memory content to store")
    doc_path: str | None = Field(None, description="Path to document to store")
    mem_cube_id: str | None = Field(None, description="Cube ID")
    source: str | None = Field(None, description="Source of the memory")
    user_profile: bool = Field(False, description="User profile memory")


class SearchRequest(BaseRequest):
    """Request model for searching memories."""

    user_id: str = Field(..., description="User ID")
    query: str = Field(..., description="Search query")
    mem_cube_id: str | None = Field(None, description="Cube ID to search in")
    top_k: int = Field(10, description="Number of results to return")


class SuggestionRequest(BaseRequest):
    """Request model for getting suggestion queries."""

    user_id: str = Field(..., description="User ID")
    language: Literal["zh", "en"] = Field("zh", description="Language for suggestions")
