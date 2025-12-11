import uuid

from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, Field, model_validator

# Import message types from core types module
from memos.log import get_logger
from memos.types import MessageList, MessagesType, PermissionDict, SearchMode


logger = get_logger(__name__)
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


class GetMemoryPlaygroundRequest(BaseRequest):
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
    messages: MessageList | None = Field(None, description="List of messages to store.")
    memory_content: str | None = Field(None, description="Content to store as memory")
    doc_path: str | None = Field(None, description="Path to document to store")
    mem_cube_id: str | None = Field(None, description="ID of the memory cube")


class MemCubeRegister(BaseRequest):
    mem_cube_name_or_path: str = Field(..., description="Name or path of the MemCube to register.")
    mem_cube_id: str | None = Field(None, description="ID for the MemCube")


class ChatRequest(BaseRequest):
    """Request model for chat operations.

    This model is used as the algorithm-facing chat interface, while also
    remaining backward compatible with older developer-facing APIs.
    """

    # ==== Basic identifiers ====
    user_id: str = Field(..., description="User ID")
    query: str = Field(..., description="Chat query message")
    readable_cube_ids: list[str] | None = Field(
        None, description="List of cube IDs user can read for multi-cube chat"
    )
    writable_cube_ids: list[str] | None = Field(
        None, description="List of cube IDs user can write for multi-cube chat"
    )
    history: MessageList | None = Field(None, description="Chat history")
    mode: SearchMode = Field(SearchMode.FAST, description="search mode: fast, fine, or mixture")
    system_prompt: str | None = Field(None, description="Base system prompt to use for chat")
    top_k: int = Field(10, description="Number of results to return")
    session_id: str | None = Field(None, description="Session ID for soft-filtering memories")
    include_preference: bool = Field(True, description="Whether to handle preference memory")
    pref_top_k: int = Field(6, description="Number of preference results to return")
    model_name_or_path: str | None = Field(None, description="Model name to use for chat")
    max_tokens: int | None = Field(None, description="Max tokens to generate")
    temperature: float | None = Field(None, description="Temperature for sampling")
    top_p: float | None = Field(None, description="Top-p (nucleus) sampling parameter")
    add_message_on_answer: bool = Field(True, description="Add dialogs to memory after chat")

    # ==== Filter conditions ====
    filter: dict[str, Any] | None = Field(
        None,
        description="""
        Filter for the memory, example:
        {
            "`and` or `or`": [
                {"id": "uuid-xxx"},
                {"created_at": {"gt": "2024-01-01"}},
            ]
        }
        """,
    )

    # ==== Extended capabilities ====
    internet_search: bool = Field(False, description="Whether to use internet search")
    threshold: float = Field(0.5, description="Threshold for filtering references")

    # ==== Backward compatibility ====
    moscube: bool = Field(
        False,
        description="(Deprecated) Whether to use legacy MemOSCube pipeline.",
    )

    mem_cube_id: str | None = Field(
        None,
        description=(
            "(Deprecated) Single cube ID to use for chat. "
            "Prefer `readable_cube_ids` / `writable_cube_ids` for multi-cube chat."
        ),
    )

    @model_validator(mode="after")
    def _convert_deprecated_fields(self):
        """
        Normalize fields for algorithm interface while preserving backward compatibility.

        Rules:
        - mem_cube_id → readable_cube_ids / writable_cube_ids if they are missing
        - moscube: log warning when True (deprecated)
        """

        # ---- mem_cube_id backward compatibility ----
        if self.mem_cube_id is not None:
            logger.warning(
                "ChatRequest.mem_cube_id is deprecated and will be removed in a future version. "
                "Please migrate to `readable_cube_ids` / `writable_cube_ids`."
            )
            if not self.readable_cube_ids:
                self.readable_cube_ids = [self.mem_cube_id]
            if not self.writable_cube_ids:
                self.writable_cube_ids = [self.mem_cube_id]

        # ---- Deprecated moscube flag ----
        if self.moscube:
            logger.warning(
                "ChatRequest.moscube is deprecated. Legacy MemOSCube pipeline "
                "will be removed in a future version."
            )

        return self


class ChatPlaygroundRequest(ChatRequest):
    """Request model for chat operations in playground."""

    beginner_guide_step: str | None = Field(
        None, description="Whether to use beginner guide, option: [first, second]"
    )


