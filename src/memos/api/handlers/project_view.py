"""
Routing for the `project` memory view (project memory).

The core only does three things for project memory:
1. validates request fields (see `product_models.normalize_str_list` / validators),
2. routes requests that ask for the `project` view to single-provider hooks,
3. runs the scheduler entry (`PROJECT_MEMORY_TASK_LABEL`).

All business logic lives in the project-memory plugin (`memos.project_memory`),
which implements the hooks below. The core never imports the plugin.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from memos.api.product_models import PROJECT_MEMORY_VIEW, wants_project_view
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


def project_enabled() -> bool:
    """Whether a project-memory plugin is loaded (it registers the execute hook)."""
    return bool(_hooks.get(H.PROJECT_MEMORY_ACCEPT))


def only_project(views: list[str] | None) -> bool:
    """`project` is the only requested view: skip personal memory entirely."""
    return bool(views) and all(v == PROJECT_MEMORY_VIEW for v in views)


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
    except LookupError as e:  # space / domain not found → 404 semantics
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:  # parameter / configuration errors
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
