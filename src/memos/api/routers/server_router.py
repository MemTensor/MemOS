"""
Server API Router for MemOS.

This router provides low-level API endpoints for direct server instance operations,
including search, add, scheduler management, and chat functionalities.

The actual implementation logic is delegated to specialized handler modules
in server_handlers package for better modularity and maintainability.
"""

import os
import random as _random
import socket

from fastapi import APIRouter

from memos.api import handlers
from memos.api.product_models import (
    APIADDRequest,
    APIChatCompleteRequest,
    APISearchRequest,
    ChatRequest,
    MemoryResponse,
    SearchResponse,
)
from memos.log import get_logger


logger = get_logger(__name__)

router = APIRouter(prefix="/product", tags=["Server API"])

# Instance ID for identifying this server instance in logs and responses
INSTANCE_ID = f"{socket.gethostname()}:{os.getpid()}:{_random.randint(1000, 9999)}"

# Initialize all server components
(
    graph_db,
    mem_reader,
    llm,
    embedder,
    reranker,
    internet_retriever,
    memory_manager,
    default_cube_config,
    mos_server,
    mem_scheduler,
    naive_mem_cube,
    api_module,
    vector_db,
    pref_extractor,
    pref_adder,
    pref_retriever,
    text_mem,
    pref_mem,
) = handlers.init_server()


# =============================================================================
# Search API Endpoints
# =============================================================================


@router.post("/search", summary="Search memories", response_model=SearchResponse)
def search_memories(search_req: APISearchRequest):
    """Search memories for a specific user."""
    return handlers.search_handlers.handle_search_memories(
        search_req=search_req,
        naive_mem_cube=naive_mem_cube,
        mem_scheduler=mem_scheduler,
    )


# =============================================================================
# Add API Endpoints
# =============================================================================


@router.post("/add", summary="Add memories", response_model=MemoryResponse)
def add_memories(add_req: APIADDRequest):
    """Add memories for a specific user."""
    return handlers.add_handlers.handle_add_memories(
        add_req=add_req,
        naive_mem_cube=naive_mem_cube,
        mem_reader=mem_reader,
        mem_scheduler=mem_scheduler,
    )


# =============================================================================
# Scheduler API Endpoints
# =============================================================================


@router.get("/scheduler/status", summary="Get scheduler running status")
def scheduler_status(user_name: str | None = None):
    """Get scheduler running status."""
    return handlers.scheduler_handlers.handle_scheduler_status(
        user_name=user_name,
        mem_scheduler=mem_scheduler,
        instance_id=INSTANCE_ID,
    )


@router.post("/scheduler/wait", summary="Wait until scheduler is idle for a specific user")
def scheduler_wait(
    user_name: str,
    timeout_seconds: float = 120.0,
    poll_interval: float = 0.2,
):
    """Wait until scheduler is idle for a specific user."""
    return handlers.scheduler_handlers.handle_scheduler_wait(
        user_name=user_name,
        timeout_seconds=timeout_seconds,
        poll_interval=poll_interval,
        mem_scheduler=mem_scheduler,
    )


@router.get("/scheduler/wait/stream", summary="Stream scheduler progress for a user")
def scheduler_wait_stream(
    user_name: str,
    timeout_seconds: float = 120.0,
    poll_interval: float = 0.2,
):
    """Stream scheduler progress via Server-Sent Events (SSE)."""
    return handlers.scheduler_handlers.handle_scheduler_wait_stream(
        user_name=user_name,
        timeout_seconds=timeout_seconds,
        poll_interval=poll_interval,
        mem_scheduler=mem_scheduler,
        instance_id=INSTANCE_ID,
    )


# =============================================================================
# Chat API Endpoints
# =============================================================================


@router.post("/chat/complete", summary="Chat with MemOS (Complete Response)")
def chat_complete(chat_req: APIChatCompleteRequest):
    """Chat with MemOS for a specific user. Returns complete response (non-streaming)."""
    return handlers.chat_handlers.handle_chat_complete(
        chat_req=chat_req,
        mos_server=mos_server,
        naive_mem_cube=naive_mem_cube,
    )


@router.post("/chat", summary="Chat with MemOS")
def chat(chat_req: ChatRequest):
    """Chat with MemOS for a specific user. Returns SSE stream."""
    return handlers.chat_handlers.handle_chat_stream(
        chat_req=chat_req,
        mos_server=mos_server,
    )
