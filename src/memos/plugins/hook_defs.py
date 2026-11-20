"""Hook declaration registry — single source of truth for CE repo Hook points.

The @hookable decorator automatically declares its before/after Hooks; no need to manually define_hook.
Hooks triggered by custom trigger_hook must be explicitly declared in this file.

Plugin-owned Hooks should be declared within each plugin package, not in this file.
"""

from __future__ import annotations

import logging

from dataclasses import dataclass


logger = logging.getLogger(__name__)

_specs: dict[str, HookSpec] = {}


@dataclass(frozen=True)
class HookSpec:
    """Hook spec definition."""

    name: str
    description: str
    params: list[str]
    pipe_key: str | None = None


def define_hook(
    name: str,
    *,
    description: str,
    params: list[str],
    pipe_key: str | None = None,
) -> None:
    """Declare a Hook point. Skips if already exists (idempotent)."""
    if name in _specs:
        return
    _specs[name] = HookSpec(
        name=name,
        description=description,
        params=params,
        pipe_key=pipe_key,
    )
    logger.debug("Hook defined: %s (pipe_key=%s)", name, pipe_key)


def get_hook_spec(name: str) -> HookSpec | None:
    return _specs.get(name)


def all_hook_specs() -> dict[str, HookSpec]:
    """Return all declared Hooks (including @hookable auto-declared + plugin-declared)."""
    return dict(_specs)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  CE Hook name constants
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


class H:
    """CE Hook name constants. Plugin-owned Hook constants should be defined within the plugin package."""

    # @hookable("add") — AddHandler.handle_add_memories
    ADD_BEFORE = "add.before"
    ADD_AFTER = "add.after"

    # @hookable("search") — SearchHandler.handle_search_memories
    SEARCH_BEFORE = "search.before"
    SEARCH_AFTER = "search.after"

    # Search extension point before core threshold/dedup/rerank processing.
    SEARCH_MEMORY_RESULTS = "search.memory_results"
    SEARCH_RESULTS_AFTER_RERANK = "search.results.after_rerank"
    SEARCH_CONTEXT_RENDER = "search.context.render"

    # Custom Hook (manually triggered via trigger_hook)
    ADD_MEMORIES_POST_PROCESS = "add.memories.post_process"

    # mem_reader — generic extension point before LLM extraction
    MEM_READER_PRE_EXTRACT = "mem_reader.pre_extract"
    MEMORY_ITEMS_AFTER_FINE_EXTRACT = "memory_items.after_fine_extract"

    # memory version — single-provider business hooks
    MEMORY_VERSION_PREPARE_UPDATES = "memory_version.prepare_updates"
    MEMORY_VERSION_APPLY_UPDATES = "memory_version.apply_updates"
    MEMORY_VERSION_APPLY_FEEDBACK_UPDATE = "memory_version.apply_feedback_update"

    # dream — single-provider business hook
    DREAM_EXECUTE = "dream.execute"

    # project memory (memory view `project`) — single-provider business hooks.
    # The core only validates fields, routes requests, and runs the scheduler entry;
    # the active project-memory plugin implements all of them.
    PROJECT_MEMORY_ACCEPT = "project_memory.accept"
    PROJECT_MEMORY_EXECUTE = "project_memory.execute"
    PROJECT_MEMORY_PROCESS = "project_memory.process"
    PROJECT_MEMORY_SPACE = "project_memory.space"
    PROJECT_MEMORY_MERGE = "project_memory.merge"
    PROJECT_MEMORY_MERGE_RESULT = "project_memory.merge_result"
    PROJECT_MEMORY_SEARCH = "project_memory.search"
    PROJECT_MEMORY_GET = "project_memory.get"
    PROJECT_MEMORY_GET_BY_ID = "project_memory.get_by_id"
    PROJECT_MEMORY_DELETE = "project_memory.delete"
    PROJECT_MEMORY_TASK_STATUS = "project_memory.task_status"
    PROJECT_MEMORY_MESSAGES = "project_memory.messages"
    # optional: distributed lock for multi-replica deployments (see project_memory/locks.py)
    PROJECT_MEMORY_LOCK = "project_memory.lock"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  CE custom Hook declarations (@hookable-generated ones need not be declared here)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

define_hook(
    H.ADD_MEMORIES_POST_PROCESS,
    description="Post-process result after add_memories returns, before constructing Response",
    params=["request", "result"],
    pipe_key="result",
)

