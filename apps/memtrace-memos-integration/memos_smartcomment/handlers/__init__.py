# ruff: noqa: N999
"""Add and Search Hook callbacks behind one plugin interface."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from memos_smartcomment.handlers.add_handler import AddHandler
from memos_smartcomment.handlers.search_handler import SearchHandler


if TYPE_CHECKING:
    from collections.abc import Callable

    from memos_smartcomment.events import DeferredTraceEvent, TraceEvent


__all__ = ["AddHandler", "HookHandlers", "SearchHandler"]


class HookHandlers(AddHandler, SearchHandler):
    """Combine add and search callbacks behind the existing plugin interface.

    Both handlers use super() so initialization follows
    AddHandler -> SearchHandler -> BaseHandler, sharing one event sink while
    keeping their correlation caches separate.
    """

    def __init__(
        self,
        submit: Callable[[TraceEvent], Any],
        *,
        max_value_chars: int = 20_000,
        max_pending_adds: int = 1024,
        defer_search: Callable[[DeferredTraceEvent], Any] | None = None,
    ) -> None:
        super().__init__(submit, max_value_chars=max_value_chars, max_pending_adds=max_pending_adds)
        self._defer_search = defer_search

    def clear(self) -> None:
        """Release both flows' correlation state at shutdown."""
        AddHandler.clear(self)
        SearchHandler.clear(self)
