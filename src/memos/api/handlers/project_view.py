"""
Routing for the `project` memory view (project memory).

AddHandler chooses the requested write views and shares the business task ID.
Project view callbacks implement the storage and algorithms. Scheduler handlers
delegate each durable Add stage to the active provider.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from memos.api.project_fields import PROJECT_MEMORY_VIEW
from memos.plugins.hook_defs import H
from memos.plugins.hooks import _hooks


__all__ = [
    "PROJECT_MEMORY_VIEW",
    "ProjectHTTPError",
    "accept_add",
    "delete_topics",
    "get_by_id",
    "get_topic",
    "list_topics",
    "merge_task_status",
    "only_project",
    "project_enabled",
    "search_topics",
    "task_status",
    "wants_project_view",
]


class ProjectHTTPError(HTTPException):
    """A project error with a stable reason used by the plugin response handler."""

    def __init__(self, status_code: int, detail: str, reason: str | None = None):
        super().__init__(status_code=status_code, detail=detail)
        self.reason = reason


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


def _single(hook: str, **kwargs: Any) -> Any:
    """Call the one plugin callback of a single-provider hook.

    Called directly rather than through the generic trigger (which logs every exception
    with a traceback): "Space not found" and parameter errors from the plugin are expected
    4xx answers, not server errors.
    """
    callbacks = _hooks.get(hook) or []
    if len(callbacks) != 1:
        raise RuntimeError(f"hook {hook} needs exactly one provider, found {len(callbacks)}")
    return callbacks[0](**kwargs)


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
        return _single(hook, **kwargs)
    except LookupError as e:
        raise ProjectHTTPError(404, str(e), getattr(e, "reason", None)) from e
    except ValueError as e:
        raise ProjectHTTPError(400, str(e), getattr(e, "reason", None)) from e


def accept_add(request: Any) -> dict[str, Any]:
    """Store messages and enqueue project-memory work. Returns {task_id, status, ...}."""
    return _call(H.PROJECT_MEMORY_ACCEPT, request=request)


def search_topics(request: Any) -> list[dict[str, Any]]:
    return _call(H.PROJECT_MEMORY_SEARCH, request=request) or []


def list_topics(request: Any) -> dict[str, Any]:
    return _call(H.PROJECT_MEMORY_GET, request=request) or {}


def get_by_id(memory_id: str) -> dict[str, Any] | None:
    """Return a project topic or item by ID, or None for the core lookup."""
    if not project_enabled():
        return None
    return _single(H.PROJECT_MEMORY_GET_BY_ID, memory_id=memory_id)


def get_topic(memory_id: str) -> dict[str, Any] | None:
    found = get_by_id(memory_id) or {}
    topics = found.get("topic_detail_list") or []
    return topics[0] if topics else None


def delete_topics(request: Any) -> dict[str, Any]:
    return _call(H.PROJECT_MEMORY_DELETE, request=request) or {}


def merge_task_status(project_task: dict[str, Any], core: Any) -> dict[str, Any]:
    """Combine both memory views, giving running work priority over a failure."""
    items = getattr(core, "data", None) or []
    if not items:
        return project_task
    item = items[0]
    core_status = getattr(item, "status", None) or (
        item.get("status") if isinstance(item, dict) else None
    )
    statuses = {project_task.get("status"), core_status}
    if statuses & {"in_progress", "waiting"}:
        merged = "in_progress"
    elif statuses & {"failed", "cancelled"}:
        merged = "failed"
    else:
        merged = "completed"
    out = dict(project_task, status=merged)
    core_views = getattr(item, "memory_views", None)
    if isinstance(item, dict):
        core_views = item.get("memory_views", core_views)
    if isinstance(core_views, dict):
        views = dict(core_views)
        project_views = project_task.get("memory_views") or {}
        for k in ("added", "updated", "deleted"):
            views[k] = int(views.get(k) or 0) + int(project_views.get(k) or 0)
        views["project"] = project_views.get("project")
        out["memory_views"] = views
    return out


def task_status(task_id: str, user_id: str) -> dict[str, Any] | None:
    if not project_enabled():
        return None
    return _single(H.PROJECT_MEMORY_TASK_STATUS, task_id=task_id, user_id=user_id)
