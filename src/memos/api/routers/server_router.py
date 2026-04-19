"""
Server API Router for MemOS (Class-based handlers version).

This router demonstrates the improved architecture using class-based handlers
with dependency injection, providing better modularity and maintainability.

Comparison with function-based approach:
- Cleaner code: No need to pass dependencies in every endpoint
- Better testability: Easy to mock handler dependencies
- Improved extensibility: Add new handlers or modify existing ones easily
- Clear separation of concerns: Router focuses on routing, handlers handle business logic
"""

import os
import random as _random
import socket

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from memos.api import handlers
from memos.api.middleware.agent_auth import get_authenticated_user
from memos.api.handlers.add_handler import AddHandler
from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.handlers.chat_handler import ChatHandler
from memos.api.handlers.feedback_handler import FeedbackHandler
from memos.api.handlers.search_handler import SearchHandler
from memos.api.product_models import (
    AllStatusResponse,
    APIADDRequest,
    APIChatCompleteRequest,
    APIFeedbackRequest,
    APISearchRequest,
    ChatBusinessRequest,
    ChatPlaygroundRequest,
    ChatRequest,
    DeleteMemoryByRecordIdRequest,
    DeleteMemoryByRecordIdResponse,
    DeleteMemoryRequest,
    DeleteMemoryResponse,
    ExistMemCubeIdRequest,
    ExistMemCubeIdResponse,
    GetMemoryDashboardRequest,
    GetMemoryPlaygroundRequest,
    GetMemoryRequest,
    GetMemoryResponse,
    GetUserNamesByMemoryIdsRequest,
    GetUserNamesByMemoryIdsResponse,
    MemoryResponse,
    RecoverMemoryByRecordIdRequest,
    RecoverMemoryByRecordIdResponse,
    SearchResponse,
    StatusResponse,
    SuggestionRequest,
    SuggestionResponse,
    TaskQueueResponse,
)
from memos.log import get_logger
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.utils.status_tracker import TaskStatusTracker


logger = get_logger(__name__)


def _require_auth():
    """Router-level dependency: reject all unauthenticated requests when MEMOS_AUTH_REQUIRED=true."""
    if os.getenv("MEMOS_AUTH_REQUIRED", "false").lower() != "true":
        return  # Auth not enforced — passthrough
    authenticated = get_authenticated_user()
    if authenticated is None:
        raise HTTPException(
            status_code=401,
            detail="Authorization required. Include header: Authorization: Bearer <agent-key>",
        )


router = APIRouter(prefix="/product", tags=["Server API"], dependencies=[Depends(_require_auth)])

# Instance ID for identifying this server instance in logs and responses
INSTANCE_ID = f"{socket.gethostname()}:{os.getpid()}:{_random.randint(1000, 9999)}"

# Initialize all server components
components = handlers.init_server()

# Create dependency container
dependencies = HandlerDependencies.from_init_server(components)

# Initialize all handlers with dependency injection
search_handler = SearchHandler(dependencies)
add_handler = AddHandler(dependencies)
chat_handler = (
    ChatHandler(
        dependencies,
        components["chat_llms"],
        search_handler,
        add_handler,
        online_bot=components.get("online_bot"),
    )
    if os.getenv("ENABLE_CHAT_API", "false") == "true"
    else None
)
feedback_handler = FeedbackHandler(dependencies)
# Extract commonly used components for function-based handlers
# (These can be accessed from the components dict without unpacking all of them)
mem_scheduler: BaseScheduler = components["mem_scheduler"]
llm = components["llm"]
naive_mem_cube = components["naive_mem_cube"]
redis_client = components["redis_client"]
status_tracker = TaskStatusTracker(redis_client=redis_client)
graph_db = components["graph_db"]
user_manager = components.get("user_manager")


def _enforce_cube_access(user_id: str, cube_id: str) -> None:
    """Verify authenticated caller matches user_id and has cube access. Raises 403 on violation."""
    authenticated = get_authenticated_user()
    if authenticated is not None and authenticated != user_id:
        raise HTTPException(
            status_code=403,
            detail=f"Key authenticated as '{authenticated}' but request claims user_id='{user_id}'.",
        )
    if user_manager and not user_manager.validate_user_cube_access(user_id, cube_id):
        raise HTTPException(
            status_code=403,
            detail=f"Access denied: user '{user_id}' cannot access cube '{cube_id}'",
        )


# =============================================================================
# Search API Endpoints
# =============================================================================