class ChatCompleteRequest(BaseRequest):
    """Request model for chat operations. will (Deprecated), instead use APIChatCompleteRequest."""

    user_id: str = Field(..., description="User ID")
    query: str = Field(..., description="Chat query message")
    mem_cube_id: str | None = Field(None, description="Cube ID to use for chat")
    history: MessageList | None = Field(None, description="Chat history")
    internet_search: bool = Field(False, description="Whether to use internet search")
    system_prompt: str | None = Field(None, description="Base prompt to use for chat")
    top_k: int = Field(10, description="Number of results to return")
    threshold: float = Field(0.5, description="Threshold for filtering references")
    session_id: str | None = Field(None, description="Session ID for soft-filtering memories")
    include_preference: bool = Field(True, description="Whether to handle preference memory")
    pref_top_k: int = Field(6, description="Number of preference results to return")
    filter: dict[str, Any] | None = Field(None, description="Filter for the memory")
    model_name_or_path: str | None = Field(None, description="Model name to use for chat")
    max_tokens: int | None = Field(None, description="Max tokens to generate")
    temperature: float | None = Field(None, description="Temperature for sampling")
    top_p: float | None = Field(None, description="Top-p (nucleus) sampling parameter")
    add_message_on_answer: bool = Field(True, description="Add dialogs to memory after chat")

    base_prompt: str | None = Field(None, description="(Deprecated) Base prompt alias")
    moscube: bool = Field(
        False, description="(Deprecated) Whether to use legacy MemOSCube pipeline"
    )


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


class AddStatusResponse(BaseResponse[dict]):
    """Response model for add status operations."""


class ConfigResponse(BaseResponse[None]):
    """Response model for configuration endpoint."""


class SearchResponse(BaseResponse[dict]):
    """Response model for search operations."""


class ChatResponse(BaseResponse[str]):
    """Response model for chat operations."""


class GetMemoryResponse(BaseResponse[dict]):
    """Response model for getting memories."""


class DeleteMemoryResponse(BaseResponse[dict]):
    """Response model for deleting memories."""


class UserResponse(BaseResponse[dict]):
    """Response model for user operations."""


class UserListResponse(BaseResponse[list]):
    """Response model for user list operations."""


class MemoryCreateRequest(BaseRequest):
    """Request model for creating memories."""

    user_id: str = Field(..., description="User ID")
    messages: str | MessagesType | None = Field(None, description="List of messages to store.")
    memory_content: str | None = Field(None, description="Memory content to store")
    doc_path: str | None = Field(None, description="Path to document to store")
    mem_cube_id: str | None = Field(None, description="Cube ID")
    source: str | None = Field(None, description="Source of the memory")
    user_profile: bool = Field(False, description="User profile memory")
    session_id: str | None = Field(None, description="Session id")
    task_id: str | None = Field(None, description="Task ID for monitoring async tasks")


class SearchRequest(BaseRequest):
    """Request model for searching memories."""

    user_id: str = Field(..., description="User ID")
    query: str = Field(..., description="Search query")
    mem_cube_id: str | None = Field(None, description="Cube ID to search in")
    top_k: int = Field(10, description="Number of results to return")
    session_id: str | None = Field(None, description="Session ID for soft-filtering memories")


