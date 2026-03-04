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


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  CE custom Hook declarations (@hookable-generated ones need not be declared here)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

define_hook(
    H.ADD_MEMORIES_POST_PROCESS,
    description="Post-process result after add_memories returns, before constructing Response",
    params=["request", "result"],
    pipe_key="result",
)