@router.post("/search", summary="Search memories", response_model=SearchResponse)
def search_memories(search_req: APISearchRequest):
    """
    Search memories for a specific user.

    This endpoint uses the class-based SearchHandler for better code organization.
    """
    search_results = search_handler.handle_search_memories(search_req)
    return search_results


# =============================================================================
# Add API Endpoints
# =============================================================================


@router.post("/add", summary="Add memories", response_model=MemoryResponse)
def add_memories(add_req: APIADDRequest):
    """
    Add memories for a specific user.

    This endpoint uses the class-based AddHandler for better code organization.
    """
    return add_handler.handle_add_memories(add_req)


# =============================================================================
# Scheduler API Endpoints
# =============================================================================


@router.get(  # Changed from post to get
    "/scheduler/allstatus",
    summary="Get detailed scheduler status",
    response_model=AllStatusResponse,
)
def scheduler_allstatus():
    """Get detailed scheduler status including running tasks and queue metrics."""
    return handlers.scheduler_handler.handle_scheduler_allstatus(
        mem_scheduler=mem_scheduler, status_tracker=status_tracker
    )


@router.get(  # Changed from post to get
    "/scheduler/status", summary="Get scheduler running status", response_model=StatusResponse
)
def scheduler_status(
    user_id: str = Query(..., description="User ID"),
    task_id: str | None = Query(None, description="Optional Task ID to query a specific task"),
):
    """Get scheduler running status."""
    return handlers.scheduler_handler.handle_scheduler_status(
        user_id=user_id,
        task_id=task_id,
        status_tracker=status_tracker,
    )


@router.get(  # Changed from post to get
    "/scheduler/task_queue_status",
    summary="Get scheduler task queue status",
    response_model=TaskQueueResponse,
)
def scheduler_task_queue_status(
    user_id: str = Query(..., description="User ID whose queue status is requested"),
):
    """Get scheduler task queue backlog/pending status for a user."""
    return handlers.scheduler_handler.handle_task_queue_status(
        user_id=user_id, mem_scheduler=mem_scheduler
    )


_MAX_WAIT_TIMEOUT = 300.0  # 5 minutes max for scheduler wait endpoints


@router.post("/scheduler/wait", summary="Wait until scheduler is idle for a specific user")
def scheduler_wait(
    user_name: str,
    timeout_seconds: float = 120.0,
    poll_interval: float = 0.5,
):
    """Wait until scheduler is idle for a specific user."""
    authenticated = get_authenticated_user()
    if authenticated and authenticated != user_name:
        raise HTTPException(status_code=403, detail=f"Cannot wait on scheduler for user '{user_name}'")
    timeout_seconds = min(timeout_seconds, _MAX_WAIT_TIMEOUT)
    poll_interval = max(poll_interval, 0.25)
    return handlers.scheduler_handler.handle_scheduler_wait(
        user_name=user_name,
        status_tracker=status_tracker,
        timeout_seconds=timeout_seconds,
        poll_interval=poll_interval,
    )


@router.get("/scheduler/wait/stream", summary="Stream scheduler progress for a user")
def scheduler_wait_stream(
    user_name: str,
    timeout_seconds: float = 120.0,
    poll_interval: float = 0.5,
):
    """Stream scheduler progress via Server-Sent Events (SSE)."""
    authenticated = get_authenticated_user()
    if authenticated and authenticated != user_name:
        raise HTTPException(status_code=403, detail=f"Cannot stream scheduler for user '{user_name}'")
    timeout_seconds = min(timeout_seconds, _MAX_WAIT_TIMEOUT)
    poll_interval = max(poll_interval, 0.25)
    return handlers.scheduler_handler.handle_scheduler_wait_stream(
        user_name=user_name,
        status_tracker=status_tracker,
        timeout_seconds=timeout_seconds,
        poll_interval=poll_interval,
        instance_id=INSTANCE_ID,
    )


# =============================================================================
# Chat API Endpoints
# =============================================================================


@router.post("/chat/complete", summary="Chat with MemOS (Complete Response)")
def chat_complete(chat_req: APIChatCompleteRequest):
    """
    Chat with MemOS for a specific user. Returns complete response (non-streaming).

    This endpoint uses the class-based ChatHandler.
    """
    if chat_handler is None:
        raise HTTPException(
            status_code=503, detail="Chat service is not available. Chat handler not initialized."
        )
    return chat_handler.handle_chat_complete(chat_req)