class APISearchRequest(BaseRequest):
    """Request model for searching memories."""

    # ==== Basic inputs ====
    query: str = Field(
        ...,
        description="User search query",
    )
    user_id: str = Field(..., description="User ID")

    # ==== Cube scoping ====
    readable_cube_ids: list[str] | None = Field(
        None,
        description=(
            "List of cube IDs that are readable for this request. "
            "Required for algorithm-facing API; optional for developer-facing API."
        ),
    )

    # ==== Search mode ====
    mode: SearchMode = Field(
        SearchMode.FAST,
        description="Search mode: fast, fine, or mixture.",
    )

    session_id: str | None = Field(
        None,
        description=(
            "Session ID used as a soft signal to prioritize more relevant memories. "
            "Only used for weighting, not as a hard filter."
        ),
    )

    # ==== Result control ====
    top_k: int = Field(
        10,
        ge=1,
        description="Number of textual memories to retrieve (top-K). Default: 10.",
    )

    pref_top_k: int = Field(
        6,
        ge=0,
        description="Number of preference memories to retrieve (top-K). Default: 6.",
    )

    include_preference: bool = Field(
        True,
        description=(
            "Whether to retrieve preference memories along with general memories. "
            "If enabled, the system will automatically recall user preferences "
            "relevant to the query. Default: True."
        ),
    )

    search_tool_memory: bool = Field(
        True,
        description=(
            "Whether to retrieve tool memories along with general memories. "
            "If enabled, the system will automatically recall tool memories "
            "relevant to the query. Default: True."
        ),
    )

    tool_mem_top_k: int = Field(
        6,
        ge=0,
        description="Number of tool memories to retrieve (top-K). Default: 6.",
    )

    # ==== Filter conditions ====
    # TODO: maybe add detailed description later
    filter: dict[str, Any] | None = Field(
        None,
        description="""
        Filter for the memory, example:
        {
            "`and` or `or`": [
                {"id": "uuid-xxx"},
                {"created_at": {"gt": "2024-01-01"}},
            ]
        }
        """,
    )

    # ==== Extended capabilities ====
    internet_search: bool = Field(
        False,
        description=(
            "Whether to enable internet search in addition to memory search. "
            "Primarily used by internal algorithms. Default: False."
        ),
    )

    # Inner user, not supported in API yet
    threshold: float | None = Field(
        None,
        description=(
            "Internal similarity threshold for searching plaintext memories. "
            "If None, default thresholds will be applied."
        ),
    )
    # Internal field for search memory type
    search_memory_type: str = Field(
        "All",
        description="Type of memory to search: All, WorkingMemory, LongTermMemory, UserMemory, OuterMemory, ToolSchemaMemory, ToolTrajectoryMemory",
    )

    # ==== Context ====
    chat_history: MessageList | None = Field(
        None,
        description=(
            "Historical chat messages used internally by algorithms. "
            "If None, internal stored history may be used; "
            "if provided (even an empty list), this value will be used as-is."
        ),
    )

    # ==== Backward compatibility ====
    mem_cube_id: str | None = Field(
        None,
        description=(
            "(Deprecated) Single cube ID to search in. "
            "Prefer `readable_cube_ids` for multi-cube search."
        ),
    )

    moscube: bool = Field(
        False,
        description="(Deprecated / internal) Whether to use legacy MemOSCube path.",
    )

    operation: list[PermissionDict] | None = Field(
        None,
        description="(Internal) Operation definitions for multi-cube read permissions.",
    )

    # ==== Source for  plugin ====
    source: str | None = Field(
        None,
        description="Source of the search query [plugin will router diff search]",
    )

    @model_validator(mode="after")
    def _convert_deprecated_fields(self) -> "APISearchRequest":
        """
        Convert deprecated fields to new fields for backward compatibility.
        Ensures full backward compatibility:
            - mem_cube_id → readable_cube_ids
            - moscube is ignored with warning
            - operation ignored
        """
        # Convert mem_cube_id to readable_cube_ids (new field takes priority)
        if self.mem_cube_id is not None:
            if not self.readable_cube_ids:
                self.readable_cube_ids = [self.mem_cube_id]
            logger.warning(
                "Deprecated field `mem_cube_id` is used in APISearchRequest. "
                "It will be removed in a future version. "
                "Please migrate to `readable_cube_ids`."
            )

        # Reject moscube if set to True (no longer supported)
        if self.moscube:
            logger.warning(
                "Deprecated field `moscube` is used in APISearchRequest. "
                "Legacy MemOSCube pipeline will be removed soon."
            )

        # Warn about operation (internal)
        if self.operation:
            logger.warning(
                "Internal field `operation` is provided in APISearchRequest. "
                "This field is deprecated and ignored."
            )

        return self


