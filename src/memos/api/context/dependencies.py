import logging
import os

from fastapi import Depends, Header, Request

from memos.api.context.context import RequestContext, set_request_context


logger = logging.getLogger(__name__)

# Type alias for the RequestContext from context module
G = RequestContext


def get_trace_id_from_header(
    trace_id: str | None = Header(None, alias="trace-id"),
    x_trace_id: str | None = Header(None, alias="x-trace-id"),
    g_trace_id: str | None = Header(None, alias="g-trace-id"),
) -> str | None:
    """
    Extract trace_id from various possible headers.

    Priority: g-trace-id > x-trace-id > trace-id
    """
    return g_trace_id or x_trace_id or trace_id


def generate_trace_id() -> str:
    """
    Get a random trace_id.
    """
    return os.urandom(16).hex()


def get_request_context(
    request: Request, trace_id: str | None = Depends(get_trace_id_from_header)
) -> RequestContext:
    """
    Get request context object with trace_id and request metadata.

    This function creates a RequestContext and automatically sets it
    in the global context for use throughout the request lifecycle.
    """
    # Create context object
    ctx = RequestContext(trace_id=trace_id)

    # Set the context globally for this request
    set_request_context(ctx)

    # Log request start
    logger.info(f"Request started with trace_id: {ctx.trace_id}")

    # Add request metadata to context
    ctx.set("method", request.method)
    ctx.set("path", request.url.path)
    ctx.set("client_ip", request.client.host if request.client else None)

    return ctx


def get_g_object(trace_id: str | None = Depends(get_trace_id_from_header)) -> G:
    """
    Get Flask g-like object for the current request.

    This creates a RequestContext and sets it globally for access
    throughout the request lifecycle.
    """
    if trace_id is None:
        trace_id = generate_trace_id()

    g = RequestContext(trace_id=trace_id)
    set_request_context(g)
    logger.info(f"Request g object created with trace_id: {g.trace_id}")
    return g


def get_current_g() -> G | None:
    """
    Get the current request's g object from anywhere in the application.

    Returns:
        The current request's g object if available, None otherwise.
    """
    from memos.context import get_current_context

    return get_current_context()


def require_g() -> G:
    """
    Get the current request's g object, raising an error if not available.

    Returns:
        The current request's g object.

    Raises:
        RuntimeError: If called outside of a request context.
    """
    from memos.context import require_context

    return require_context()
