import uuid

from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, Field

# Import message types from core types module
from memos.types import MessageDict


T = TypeVar("T")


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
    mem_cube_id: str | None = Field(None, description="Cube ID for registration")
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
    moscube: bool = Field(False, description="Whether to use MemOSCube")
    session_id: str | None = Field(None, description="Session ID for soft-filtering memories")


class ChatCompleteRequest(BaseRequest):
    """Request model for chat operations."""

    user_id: str = Field(..., description="User ID")
    query: str = Field(..., description="Chat query message")
    mem_cube_id: str | None = Field(None, description="Cube ID to use for chat")
    history: list[MessageDict] | None = Field(None, description="Chat history")
    internet_search: bool = Field(False, description="Whether to use internet search")
    moscube: bool = Field(False, description="Whether to use MemOSCube")
    base_prompt: str | None = Field(None, description="Base prompt to use for chat")
    top_k: int = Field(10, description="Number of results to return")
    threshold: float = Field(0.5, description="Threshold for filtering references")
    session_id: str | None = Field(None, description="Session ID for soft-filtering memories")


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
    session_id: str | None = Field(None, description="Session id")


class SearchRequest(BaseRequest):
    """Request model for searching memories."""

    user_id: str = Field(..., description="User ID")
    query: str = Field(..., description="Search query")
    mem_cube_id: str | None = Field(None, description="Cube ID to search in")
    top_k: int = Field(10, description="Number of results to return")
    session_id: str | None = Field(None, description="Session ID for soft-filtering memories")


class SuggestionRequest(BaseRequest):
    """Request model for getting suggestion queries."""

    user_id: str = Field(..., description="User ID")
    language: Literal["zh", "en"] = Field("zh", description="Language for suggestions")
    message: list[MessageDict] | None = Field(None, description="List of messages to store.")


# ─── MemOS Client Response Models ──────────────────────────────────────────────


class MessageDetail(BaseModel):
    """Individual message detail model based on actual API response."""

    model_config = {"extra": "allow"}


class MemoryDetail(BaseModel):
    """Individual memory detail model based on actual API response."""

    model_config = {"extra": "allow"}


class GetMessagesData(BaseModel):
    """Data model for get messages response based on actual API."""

    message_detail_list: list[MessageDetail] = Field(
        default_factory=list, alias="memory_detail_list", description="List of message details"
    )


class SearchMemoryData(BaseModel):
    """Data model for search memory response based on actual API."""

    memory_detail_list: list[MemoryDetail] = Field(
        default_factory=list, alias="memory_detail_list", description="List of memory details"
    )
    message_detail_list: list[MessageDetail] | None = Field(
        None, alias="message_detail_list", description="List of message details (usually None)"
    )


class AddMessageData(BaseModel):
    """Data model for add message response based on actual API."""

    success: bool = Field(..., description="Operation success status")


# ─── MemOS Response Models (Similar to OpenAI ChatCompletion) ──────────────────


class MemOSGetMessagesResponse(BaseModel):
    """Response model for get messages operation based on actual API."""

    code: int = Field(..., description="Response status code")
    message: str = Field(..., description="Response message")
    data: GetMessagesData = Field(..., description="Messages data")

    @property
    def messages(self) -> list[MessageDetail]:
        """Convenient access to message list."""
        return self.data.message_detail_list


class MemOSSearchResponse(BaseModel):
    """Response model for search memory operation based on actual API."""

    code: int = Field(..., description="Response status code")
    message: str = Field(..., description="Response message")
    data: SearchMemoryData = Field(..., description="Search results data")

    @property
    def memories(self) -> list[MemoryDetail]:
        """Convenient access to memory list."""
        return self.data.memory_detail_list


class MemOSAddResponse(BaseModel):
    """Response model for add message operation based on actual API."""

    code: int = Field(..., description="Response status code")
    message: str = Field(..., description="Response message")
    data: AddMessageData = Field(..., description="Add operation data")

    @property
    def success(self) -> bool:
        """Convenient access to success status."""
        return self.data.success
