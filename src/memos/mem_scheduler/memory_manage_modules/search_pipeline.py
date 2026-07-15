from __future__ import annotations

from memos.log import get_logger
from memos.mem_scheduler.schemas.general_schemas import (
    TreeTextMemory_FINE_SEARCH_METHOD,
    TreeTextMemory_SEARCH_METHOD,
)
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory
from memos.types.general_types import SearchMode


logger = get_logger(__name__)


class SearchPipeline:
    def search(
        self,
        query: str,
        user_id: str,
        mem_cube_id: str,
        mem_cube,
        top_k: int,
        method: str = TreeTextMemory_SEARCH_METHOD,
        search_args: dict | None = None,
    ) -> list[TextualMemoryItem]:
        text_mem_base = mem_cube.text_mem
        search_args = search_args or {}
        try:
            if method in [TreeTextMemory_SEARCH_METHOD, TreeTextMemory_FINE_SEARCH_METHOD]:
                assert isinstance(text_mem_base, TreeTextMemory)
                session_id = search_args.get("session_id", "default_session")
                target_session_id = session_id
                search_priority = (
                    {"session_id": target_session_id} if "session_id" in search_args else None
                )
                search_filter = search_args.get("filter")
                search_source = search_args.get("source")
                plugin = bool(search_source is not None and search_source == "plugin")
                user_name = search_args.get("user_name", mem_cube_id)
                internet_search = search_args.get("internet_search", False)
                chat_history = search_args.get("chat_history")
                search_tool_memory = search_args.get("search_tool_memory", False)
                tool_mem_top_k = search_args.get("tool_mem_top_k", 6)
                playground_search_goal_parser = search_args.get(
                    "playground_search_goal_parser", False
                )

                info = search_args.get(
                    "info",
                    {
                        "user_id": user_id,
                        "session_id": target_session_id,
                        "chat_history": chat_history,
                    },
                )

                results_long_term = mem_cube.text_mem.search(
                    query=query,
                    user_name=user_name,
                    top_k=top_k,
                    mode=SearchMode.FAST,
                    manual_close_internet=not internet_search,
                    memory_type="LongTermMemory",
                    search_filter=search_filter,
                    search_priority=search_priority,
                    info=info,
                    plugin=plugin,
                    search_tool_memory=search_tool_memory,
                    tool_mem_top_k=tool_mem_top_k,
                    playground_search_goal_parser=playground_search_goal_parser,
                )

                results_user = mem_cube.text_mem.search(
                    query=query,
                    user_name=user_name,
                    top_k=top_k,
                    mode=SearchMode.FAST,
                    manual_close_internet=not internet_search,
                    memory_type="UserMemory",
                    search_filter=search_filter,
                    search_priority=search_priority,
                    info=info,
                    plugin=plugin,
                    search_tool_memory=search_tool_memory,
                    tool_mem_top_k=tool_mem_top_k,
                    playground_search_goal_parser=playground_search_goal_parser,
                )
                results = results_long_term + results_user
            else:
                raise NotImplementedError(str(type(text_mem_base)))
        except Exception as e:
            logger.error("Fail to search. The exception is %s.", e, exc_info=True)
            results = []
        return results
