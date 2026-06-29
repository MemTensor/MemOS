"""
Cloud-compat router.

Issue #1317: the MemOS Cloud OpenClaw plugin and the Python `MemOSClient` SDK
both call:

    POST /add/message       → add memories from a chat turn
    POST /search/memory     → recall memories before an agent turn
    POST /get/memory        → paged memory listing

These paths are not registered by `server_router.py` (which only exposes
`/product/search` and `/product/add`), so every plugin call returns 404.

This router is a thin compatibility shim that:

* registers the three cloud-shape paths at the FastAPI app root;
* translates the cloud plugin's snake_case payload (with a couple of
  camelCase aliases) into the internal `APISearchRequest` /
  `APIADDRequest` / `GetMemoryRequest` models;
* delegates to the existing `AddHandler`, `SearchHandler`, and
  `memory_handler` already wired up by `server_router.py` — no handler
  logic is duplicated here.

Keeping the field-mapping logic isolated in this router (instead of
mutating the underlying request models) preserves the `/product/*` API
contract and keeps the OpenAPI spec for the new endpoints obvious.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from memos.api import handlers
from memos.api.product_models import (
    APIADDRequest,
    APISearchRequest,
    GetMemoryRequest,
    GetMemoryResponse,
    MemoryResponse,
    SearchResponse,
)
from memos.log import get_logger


logger = get_logger(__name__)

router = APIRouter(tags=["Cloud Compat"])


# ---------------------------------------------------------------------------
# Cloud-shape request models
# ---------------------------------------------------------------------------


class CloudSearchMemoryRequest(BaseModel):
    """Cloud plugin shape for `/search/memory`.

    Mirrors the payload built by
    ``apps/MemOS-Cloud-OpenClaw-Plugin/index.js::buildSearchPayload`` and
    ``src/memos/api/client.py::MemOSClient.search_memory``.
    """

    model_config = ConfigDict(extra="allow")

    query: str = Field(..., description="Search query")
    user_id: str = Field(..., description="User ID")
    conversation_id: str | None = Field(
        None,
        description="Conversation/session id (mapped to APISearchRequest.session_id).",
    )
    memory_limit_number: int | None = Field(
        None,
        ge=1,
        description="Number of textual memories to retrieve (mapped to top_k).",
    )
    include_preference: bool | None = Field(
        None, description="Whether to retrieve preference memories."
    )
    preference_limit_number: int | None = Field(
        None,
        ge=0,
        description="Number of preference memories to retrieve (mapped to pref_top_k).",
    )
    include_tool_memory: bool | None = Field(
        None, description="Whether to retrieve tool memories (mapped to search_tool_memory)."
    )
    tool_memory_limit_number: int | None = Field(
        None,
        ge=0,
        description="Number of tool memories to retrieve (mapped to tool_mem_top_k).",
    )
    knowledgebase_ids: list[str] | None = Field(
        None,
        description="Knowledge base ids to scope the search to (mapped to readable_cube_ids).",
    )
    filter: dict[str, Any] | None = Field(None, description="Search filter, passed through.")
    source: str | None = Field(None, description="Plugin source tag, passed through.")
    relativity: float | None = Field(
        None, ge=0, description="Relevance threshold (passed through)."
    )


class CloudAddMessageRequest(BaseModel):
    """Cloud plugin shape for `/add/message`.

    Mirrors the payload built by
    ``apps/MemOS-Cloud-OpenClaw-Plugin/index.js::buildAddMessagePayload`` and
    ``src/memos/api/client.py::MemOSClient.add_message``.
    """

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    messages: list[dict[str, Any]] = Field(..., description="Messages to store.")
    user_id: str = Field(..., description="User ID")
    conversation_id: str | None = Field(
        None,
        description="Conversation/session id (mapped to APIADDRequest.session_id).",
    )
    info: dict[str, Any] | None = Field(
        None, description="Arbitrary metadata, merged into APIADDRequest.info."
    )
    source: str | None = Field(None, description="Plugin source tag; folded into info['source'].")
    app_id: str | None = Field(None, description="Plugin app id; folded into info['app_id'].")
    agent_id: str | None = Field(None, description="Plugin agent id; folded into info['agent_id'].")
    # The SDK in src/memos/api/client.py historically sends camelCase `asyncMode`.
    # The cloud plugin sends snake_case `async_mode`. Accept both.
    asyncMode: bool | None = Field(  # noqa: N815 - matches wire field name
        None, description="(Legacy camelCase) async mode flag from MemOSClient SDK."
    )
    async_mode: bool | str | None = Field(
        None,
        description="async mode: bool from cloud plugin, or 'sync'/'async' literal.",
    )
    tags: list[str] | None = Field(
        None, description="Tags for the add (mapped to APIADDRequest.custom_tags)."
    )
    allow_public: bool | None = Field(
        None, description="Whether the memory is public; folded into info['allow_public']."
    )
    allow_knowledgebase_ids: list[str] | None = Field(
        None,
        description="Knowledge bases the user can write to (mapped to writable_cube_ids).",
    )


class CloudGetMemoryRequest(BaseModel):
    """Cloud plugin shape for `/get/memory`.

    Mirrors the payload built by
    ``src/memos/api/client.py::MemOSClient.get_memory``.
    """

    model_config = ConfigDict(extra="allow")

    user_id: str = Field(..., description="User ID")
    include_preference: bool | None = Field(True, description="Include preference memories.")
    page: int | None = Field(None, ge=1, description="Page number (1-based).")
    size: int | None = Field(None, ge=1, description="Page size.")


# ---------------------------------------------------------------------------
# Mapping helpers
# ---------------------------------------------------------------------------


def _build_internal_search_request(cloud_req: CloudSearchMemoryRequest) -> APISearchRequest:
    """Translate the cloud `/search/memory` payload to an APISearchRequest."""

    kwargs: dict[str, Any] = {
        "query": cloud_req.query,
        "user_id": cloud_req.user_id,
    }

    if cloud_req.conversation_id is not None:
        kwargs["session_id"] = cloud_req.conversation_id
    if cloud_req.memory_limit_number is not None:
        kwargs["top_k"] = cloud_req.memory_limit_number
    if cloud_req.include_preference is not None:
        kwargs["include_preference"] = cloud_req.include_preference
    if cloud_req.preference_limit_number is not None:
        kwargs["pref_top_k"] = cloud_req.preference_limit_number
    if cloud_req.include_tool_memory is not None:
        kwargs["search_tool_memory"] = cloud_req.include_tool_memory
    if cloud_req.tool_memory_limit_number is not None:
        kwargs["tool_mem_top_k"] = cloud_req.tool_memory_limit_number
    if cloud_req.knowledgebase_ids:
        kwargs["readable_cube_ids"] = list(cloud_req.knowledgebase_ids)
    if cloud_req.filter is not None:
        kwargs["filter"] = cloud_req.filter
    if cloud_req.source is not None:
        kwargs["source"] = cloud_req.source
    if cloud_req.relativity is not None:
        kwargs["relativity"] = cloud_req.relativity

    return APISearchRequest(**kwargs)


def _resolve_async_mode(cloud_req: CloudAddMessageRequest) -> str | None:
    """Resolve the add request's async_mode literal from cloud-shape inputs.

    The SDK sends `asyncMode: bool` (default True). The cloud plugin sends
    `async_mode: bool`. APIADDRequest expects 'async' | 'sync'. Snake_case
    'async'/'sync' string is also accepted.
    """
    raw = cloud_req.async_mode if cloud_req.async_mode is not None else cloud_req.asyncMode
    if raw is None:
        return None
    if isinstance(raw, bool):
        return "async" if raw else "sync"
    if isinstance(raw, str) and raw in ("async", "sync"):
        return raw
    # Unknown value → fall back to default
    return None


def _build_internal_add_request(cloud_req: CloudAddMessageRequest) -> APIADDRequest:
    """Translate the cloud `/add/message` payload to an APIADDRequest."""

    kwargs: dict[str, Any] = {
        "user_id": cloud_req.user_id,
        "messages": cloud_req.messages,
    }

    if cloud_req.conversation_id is not None:
        kwargs["session_id"] = cloud_req.conversation_id

    async_mode = _resolve_async_mode(cloud_req)
    if async_mode is not None:
        kwargs["async_mode"] = async_mode

    if cloud_req.tags:
        kwargs["custom_tags"] = list(cloud_req.tags)
    if cloud_req.allow_knowledgebase_ids:
        kwargs["writable_cube_ids"] = list(cloud_req.allow_knowledgebase_ids)

    # Fold plugin-only metadata into `info` so downstream handlers can read it
    # without losing context.
    merged_info: dict[str, Any] = dict(cloud_req.info or {})
    if cloud_req.source is not None:
        merged_info.setdefault("source", cloud_req.source)
    if cloud_req.app_id is not None:
        merged_info.setdefault("app_id", cloud_req.app_id)
    if cloud_req.agent_id is not None:
        merged_info.setdefault("agent_id", cloud_req.agent_id)
    if cloud_req.allow_public is not None:
        merged_info.setdefault("allow_public", cloud_req.allow_public)
    if merged_info:
        kwargs["info"] = merged_info

    return APIADDRequest(**kwargs)


def _build_internal_get_memory_request(cloud_req: CloudGetMemoryRequest) -> GetMemoryRequest:
    """Translate the cloud `/get/memory` payload to a GetMemoryRequest."""

    # GetMemoryRequest requires `mem_cube_id`; default it to `user_id`, which
    # matches how `/product/get_all` falls back when no cube is supplied.
    kwargs: dict[str, Any] = {
        "mem_cube_id": cloud_req.user_id,
        "user_id": cloud_req.user_id,
    }
    if cloud_req.include_preference is not None:
        kwargs["include_preference"] = cloud_req.include_preference
    if cloud_req.page is not None:
        kwargs["page"] = cloud_req.page
    if cloud_req.size is not None:
        kwargs["page_size"] = cloud_req.size
    return GetMemoryRequest(**kwargs)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post(
    "/search/memory",
    summary="Cloud-compat: search memories (delegates to /product/search)",
    response_model=SearchResponse,
)
def search_memory(req: CloudSearchMemoryRequest) -> SearchResponse:
    """Cloud plugin entry point for memory recall.

    Returns the same `SearchResponse` envelope as `/product/search`.
    """
    # Import lazily so the test fixture's patches on server_router globals
    # (search_handler / add_handler / handlers.memory_handler) take effect.
    from memos.api.routers import server_router

    internal_req = _build_internal_search_request(req)
    return server_router.search_handler.handle_search_memories(internal_req)


@router.post(
    "/add/message",
    summary="Cloud-compat: add memories from a chat turn (delegates to /product/add)",
    response_model=MemoryResponse,
)
def add_message(req: CloudAddMessageRequest) -> MemoryResponse:
    """Cloud plugin entry point for memory write-back."""
    from memos.api.routers import server_router

    internal_req = _build_internal_add_request(req)
    return server_router.add_handler.handle_add_memories(internal_req)


@router.post(
    "/get/memory",
    summary="Cloud-compat: paged memory listing (delegates to /product/get_memory)",
    response_model=GetMemoryResponse,
)
def get_memory(req: CloudGetMemoryRequest) -> GetMemoryResponse:
    """Cloud plugin entry point for paged memory listing."""
    internal_req = _build_internal_get_memory_request(req)
    return handlers.memory_handler.handle_get_memories(
        get_mem_req=internal_req,
        naive_mem_cube=_get_naive_mem_cube(),
    )


def _get_naive_mem_cube() -> Any:
    """Lazy accessor to the shared NaiveMemCube initialised by server_router."""
    from memos.api.routers import server_router

    return server_router.naive_mem_cube