class APIADDRequest(BaseRequest):
    """Request model for creating memories."""

    # ==== Basic identifiers ====
    user_id: str = Field(None, description="User ID")
    session_id: str | None = Field(
        None,
        description="Session ID. If not provided, a default session will be used.",
    )
    task_id: str | None = Field(None, description="Task ID for monitering async tasks")

    # ==== Multi-cube writing ====
    writable_cube_ids: list[str] | None = Field(
        None, description="List of cube IDs user can write for multi-cube add"
    )

    # ==== Async control ====
    async_mode: Literal["async", "sync"] = Field(
        "async",
        description=(
            "Whether to add memory in async mode. "
            "Use 'async' to enqueue background add (non-blocking), "
            "or 'sync' to add memories in the current call. "
            "Default: 'async'."
        ),
    )

    mode: Literal["fast", "fine"] | None = Field(
        None,
        description=(
            "(Internal) Add mode used only when async_mode='sync'. "
            "If set to 'fast', the handler will use a fast add pipeline. "
            "Ignored when async_mode='async'."
        ),
    )

    # ==== Business tags & info ====
    custom_tags: list[str] | None = Field(
        None,
        description=(
            "Custom tags for this add request, e.g. ['Travel', 'family']. "
            "These tags can be used as filters in search."
        ),
    )

    info: dict[str, Any] | None = Field(
        None,
        description=(
            "Additional metadata for the add request. "
            "All keys can be used as filters in search. "
            "Example: "
            "{'agent_id': 'xxxxxx', "
            "'app_id': 'xxxx', "
            "'source_type': 'web', "
            "'source_url': 'https://www.baidu.com', "
            "'source_content': '西湖是杭州最著名的景点'}."
        ),
    )

    # ==== Input content ====
    messages: MessagesType | None = Field(
        None,
        description=(
            "List of messages to store. Supports: "
            "- system / user / assistant messages with 'content' and 'chat_time'; "
            "- tool messages including: "
            "  * tool_description (name, description, parameters), "
            "  * tool_input (call_id, name, argument), "
            "  * raw tool messages where content is str or list[str], "
            "  * tool_output with structured output items "
            "    (input_text / input_image / input_file, etc.). "
            "Also supports pure input items when there is no dialog."
        ),
    )

    # ==== Chat history ====
    chat_history: MessageList | None = Field(
        None,
        description=(
            "Historical chat messages used internally by algorithms. "
            "If None, internal stored history will be used; "
            "if provided (even an empty list), this value will be used as-is."
        ),
    )

    # ==== Feedback flag ====
    is_feedback: bool = Field(
        False,
        description=("Whether this request represents user feedback. Default: False."),
    )

    # ==== Backward compatibility fields (will delete later) ====
    mem_cube_id: str | None = Field(
        None,
        description="(Deprecated) Target cube ID for this add request (optional for developer API).",
    )

    memory_content: str | None = Field(
        None,
        description="(Deprecated) Plain memory content to store. Prefer using `messages`.",
    )
    doc_path: str | None = Field(
        None,
        description="(Deprecated / internal) Path to document to store.",
    )
    source: str | None = Field(
        None,
        description=(
            "(Deprecated) Simple source tag of the memory. "
            "Prefer using `info.source_type` / `info.source_url`."
        ),
    )
    operation: list[PermissionDict] | None = Field(
        None,
        description="(Internal) Operation definitions for multi-cube write permissions.",
    )

    @model_validator(mode="after")
    def _convert_deprecated_fields(self) -> "APIADDRequest":
        """
        Convert deprecated fields to new fields for backward compatibility.
        This keeps the API fully backward-compatible while allowing
        internal logic to use only the new fields.

        Rules:
            - mem_cube_id → writable_cube_ids
            - memory_content → messages
            - doc_path → messages (input_file)
            - source → info["source"]
            - operation → merged into writable_cube_ids (ignored otherwise)
        """
        # ---- async_mode / mode relationship ----
        if self.async_mode == "async" and self.mode is not None:
            logger.warning(
                "APIADDRequest.mode is ignored when async_mode='async'. "
                "Fast add pipeline is only available in sync mode."
            )
            self.mode = None

        # Convert mem_cube_id to writable_cube_ids (new field takes priority)
        if self.mem_cube_id:
            logger.warning(
                "APIADDRequest.mem_cube_id is deprecated and will be removed in a future version. "
                "Please use `writable_cube_ids` instead."
            )
            if not self.writable_cube_ids:
                self.writable_cube_ids = [self.mem_cube_id]

        # Handle deprecated operation field
        if self.operation:
            logger.warning(
                "APIADDRequest.operation is deprecated and will be removed. "
                "Use `writable_cube_ids` for multi-cube writes."
            )

        # Convert memory_content to messages (new field takes priority)
        if self.memory_content:
            logger.warning(
                "APIADDRequest.memory_content is deprecated. "
                "Use `messages` with a structured message instead."
            )
            if self.messages is None:
                self.messages = []
            self.messages.append(
                {
                    "type": "text",
                    "text": self.memory_content,
                }
            )

        # Handle deprecated doc_path
        if self.doc_path:
            logger.warning(
                "APIADDRequest.doc_path is deprecated. "
                "Use `messages` with an input_file item instead."
            )
            if self.messages is None:
                self.messages = []
            self.messages.append(
                {
                    "type": "file",
                    "file": {"path": self.doc_path},
                }
            )

        # Convert source to info.source_type (new field takes priority)
        if self.source:
            logger.warning(
                "APIADDRequest.source is deprecated. "
                "Use `info['source_type']` / `info['source_url']` instead."
            )
            if self.info is None:
                self.info = {}
            self.info.setdefault("source", self.source)

        return self