@router.post("/chat/stream", summary="Chat with MemOS")
def chat_stream(chat_req: ChatRequest):
    """
    Chat with MemOS for a specific user. Returns SSE stream.

    This endpoint uses the class-based ChatHandler which internally
    composes SearchHandler and AddHandler for a clean architecture.
    """
    if chat_handler is None:
        raise HTTPException(
            status_code=503, detail="Chat service is not available. Chat handler not initialized."
        )
    return chat_handler.handle_chat_stream(chat_req)


@router.post("/chat/stream/playground", summary="Chat with MemOS playground")
def chat_stream_playground(chat_req: ChatPlaygroundRequest):
    """
    Chat with MemOS for a specific user. Returns SSE stream.

    This endpoint uses the class-based ChatHandler which internally
    composes SearchHandler and AddHandler for a clean architecture.
    """
    if chat_handler is None:
        raise HTTPException(
            status_code=503, detail="Chat service is not available. Chat handler not initialized."
        )
    return chat_handler.handle_chat_stream_playground(chat_req)


# =============================================================================
# Suggestion API Endpoints
# =============================================================================


@router.post(
    "/suggestions",
    summary="Get suggestion queries",
    response_model=SuggestionResponse,
)
def get_suggestion_queries(suggestion_req: SuggestionRequest):
    """Get suggestion queries for a specific user with language preference."""
    return handlers.suggestion_handler.handle_get_suggestion_queries(
        user_id=suggestion_req.mem_cube_id,
        language=suggestion_req.language,
        message=suggestion_req.message,
        llm=llm,
        naive_mem_cube=naive_mem_cube,
    )


# =============================================================================
# Memory Retrieval Delete API Endpoints
# =============================================================================


@router.post("/get_all", summary="Get all memories for user", response_model=MemoryResponse)
def get_all_memories(memory_req: GetMemoryPlaygroundRequest):
    """
    Get all memories or subgraph for a specific user.

    If search_query is provided, returns a subgraph based on the query.
    Otherwise, returns all memories of the specified type.
    """
    target_cube = memory_req.mem_cube_ids[0] if memory_req.mem_cube_ids else memory_req.user_id
    _enforce_cube_access(memory_req.user_id, target_cube)
    if memory_req.search_query:
        return handlers.memory_handler.handle_get_subgraph(
            user_id=memory_req.user_id,
            mem_cube_id=(
                memory_req.mem_cube_ids[0] if memory_req.mem_cube_ids else memory_req.user_id
            ),
            query=memory_req.search_query,
            top_k=200,
            naive_mem_cube=naive_mem_cube,
            search_type=memory_req.search_type,
        )
    else:
        return handlers.memory_handler.handle_get_all_memories(
            user_id=memory_req.user_id,
            mem_cube_id=(
                memory_req.mem_cube_ids[0] if memory_req.mem_cube_ids else memory_req.user_id
            ),
            memory_type=memory_req.memory_type or "text_mem",
            naive_mem_cube=naive_mem_cube,
        )


@router.post("/get_memory", summary="Get memories for user", response_model=GetMemoryResponse)
def get_memories(memory_req: GetMemoryRequest):
    _enforce_cube_access(memory_req.user_id or memory_req.mem_cube_id, memory_req.mem_cube_id)
    return handlers.memory_handler.handle_get_memories(
        get_mem_req=memory_req,
        naive_mem_cube=naive_mem_cube,
    )


@router.get("/get_memory/{memory_id}", summary="Get memory by id", response_model=GetMemoryResponse)
def get_memory_by_id(memory_id: str):
    # Look up the memory's owning cube and verify access
    authenticated = get_authenticated_user()
    if authenticated and user_manager:
        owner_map = graph_db.get_user_names_by_memory_ids(memory_ids=[memory_id])
        owner = owner_map.get(memory_id)
        if owner and not user_manager.validate_user_cube_access(authenticated, owner):
            raise HTTPException(
                status_code=403,
                detail=f"Access denied: user '{authenticated}' cannot read memory owned by '{owner}'",
            )
    return handlers.memory_handler.handle_get_memory(
        memory_id=memory_id,
        naive_mem_cube=naive_mem_cube,
    )


@router.post("/get_memory_by_ids", summary="Get memory by ids", response_model=GetMemoryResponse)
def get_memory_by_ids(memory_ids: list[str]):
    # Filter out memories the caller cannot access
    authenticated = get_authenticated_user()
    if authenticated and user_manager and memory_ids:
        owner_map = graph_db.get_user_names_by_memory_ids(memory_ids=memory_ids)
        forbidden = [
            mid for mid, owner in owner_map.items()
            if owner and not user_manager.validate_user_cube_access(authenticated, owner)
        ]
        if forbidden:
            raise HTTPException(
                status_code=403,
                detail=f"Access denied: cannot read {len(forbidden)} memory ID(s) owned by other cubes",
            )
    return handlers.memory_handler.handle_get_memory_by_ids(
        memory_ids=memory_ids,
        naive_mem_cube=naive_mem_cube,
    )


