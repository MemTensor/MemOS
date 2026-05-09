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

    # Custom Hook (manually triggered via trigger_hook)
    ADD_MEMORIES_POST_PROCESS = "add.memories.post_process"

    # mem_reader — generic extension point before LLM extraction
    MEM_READER_PRE_EXTRACT = "mem_reader.pre_extract"

    # memory version — single-provider business hooks
    MEMORY_VERSION_PREPARE_UPDATES = "memory_version.prepare_updates"
    MEMORY_VERSION_APPLY_UPDATES = "memory_version.apply_updates"
    MEMORY_VERSION_APPLY_FEEDBACK_UPDATE = "memory_version.apply_feedback_update"

    # dream — single-provider business hook
    DREAM_EXECUTE = "dream.execute"


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
