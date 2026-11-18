"""Project memory request fields (mixin classes).

These mixins carry every project-memory-specific field.  The core request
models (APISearchRequest, APIADDRequest, GetMemoryRequest, DeleteMemoryRequest)
inherit from the appropriate mixin in their class header — a one-line change per
class that is identical in the open-source version and the enterprise version.

Placing the fields here rather than directly in product_models.py achieves two
things:
1. No duplicate field declarations when the enterprise version is merged.
   Enterprise defines allow_memory_view / include_memory_view in its own models;
   inheriting from the mixin via multiple-inheritance makes the enterprise
   declaration win (Python MRO: later base classes lose to earlier / subclass).
2. The validation logic (space_ids normalisation, project extraction, limit
   checks) lives in one place and is not scattered across product_models.py,
   where enterprise validators also run.
"""

from __future__ import annotations

from typing import Annotated, Any

from pydantic import BaseModel, Field, model_validator


PROJECT_MEMORY_VIEW = "project"
PROJECT_MAX_SPACES = 20


def normalize_str_list(value: str | list[str] | None, field: str) -> list[str]:
    """Normalise a str-or-list field: single string → one-element list;
    None → empty list; duplicates removed; blanks rejected with 422."""
    if value is None:
        return []
    items: list[str] = [value] if isinstance(value, str) else list(value)
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item is None or (isinstance(item, str) and item.strip() == ""):
            raise ValueError(f"{field} must not contain null or empty values")
        key = item if isinstance(item, str) else str(item)
        if key not in seen:
            seen.add(key)
            out.append(item)
    return out


def _extract_project(views: list[str] | None) -> tuple[list[str], bool, bool]:
    """Remove 'project' from the view list and return
    (remaining_views, project_requested, project_only).
    """
    if not views:
        return (views or []), False, False
    remaining = [v for v in views if v != PROJECT_MEMORY_VIEW]
    requested = len(remaining) < len(views)
    return remaining, requested, requested and not remaining


class ProjectSearchFields(BaseModel):
    """Fields added to APISearchRequest for project memory."""

    # Allow-list of memory views; enterprise version declares this field too —
    # the enterprise declaration takes precedence (MRO).
    include_memory_view: list[str] | None = Field(
        None,
        description=(
            "Memory views to search. Include 'project' to search project memory; "
            "'project' is never included by default."
        ),
    )
    space_ids: str | list[str] | None = Field(
        None,
        description="Project spaces to search. Required when 'project' is requested.",
    )
    domains: str | list[str] | None = Field(
        None,
        description="Registered domain names to narrow project memory search.",
    )
    conversation_id: str | None = Field(
        None,
        description="Current conversation; topics sourced from it are prioritised.",
    )
    memory_limit_number: int | None = Field(
        None,
        description=(
            "Max topics returned (project memory). "
            "Default 9; silently capped at 25. "
            "Does not affect other memory view quotas."
        ),
    )

    # Internal flags set by the before-validator; excluded from API schema.
    project_view_flag: Annotated[bool, Field(exclude=True, repr=False)] = False
    project_view_only_flag: Annotated[bool, Field(exclude=True, repr=False)] = False

    @model_validator(mode="before")
    @classmethod
    def _extract_project_view(cls, data: Any) -> Any:
        """Set project_view flags; keep 'project' in the view list so that
        has_project_view can detect it even when the plugin is not loaded.

        Also fills readable_cube_ids from space_ids: the enterprise version's
        validator requires readable_cube_ids, but a project-only search is served
        by the plugin and never touches those cubes.  A Space is a cube
        (user_name = space_id), so the value is semantically correct.
        """
        if not isinstance(data, dict):
            return data
        views = data.get("include_memory_view")
        if isinstance(views, str):
            views = [views]
        _, requested, only = _extract_project(views)
        if requested:
            data = dict(data)
            data["project_view_flag"] = True
            data["project_view_only_flag"] = only
            if not data.get("readable_cube_ids"):
                spaces = data.get("space_ids")
                if isinstance(spaces, str):
                    spaces = [spaces]
                if spaces:
                    data["readable_cube_ids"] = list(spaces)
        return data


class ProjectAddFields(BaseModel):
    """Fields added to APIADDRequest for project memory."""

    allow_memory_view: list[str] | None = Field(
        None,
        description=(
            "Memory views to generate. Include 'project' to build project memory; "
            "only 'project' means no personal memory is generated."
        ),
    )
    space_ids: str | list[str] | None = Field(
        None,
        description="Project spaces to organise into. Required when 'project' is requested.",
    )
    domains: str | list[str] | None = Field(
        None,
        description="Registered domain names for the write. Defaults to all Space domains.",
    )
    agent_id: str | list[str] | None = Field(
        None,
        description="Agent whose output is being recorded.",
    )
    conversation_id: str | None = Field(
        None,
        description="Conversation / session identifier (alias of session_id for project memory).",
    )

    project_view_flag: Annotated[bool, Field(exclude=True, repr=False)] = False
    project_view_only_flag: Annotated[bool, Field(exclude=True, repr=False)] = False

    @model_validator(mode="before")
    @classmethod
    def _extract_project_view(cls, data: Any) -> Any:
        """Set project_view flags. Does not remove 'project' from the list; that
        lets the enterprise validator see it and handle it via the mixin's flags."""
        if not isinstance(data, dict):
            return data
        views = data.get("allow_memory_view")
        if isinstance(views, str):
            views = [views]
        _, requested, only = _extract_project(views)
        if requested:
            data = dict(data)
            data["project_view_flag"] = True
            data["project_view_only_flag"] = only
            # Sync conversation_id <-> session_id alias
            if data.get("conversation_id") and not data.get("session_id"):
                data["session_id"] = data["conversation_id"]
            elif data.get("session_id") and not data.get("conversation_id"):
                data["conversation_id"] = data["session_id"]
        return data


class ProjectScopeFields(BaseModel):
    """Fields added to GetMemoryRequest and DeleteMemoryRequest."""

    space_id: str | None = Field(
        None,
        description=(
            "Project memory: read or delete topics of this space. "
            "Mutually exclusive with mem_cube_id when used for project topics."
        ),
    )

    @model_validator(mode="before")
    @classmethod
    def _fill_cube_id_from_space(cls, data: Any) -> Any:
        """GetMemoryRequest declares mem_cube_id as required.  When a project
        request addresses a space instead, fill mem_cube_id from space_id so the
        required-field check passes; the route branches to project memory before
        mem_cube_id is used."""
        if not isinstance(data, dict):
            return data
        if data.get("space_id") and not data.get("mem_cube_id"):
            data = dict(data)
            data["mem_cube_id"] = data["space_id"]
        return data