@router.api_route(
    "/delete_memory",
    methods=["POST", "DELETE"],
    summary="Delete memories for user",
    response_model=DeleteMemoryResponse,
)
def delete_memories(memory_req: DeleteMemoryRequest):
    """Delete memories. Supports both singular (`mem_cube_id`, `memory_id`) and plural aliases.

    Returns distinct status codes:
    - 400: memory-id mode chosen but cube or memory id(s) missing.
    - 403: caller lacks access to a requested cube (enforced by `_enforce_cube_access`).
    - 404: memory-id mode where every id is missing from the targeted cube(s).
    - 200: success — body carries `deleted`/`not_found` for partial results.
    """
    authenticated = get_authenticated_user()

    cube_ids = memory_req.writable_cube_ids or []
    mem_ids = memory_req.memory_ids or []

    has_file_ids = bool(memory_req.file_ids)
    # Memory-id mode wins when memory_ids is present; otherwise we fall back to file-id
    # or filter/user_id/session_id mode. (user_id alone, without memory_ids, still means
    # "delete everything for this user" — preserved for legacy callers.)
    memory_id_mode = bool(mem_ids) or (
        not has_file_ids
        and not memory_req.filter
        and not memory_req.user_id
        and not memory_req.session_id
    )

    if memory_id_mode and (not cube_ids or not mem_ids):
        raise HTTPException(
            status_code=400,
            detail=(
                "Provide both a cube (mem_cube_id or writable_cube_ids) and "
                "a memory id (memory_id or memory_ids), or use file_ids / filter mode."
            ),
        )

    # 403 on any cube the caller cannot access.
    for cube_id in cube_ids:
        _enforce_cube_access(authenticated or cube_id, cube_id)

    if not memory_id_mode:
        return handlers.memory_handler.handle_delete_memories(
            delete_mem_req=memory_req, naive_mem_cube=naive_mem_cube
        )

    # Memory-id mode: split existing vs missing before delegating to handler.
    try:
        owner_map = graph_db.get_user_names_by_memory_ids(memory_ids=mem_ids)
    except Exception:
        logger.error("Failed to look up memory owners before delete", exc_info=True)
        owner_map = {}

    allowed_cubes = set(cube_ids)
    deleted_ids: list[str] = []
    not_found_ids: list[str] = []
    for mid in mem_ids:
        owner = owner_map.get(mid)
        if owner and owner in allowed_cubes:
            deleted_ids.append(mid)
        else:
            # Memory either does not exist at all, or belongs to a cube the
            # caller did not target. From the caller's perspective it is not found.
            not_found_ids.append(mid)

    if not deleted_ids:
        # Return envelope directly so {deleted, not_found} survives the global HTTP
        # exception handler, which would otherwise stringify structured `detail`.
        return JSONResponse(
            status_code=404,
            content={
                "code": 404,
                "message": "No matching memories found in the targeted cube(s).",
                "data": {"deleted": [], "not_found": not_found_ids},
            },
        )

    filtered_req = memory_req.model_copy(update={"memory_ids": deleted_ids})
    resp = handlers.memory_handler.handle_delete_memories(
        delete_mem_req=filtered_req, naive_mem_cube=naive_mem_cube
    )
    data = dict(resp.data or {})
    data["deleted"] = deleted_ids
    data["not_found"] = not_found_ids
    if not_found_ids and data.get("status") == "success":
        data["status"] = "partial"
    message = (
        "Memories deleted successfully"
        if not not_found_ids
        else f"Deleted {len(deleted_ids)} memory(ies); {len(not_found_ids)} not found."
    )
    return DeleteMemoryResponse(code=200, message=message, data=data)


# =============================================================================
# Feedback API Endpoints
# =============================================================================


@router.post("/feedback", summary="Feedback memories", response_model=MemoryResponse)
def feedback_memories(feedback_req: APIFeedbackRequest):
    """
    Feedback memories for a specific user.

    This endpoint uses the class-based FeedbackHandler for better code organization.
    """
    cube_ids = feedback_req.writable_cube_ids or [feedback_req.user_id]
    for cube_id in cube_ids:
        _enforce_cube_access(feedback_req.user_id, cube_id)
    return feedback_handler.handle_feedback_memories(feedback_req)


