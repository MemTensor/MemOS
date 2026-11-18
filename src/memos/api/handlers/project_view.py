"""
Routing for the `project` memory view (project memory).

The core does three things for project memory:
1. Routes requests that ask for the `project` view to single-provider hooks.
2. The add / search handlers each gain an `intercept` hook so the plugin can
   short-circuit the whole personal-memory pipeline when only `project` is
   needed.  When both kinds are needed, the plugin's `add.after` / `search.after`
   hook appends project results to the core result.
3. Runs the scheduler entry (`PROJECT_MEMORY_TASK_LABEL`).

All business logic lives in the project-memory plugin (`memos.project_memory`).
The core never imports the plugin.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from memos.api.project_fields import PROJECT_MEMORY_VIEW
from memos.plugins.hook_defs import H
from memos.plugins.hooks import _hooks, trigger_single_hook


__all__ = [
    "PROJECT_MEMORY_VIEW",
    "accept_add",
    "delete_topics",
    "get_topic",
    "list_topics",
    "only_project",
    "project_enabled",
    "search_topics",
    "task_status",
    "wants_project_view",
]


def wants_project_view(views: list[str] | None) -> bool:
    """True when the request includes the project memory view."""
    if not views:
        return False
    return PROJECT_MEMORY_VIEW in views


def project_enabled() -> bool:
    """Whether a project-memory plugin is loaded (it registers the accept hook)."""
    return bool(_hooks.get(H.PROJECT_MEMORY_ACCEPT))


def only_project(request: Any) -> bool:
    """`project` is the only requested view: personal memory should be skipped."""
    return bool(getattr(request, "project_view_only_flag", False))


def has_project_view(request: Any) -> bool:
    """True when the request includes project memory (may also include personal views)."""
    if getattr(request, "project_view_flag", False):
        return True
    return wants_project_view(
        getattr(request, "allow_memory_view", None) or getattr(request, "include_memory_view", None)
    )


def require_plugin_or_400(request: Any) -> None:
    """When the request asks for project memory but the plugin is not loaded,
    raise 400.  Called by the hookable intercept guard."""
    if has_project_view(request) and not project_enabled():
        from fastapi import HTTPException

        raise HTTPException(
            status_code=400,
            detail=(
                "memory view `project` is not enabled on this server; "
                "set MEMOS_ENABLED_PLUGINS=project_memory"
            ),
        )


def _fill_readable_cube_ids(request: Any) -> None:
    """When only project memory is requested and readable_cube_ids is not set,
    fill it with space_ids so the enterprise validator (which requires
    readable_cube_ids) does not reject the request.
    """
    if not getattr(request, "readable_cube_ids", None):
        space_ids = getattr(request, "space_ids", None) or []
        if isinstance(space_ids, str):
            space_ids = [space_ids]
        if space_ids:
            object.__setattr__(request, "readable_cube_ids", list(space_ids))


def _require_plugin() -> None:
    if not project_enabled():
        raise HTTPException(
            status_code=400,
            detail=(
                "memory view `project` is not enabled on this server; "
                "set MEMOS_ENABLED_PLUGINS=project_memory"
            ),
        )


def _call(hook: str, **kwargs: Any) -> Any:
    _require_plugin()
    try:
        return trigger_single_hook(hook, **kwargs)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


def accept_add(request: Any) -> dict[str, Any]:
    """Store messages and enqueue project-memory work. Returns {task_id, status, ...}."""
    return _call(H.PROJECT_MEMORY_ACCEPT, request=request)


def search_topics(request: Any) -> list[dict[str, Any]]:
    return _call(H.PROJECT_MEMORY_SEARCH, request=request) or []


def list_topics(request: Any) -> dict[str, Any]:
    return _call(H.PROJECT_MEMORY_GET, request=request) or {}


def get_topic(memory_id: str) -> dict[str, Any] | None:
    if not project_enabled():
        return None
    return trigger_single_hook(H.PROJECT_MEMORY_GET_BY_ID, memory_id=memory_id)


def delete_topics(request: Any) -> dict[str, Any]:
    return _call(H.PROJECT_MEMORY_DELETE, request=request) or {}


def task_status(task_id: str, user_id: str) -> dict[str, Any] | None:
    if not project_enabled():
        return None
    return trigger_single_hook(H.PROJECT_MEMORY_TASK_STATUS, task_id=task_id, user_id=user_id)