define_hook(
    H.MEM_READER_PRE_EXTRACT,
    description="Customize prompt before mem_reader LLM extraction",
    params=["prompt", "prompt_type", "mem_str", "lang", "sources"],
    pipe_key="prompt",
)

define_hook(
    H.SEARCH_MEMORY_RESULTS,
    description=(
        "Allow plugins to merge additional search result buckets before core "
        "threshold, deduplication, and reranking."
    ),
    params=["handler", "search_req", "results"],
    pipe_key="results",
)

define_hook(
    H.SEARCH_RESULTS_AFTER_RERANK,
    description="Allow plugins to update search results after core rerank and before rendering.",
    params=["handler", "search_req", "results"],
    pipe_key="results",
)

define_hook(
    H.SEARCH_CONTEXT_RENDER,
    description="Render final search context after retrieval, rerank, and result-level plugins.",
    params=["handler", "search_req", "results"],
    pipe_key="results",
)

define_hook(
    H.MEMORY_ITEMS_AFTER_FINE_EXTRACT,
    description="Post-process memory items after mem_reader fine extraction completes",
    params=["items", "user_context", "mem_reader", "extract_mode"],
    pipe_key="items",
)

define_hook(
    H.MEMORY_VERSION_PREPARE_UPDATES,
    description=(
        "Prepare memory-version candidates and decide whether extraction should continue "
        "through the version pipeline"
    ),
    params=["item", "user_name", "judge_llm"],
)

define_hook(
    H.MEMORY_VERSION_APPLY_UPDATES,
    description="Apply memory-version updates during mem_reader extraction",
    params=[
        "item",
        "user_name",
        "version_llm",
        "merge_llm",
        "custom_tags",
        "custom_tags_prompt_template",
        "timeout_sec",
    ],
)

define_hook(
    H.MEMORY_VERSION_APPLY_FEEDBACK_UPDATE,
    description="Apply memory-version update semantics during feedback update",
    params=["old_item", "new_item", "user_name"],
)

define_hook(
    H.DREAM_EXECUTE,
    description=("Execute the active Dream plugin pipeline for a scheduler-triggered dream task"),
    params=[
        "mem_cube_id",
        "user_id",
        "user_name",
        "signal_snapshot",
        "text_mem",
        "scheduler_context",
    ],
)

# ── project memory ────────────────────────────────────────────────────────────

define_hook(
    H.PROJECT_MEMORY_ACCEPT,
    description="Accept an add request for the `project` view: store messages, enqueue work",
    params=["request"],
)

define_hook(
    H.PROJECT_MEMORY_EXECUTE,
    description="Run project-memory organization for one space (scheduler entry)",
    params=["space_id", "batch", "scheduler_context"],
)

for hook, purpose in (
    (H.PROJECT_MEMORY_PROCESS, "Extract one closed Episode"),
    (H.PROJECT_MEMORY_SPACE, "Recall and organize an Episode in its Space"),
    (H.PROJECT_MEMORY_MERGE, "Prepare entry changes for an Episode"),
    (H.PROJECT_MEMORY_MERGE_RESULT, "Finalize and commit the prepared changes"),
):
    define_hook(hook, description=purpose, params=["space_id", "batch", "scheduler_context"])

define_hook(
    H.PROJECT_MEMORY_SEARCH,
    description="Search project memory and return topic_detail_list",
    params=["request"],
)

define_hook(
    H.PROJECT_MEMORY_GET,
    description="List topics of a project space (get_memory with space_id)",
    params=["request"],
)

define_hook(
    H.PROJECT_MEMORY_MESSAGES,
    description="Read the conversation messages stored for project memory",
    params=["conversation_id", "space_id", "limit"],
)

define_hook(
    H.PROJECT_MEMORY_GET_BY_ID,
    description="Read one topic by id; return None when the id is not a project topic",
    params=["memory_id"],
)

define_hook(
    H.PROJECT_MEMORY_DELETE,
    description="Delete topics of a project space (by memory_ids or whole space)",
    params=["request"],
)

define_hook(
    H.PROJECT_MEMORY_LOCK,
    description=(
        "Optional. Return a context manager that holds a lock on `key` across processes; "
        "when not registered, project memory uses in-process locks"
    ),
    params=["key"],
)

define_hook(
    H.PROJECT_MEMORY_TASK_STATUS,
    description="Status and memory_views of a project-memory task; None when unknown",
    params=["task_id", "user_id"],
)