class APIFeedbackRequest(BaseRequest):
    """Request model for processing feedback info."""

    user_id: str = Field(..., description="User ID")
    session_id: str | None = Field(
        "default_session", description="Session ID for soft-filtering memories"
    )
    task_id: str | None = Field(None, description="Task ID for monitering async tasks")
    history: MessageList | None = Field(..., description="Chat history")
    retrieved_memory_ids: list[str] | None = Field(
        None, description="Retrieved memory ids at last turn"
    )
    feedback_content: str | None = Field(..., description="Feedback content to process")
    feedback_time: str | None = Field(None, description="Feedback time")
    writable_cube_ids: list[str] | None = Field(
        None, description="List of cube IDs user can write for multi-cube add"
    )
    async_mode: Literal["sync", "async"] = Field(
        "async", description="feedback mode: sync or async"
    )
    corrected_answer: bool = Field(False, description="Whether need return corrected answer")
    info: dict[str, Any] | None = Field(
        None,
        description=(
            "Additional metadata for the add request. "
            "All keys can be used as filters in search. "
            "Example: "
            "{'agent_id': 'xxxxxx', "
            "'app_id': 'xxxx', "
            "'source_type': 'web', "
            "'source_url': 'https://www.baidu.com', "
            "'source_content': 'West Lake is the most famous scenic spot in Hangzhou'}."
        ),
    )
    # ==== mem_cube_id is NOT enabled====
    mem_cube_id: str | None = Field(
        None,
        description=(
            "(Deprecated) Single cube ID to search in. "
            "Prefer `readable_cube_ids` for multi-cube search."
        ),
    )


class APIChatCompleteRequest(BaseRequest):
    """Request model for chat operations."""

    user_id: str = Field(..., description="User ID")
    query: str = Field(..., description="Chat query message")
    readable_cube_ids: list[str] | None = Field(
        None, description="List of cube IDs user can read for multi-cube chat"
    )
    writable_cube_ids: list[str] | None = Field(
        None, description="List of cube IDs user can write for multi-cube chat"
    )
    history: MessageList | None = Field(None, description="Chat history")
    mode: SearchMode = Field(SearchMode.FAST, description="search mode: fast, fine, or mixture")
    system_prompt: str | None = Field(None, description="Base system prompt to use for chat")
    top_k: int = Field(10, description="Number of results to return")
    session_id: str | None = Field(None, description="Session ID for soft-filtering memories")
    include_preference: bool = Field(True, description="Whether to handle preference memory")
    pref_top_k: int = Field(6, description="Number of preference results to return")
    model_name_or_path: str | None = Field(None, description="Model name to use for chat")
    max_tokens: int | None = Field(None, description="Max tokens to generate")
    temperature: float | None = Field(None, description="Temperature for sampling")
    top_p: float | None = Field(None, description="Top-p (nucleus) sampling parameter")
    add_message_on_answer: bool = Field(True, description="Add dialogs to memory after chat")

    # ==== Filter conditions ====
    filter: dict[str, Any] | None = Field(
        None,
        description="""
        Filter for the memory, example:
        {
            "`and` or `or`": [
                {"id": "uuid-xxx"},
                {"created_at": {"gt": "2024-01-01"}},
            ]
        }
        """,
    )

    # ==== Extended capabilities ====
    internet_search: bool = Field(False, description="Whether to use internet search")
    threshold: float = Field(0.5, description="Threshold for filtering references")

    # ==== Backward compatibility ====
    mem_cube_id: str | None = Field(None, description="Cube ID to use for chat")
    moscube: bool = Field(
        False, description="(Deprecated) Whether to use legacy MemOSCube pipeline"
    )


