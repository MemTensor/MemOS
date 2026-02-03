from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from memos.api.product_models import APISearchRequest
    from memos.types import SearchMode, UserContext


@dataclass(frozen=True)
class SearchContext:
    target_session_id: str
    search_priority: dict[str, Any] | None
    search_filter: dict[str, Any] | None
    info: dict[str, Any]
    plugin: bool


def build_search_context(
    search_req: APISearchRequest,
) -> SearchContext:
    target_session_id = search_req.session_id or "default_session"
    search_priority = {"session_id": search_req.session_id} if search_req.session_id else None
    return SearchContext(
        target_session_id=target_session_id,
        search_priority=search_priority,
        search_filter=search_req.filter,
        info={
            "user_id": search_req.user_id,
            "session_id": target_session_id,
            "chat_history": search_req.chat_history,
        },
        plugin=bool(search_req.source is not None and search_req.source == "plugin"),
    )


def search_text_memories(
    text_mem: Any,
    search_req: APISearchRequest,
    user_context: UserContext,
    mode: SearchMode,
) -> list[Any]:
    """
    Shared text-memory search logic for API and scheduler paths.
    """
    ctx = build_search_context(search_req=search_req)
    return text_mem.search(
        query=search_req.query,
        user_name=user_context.mem_cube_id,
        top_k=search_req.top_k,
        mode=mode,
        manual_close_internet=not search_req.internet_search,
        memory_type=search_req.search_memory_type,
        search_filter=ctx.search_filter,
        search_priority=ctx.search_priority,
        info=ctx.info,
        plugin=ctx.plugin,
        search_tool_memory=search_req.search_tool_memory,
        tool_mem_top_k=search_req.tool_mem_top_k,
        include_skill_memory=search_req.include_skill_memory,
        skill_mem_top_k=search_req.skill_mem_top_k,
        dedup=search_req.dedup,
    )
