"""
Global request context management for trace_id and request-scoped data.

This module provides optional trace_id functionality that can be enabled
when using the API components. It uses ContextVar to ensure thread safety
and request isolation.
"""

import uuid

from collections.abc import Callable
from contextvars import ContextVar
from typing import Any


# Global context variable for request-scoped data
_request_context: ContextVar[dict[str, Any] | None] = ContextVar("request_context", default=None)


class RequestContext:
    """
    Request-scoped context object that holds trace_id and other request data.

    This provides a Flask g-like object for FastAPI applications.
    """

    def __init__(self, trace_id: str | None = None):
        self.trace_id = trace_id or str(uuid.uuid4())
        self._data: dict[str, Any] = {}

    def set(self, key: str, value: Any) -> None:
        """Set a value in the context."""
        self._data[key] = value

    def get(self, key: str, default: Any | None = None) -> Any:
        """Get a value from the context."""
        return self._data.get(key, default)

    def __setattr__(self, name: str, value: Any) -> None:
        if name.startswith("_") or name == "trace_id":
            super().__setattr__(name, value)
        else:
            if not hasattr(self, "_data"):
                super().__setattr__(name, value)
            else:
                self._data[name] = value

    def __getattr__(self, name: str) -> Any:
        if hasattr(self, "_data") and name in self._data:
            return self._data[name]
        raise AttributeError(f"'{self.__class__.__name__}' object has no attribute '{name}'")

    def to_dict(self) -> dict[str, Any]:
        """Convert context to dictionary."""
        return {"trace_id": self.trace_id, "data": self._data.copy()}


def set_request_context(context: RequestContext) -> None:
    """
    Set the current request context.

    This is typically called by the API dependency injection system.
    """
    _request_context.set(context.to_dict())


def get_current_trace_id() -> str | None:
    """
    Get the current request's trace_id.

    Returns:
        The trace_id if available, None otherwise.
    """
    context = _request_context.get()
    if context:
        return context.get("trace_id")
    return None


def get_current_context() -> RequestContext | None:
    """
    Get the current request context.

    Returns:
        The current RequestContext if available, None otherwise.
    """
    context_dict = _request_context.get()
    if context_dict:
        ctx = RequestContext(trace_id=context_dict.get("trace_id"))
        ctx._data = context_dict.get("data", {}).copy()
        return ctx
    return None


def require_context() -> RequestContext:
    """
    Get the current request context, raising an error if not available.

    Returns:
        The current RequestContext.

    Raises:
        RuntimeError: If called outside of a request context.
    """
    context = get_current_context()
    if context is None:
        raise RuntimeError(
            "No request context available. This function must be called within a request handler."
        )
    return context


# Type for trace_id getter function
TraceIdGetter = Callable[[], str | None]

# Global variable to hold the trace_id getter function
_trace_id_getter: TraceIdGetter | None = None


def set_trace_id_getter(getter: TraceIdGetter) -> None:
    """
    Set a custom trace_id getter function.

    This allows the logging system to retrieve trace_id without importing
    API-specific modules.
    """
    global _trace_id_getter
    _trace_id_getter = getter


def get_trace_id_for_logging() -> str | None:
    """
    Get trace_id for logging purposes.

    This function is used by the logging system and will use either
    the custom getter function or fall back to the default context.
    """
    if _trace_id_getter:
        try:
            return _trace_id_getter()
        except Exception:
            pass
    return get_current_trace_id()


# Initialize the default trace_id getter
set_trace_id_getter(get_current_trace_id)