# =============================================================================
# Other API Endpoints (for internal use)
# =============================================================================


@router.post(
    "/get_user_names_by_memory_ids",
    summary="Get user names by memory ids",
    response_model=GetUserNamesByMemoryIdsResponse,
)
def get_user_names_by_memory_ids(request: GetUserNamesByMemoryIdsRequest):
    """Get user names by memory ids. Now unified to query from graph_db only."""
    authenticated = get_authenticated_user()
    result = graph_db.get_user_names_by_memory_ids(memory_ids=request.memory_ids)
    # Filter results: only return mappings for cubes the caller can access
    if authenticated and user_manager:
        result = {
            mid: uname for mid, uname in result.items()
            if uname is None or user_manager.validate_user_cube_access(authenticated, uname)
        }

    return GetUserNamesByMemoryIdsResponse(
        code=200,
        message="Successfully",
        data=result,
    )


@router.post(
    "/exist_mem_cube_id",
    summary="Check if mem cube id exists",
    response_model=ExistMemCubeIdResponse,
)
def exist_mem_cube_id(request: ExistMemCubeIdRequest):
    """(inner) Check if mem cube id exists. Only returns True if caller has access."""
    authenticated = get_authenticated_user()
    exists = graph_db.exist_user_name(user_name=request.mem_cube_id)
    # Only reveal existence if the caller has access to that cube
    if exists and authenticated and user_manager:
        if not user_manager.validate_user_cube_access(authenticated, request.mem_cube_id):
            exists = False  # Hide existence from unauthorized callers
    return ExistMemCubeIdResponse(
        code=200,
        message="Successfully",
        data=exists,
    )


@router.post("/chat/stream/business_user", summary="Chat with MemOS for business user")
def chat_stream_business_user(chat_req: ChatBusinessRequest):
    """(inner) Chat with MemOS for a specific business user. Returns SSE stream."""
    if chat_handler is None:
        raise HTTPException(
            status_code=503, detail="Chat service is not available. Chat handler not initialized."
        )

    return chat_handler.handle_chat_stream_for_business_user(chat_req)


@router.post(
    "/delete_memory_by_record_id",
    summary="Delete memory by record id",
    response_model=DeleteMemoryByRecordIdResponse,
)
def delete_memory_by_record_id(memory_req: DeleteMemoryByRecordIdRequest):
    """(inner) Delete memory nodes by mem_cube_id (user_name) and delete_record_id. Record id is inner field, just for delete and recover memory, not for user to set."""
    authenticated = get_authenticated_user()
    _enforce_cube_access(authenticated or memory_req.mem_cube_id, memory_req.mem_cube_id)
    graph_db.delete_node_by_mem_cube_id(
        mem_cube_id=memory_req.mem_cube_id,
        delete_record_id=memory_req.record_id,
        hard_delete=memory_req.hard_delete,
    )

    return DeleteMemoryByRecordIdResponse(
        code=200,
        message="Called Successfully",
        data={"status": "success"},
    )


@router.post(
    "/recover_memory_by_record_id",
    summary="Recover memory by record id",
    response_model=RecoverMemoryByRecordIdResponse,
)
def recover_memory_by_record_id(memory_req: RecoverMemoryByRecordIdRequest):
    """(inner) Recover memory nodes by mem_cube_id (user_name) and delete_record_id. Record id is inner field, just for delete and recover memory, not for user to set."""
    authenticated = get_authenticated_user()
    _enforce_cube_access(authenticated or memory_req.mem_cube_id, memory_req.mem_cube_id)
    graph_db.recover_memory_by_mem_cube_id(
        mem_cube_id=memory_req.mem_cube_id,
        delete_record_id=memory_req.delete_record_id,
    )

    return RecoverMemoryByRecordIdResponse(
        code=200,
        message="Called Successfully",
        data={"status": "success"},
    )


@router.post(
    "/get_memory_dashboard", summary="Get memories for dashboard", response_model=GetMemoryResponse
)
def get_memories_dashboard(memory_req: GetMemoryDashboardRequest):
    if memory_req.mem_cube_id:
        _enforce_cube_access(memory_req.user_id or memory_req.mem_cube_id, memory_req.mem_cube_id)
    return handlers.memory_handler.handle_get_memories_dashboard(
        get_mem_req=memory_req,
        naive_mem_cube=naive_mem_cube,
    )
