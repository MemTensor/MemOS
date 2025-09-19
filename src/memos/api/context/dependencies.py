import logging

from memos.context.context import RequestContext, get_current_context


logger = logging.getLogger(__name__)

# Type alias for the RequestContext from context module
G = RequestContext


def get_g_object() -> G:
    """
    Get Flask g-like object for the current request.
    Returns the context created by middleware.
    """
    ctx = get_current_context()
    if ctx is None:
        raise RuntimeError(
            "No request context available. Make sure RequestContextMiddleware is properly configured."
        )
    return ctx


def get_current_g() -> G | None:
    """
    Get the current request's g object from anywhere in the application.

    Returns:
        The current request's g object if available, None otherwise.
    """
    return get_current_context()


def require_g() -> G:
    """
    Get the current request's g object, raising an error if not available.

    Returns:
        The current request's g object.

    Raises:
        RuntimeError: If called outside of a request context.
    """
    ctx = get_current_context()
    if ctx is None:
        raise RuntimeError(
            "No request context available. This function must be called within a request handler."
        )
    return ctx
