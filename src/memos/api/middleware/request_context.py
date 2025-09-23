"""
Request context middleware for automatic trace_id injection.
"""

from collections.abc import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

import memos.log

from memos.context.context import RequestContext, generate_trace_id, set_request_context


logger = memos.log.get_logger(__name__)


def extract_trace_id_from_headers(request: Request) -> str | None:
    """Extract trace_id from various possible headers with priority: g-trace-id > x-trace-id > trace-id."""
    for header in ["g-trace-id", "x-trace-id", "trace-id"]:
        if trace_id := request.headers.get(header):
            return trace_id
    return None


class RequestContextMiddleware(BaseHTTPMiddleware):
    """
    Middleware to automatically inject request context for every HTTP request.

    This middleware:
    1. Extracts trace_id from headers or generates a new one
    2. Creates a RequestContext and sets it globally
    3. Ensures the context is available throughout the request lifecycle
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        # Extract or generate trace_id
        trace_id = extract_trace_id_from_headers(request) or generate_trace_id()

        # Create and set request context
        context = RequestContext(trace_id=trace_id, api_path=request.url.path)
        set_request_context(context)

        # Log request start with parameters
        params_log = {}

        # Get query parameters
        if request.query_params:
            params_log["query_params"] = dict(request.query_params)

        logger.info(f"Request started: {request.method} {request.url.path}, {params_log}")

        # Process the request
        response = await call_next(request)

        # Log request completion with output
        logger.info(f"Request completed: {request.url.path}, status: {response.status_code}")

        # Add trace_id to response headers for debugging
        response.headers["x-trace-id"] = trace_id

        return response
