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
    SEARCH_RESULTS_AFTER_THRESHOLD = "search.results.after_threshold"
    SEARCH_RESULTS_AFTER_DEDUP = "search.results.after_dedup"
    SEARCH_RESULTS_AFTER_RERANK = "search.results.after_rerank"
    SEARCH_CONTEXT_RENDER = "search.context.render"
    SEARCH_POST_PROCESS_FAILED = "search.post_process.failed"

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

    # textual memory — write boundary
    TEXT_MEMORY_ADD_AFTER = "text_memory.add.after"
    TEXT_MEMORY_ADD_FAILED = "text_memory.add.failed"

    # scheduler — memory operation boundaries inside task handlers
    SCHEDULER_MEMORY_OPERATION_AFTER = "scheduler.memory.operation.after"
    SCHEDULER_MEMORY_OPERATION_FAILED = "scheduler.memory.operation.failed"

    # mem_reader — memory extraction
    MEM_READER_EXTRACT_AFTER = "mem_reader.extract.after"
    MEM_READER_EXTRACT_FAILED = "mem_reader.extract.failed"


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
    H.SEARCH_BEFORE,
    description="Before search executes; can modify request",
    params=["hook_context", "request"],
    pipe_key="request",
)

define_hook(
    H.SEARCH_AFTER,
    description="After search executes; can modify result",
    params=["hook_context", "request", "result"],
    pipe_key="result",
)

define_hook(
    H.SEARCH_MEMORY_RESULTS,
    description=(
        "Allow plugins to merge additional search result buckets before core "
        "threshold, deduplication, and reranking."
    ),
    params=["hook_context", "handler", "search_req", "results"],
    pipe_key="results",
)

define_hook(
    H.SEARCH_RESULTS_AFTER_THRESHOLD,
    description="Allow plugins to observe or update search results after threshold filtering.",
    params=["hook_context", "handler", "search_req", "results"],
    pipe_key="results",
)

define_hook(
    H.SEARCH_RESULTS_AFTER_DEDUP,
    description="Allow plugins to observe or update search results after deduplication.",
    params=["hook_context", "handler", "search_req", "results"],
    pipe_key="results",
)

define_hook(
    H.SEARCH_RESULTS_AFTER_RERANK,
    description="Allow plugins to update search results after core rerank and before rendering.",
    params=["hook_context", "handler", "search_req", "results"],
    pipe_key="results",
)

define_hook(
    H.SEARCH_CONTEXT_RENDER,
    description="Render final search context after retrieval, rerank, and result-level plugins.",
    params=["hook_context", "handler", "search_req", "results"],
    pipe_key="results",
)

define_hook(
    H.SEARCH_POST_PROCESS_FAILED,
    description=(
        "Observe a failure during core search result processing: "
        "threshold filtering, deduplication, or reranking"
    ),
    params=["hook_context", "handler", "search_req", "error"],
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

# Operation-boundary Hooks. Their business data remains explicit in the
# normal keyword-argument contract. HookContext only carries correlation
# metadata.
define_hook(
    H.TEXT_MEMORY_ADD_AFTER,
    description="Observe or replace CubeView Textual Memory output after add returns",
    params=["hook_context", "text_memory", "memories", "kwargs", "result"],
    pipe_key="result",
)

define_hook(
    H.TEXT_MEMORY_ADD_FAILED,
    description="Observe CubeView Textual Memory input and output after add fails",
    params=["hook_context", "text_memory", "memories", "kwargs", "error"],
)

define_hook(
    H.SCHEDULER_MEMORY_OPERATION_AFTER,
    description="Observe or replace a successful Scheduler memory operation result",
    params=["hook_context", "operation", "operation_input", "result"],
    pipe_key="result",
)

define_hook(
    H.SCHEDULER_MEMORY_OPERATION_FAILED,
    description="Observe a failed Scheduler memory operation and its error",
    params=["hook_context", "operation", "operation_input", "error"],
)

define_hook(
    H.MEM_READER_EXTRACT_AFTER,
    description="Observe or replace MemReader output after extraction completes",
    params=[
        "hook_context",
        "mem_reader",
        "scene_data",
        "type",
        "info",
        "mode",
        "user_name",
        "kwargs",
        "result",
    ],
    pipe_key="result",
)

define_hook(
    H.MEM_READER_EXTRACT_FAILED,
    description="Observe MemReader extraction input and propagated error after processing fails",
    params=[
        "hook_context",
        "mem_reader",
        "scene_data",
        "type",
        "info",
        "mode",
        "user_name",
        "kwargs",
        "error",
    ],
)