class AddStatusRequest(BaseRequest):
    """Request model for checking add status."""

    mem_cube_id: str = Field(..., description="Cube ID")
    user_id: str | None = Field(None, description="User ID")
    session_id: str | None = Field(None, description="Session ID")


class GetMemoryRequest(BaseRequest):
    """Request model for getting memories."""

    mem_cube_id: str = Field(..., description="Cube ID")
    user_id: str | None = Field(None, description="User ID")
    include_preference: bool = Field(True, description="Whether to handle preference memory")


class DeleteMemoryRequest(BaseRequest):
    """Request model for deleting memories."""

    writable_cube_ids: list[str] = Field(..., description="Writable cube IDs")
    memory_ids: list[str] | None = Field(None, description="Memory IDs")
    file_ids: list[str] | None = Field(None, description="File IDs")
    filter: dict[str, Any] | None = Field(None, description="Filter for the memory")


class SuggestionRequest(BaseRequest):
    """Request model for getting suggestion queries."""

    user_id: str = Field(..., description="User ID")
    mem_cube_id: str = Field(..., description="Cube ID")
    language: Literal["zh", "en"] = Field("zh", description="Language for suggestions")
    message: MessagesType | None = Field(None, description="List of messages to store.")


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
        default_factory=list, alias="message_detail_list", description="List of message details"
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


# ─── Scheduler Status Models ───────────────────────────────────────────────────


class StatusRequest(BaseRequest):
    """Request model for querying scheduler task status."""

    user_id: str = Field(..., description="User ID")
    task_id: str | None = Field(None, description="Optional Task ID to query a specific task")


class StatusResponseItem(BaseModel):
    """Individual task status item."""

    task_id: str = Field(..., description="The ID of the task")
    status: Literal["in_progress", "completed", "waiting", "failed", "cancelled"] = Field(
        ..., description="The current status of the task"
    )


class StatusResponse(BaseResponse[list[StatusResponseItem]]):
    """Response model for scheduler status operations."""

    message: str = "Memory get status successfully"


class TaskQueueData(BaseModel):
    """Queue-level metrics for scheduler tasks."""

    user_id: str = Field(..., description="User ID the query is scoped to")
    user_name: str | None = Field(None, description="User name if available")
    mem_cube_id: str | None = Field(
        None, description="MemCube ID if a single cube is targeted; otherwise None"
    )
    stream_keys: list[str] = Field(..., description="Matched Redis stream keys for this user")
    users_count: int = Field(..., description="Distinct users currently present in queue streams")
    pending_tasks_count: int = Field(
        ..., description="Count of pending (delivered, not acked) tasks"
    )
    remaining_tasks_count: int = Field(..., description="Count of enqueued tasks (xlen)")
    pending_tasks_detail: list[str] = Field(
        ..., description="Per-stream pending counts, formatted as '{stream_key}:{count}'"
    )
    remaining_tasks_detail: list[str] = Field(
        ..., description="Per-stream remaining counts, formatted as '{stream_key}:{count}'"
    )


class TaskQueueResponse(BaseResponse[TaskQueueData]):
    """Response model for scheduler task queue status."""

    message: str = "Scheduler task queue status retrieved successfully"


class TaskSummary(BaseModel):
    """Aggregated counts of tasks by status."""

    waiting: int = Field(0, description="Number of tasks waiting to run")
    in_progress: int = Field(0, description="Number of tasks currently running")
    pending: int = Field(
        0, description="Number of tasks fetched by workers but not yet acknowledged"
    )
    completed: int = Field(0, description="Number of tasks completed")
    failed: int = Field(0, description="Number of tasks failed")
    cancelled: int = Field(0, description="Number of tasks cancelled")
    total: int = Field(0, description="Total number of tasks counted")


class AllStatusResponseData(BaseModel):
    """Aggregated scheduler status metrics."""

    scheduler_summary: TaskSummary = Field(
        ..., description="Aggregated status for scheduler-managed tasks"
    )
    all_tasks_summary: TaskSummary = Field(
        ..., description="Aggregated status for all tracked tasks"
    )


class AllStatusResponse(BaseResponse[AllStatusResponseData]):
    """Response model for full scheduler status operations."""

    message: str = "Scheduler status summary retrieved successfully"
