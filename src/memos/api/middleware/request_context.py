"""
Request context middleware for automatic trace_id injection.
"""

import logging
import os

from collections.abc import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from memos.api.context.context import RequestContext, set_request_context


logger = logging.getLogger(__name__)


def generate_trace_id() -> str:
    """Generate a random trace_id."""
    return os.urandom(16).hex()


def extract_trace_id_from_headers(request: Request) -> str | None:
    """Extract trace_id from various possible headers with priority: g-trace-id > x-trace-id > trace-id."""
    trace_id = request.headers.get("g-trace-id")
    if trace_id:
        return trace_id

    trace_id = request.headers.get("x-trace-id")
    if trace_id:
        return trace_id

    trace_id = request.headers.get("trace-id")
    if trace_id:
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
        trace_id = extract_trace_id_from_headers(request)
        if not trace_id:
            trace_id = generate_trace_id()

        # Create and set request context
        context = RequestContext(trace_id=trace_id)
        set_request_context(context)

        # Add request metadata to context
        context.set("method", request.method)
        context.set("path", request.url.path)
        context.set("client_ip", request.client.host if request.client else None)

        # Log request start
        logger.info(f"Request started: {request.method} {request.url.path} - trace_id: {trace_id}")
        # Log request start with parameters
        params_log = {}

        # Get query parameters
        if request.query_params:
            params_log["query_params"] = dict(request.query_params)

        # Get request body if it's available
        try:
            params_log = await request.json()
        except Exception as e:
            logger.error(f"Error getting request body: {e}")
            # If body is not JSON or empty, ignore it

        logger.info(
            f"Request started: {request.method} {request.url.path} - Parameters: {params_log} trace_id: {trace_id}"
        )

        # Process the request
        response = await call_next(request)

        # Get response body for logging
        response_body = None
        if hasattr(response, "body"):
            try:
                response_body = response.body.decode()
            except:
                response_body = str(response.body)

        # Log request completion with output
        logger.info(
            f"Request completed: {request.method} {request.url.path} - trace_id: {trace_id} - status: {response.status_code} - output: {response_body}"
        )

        # Add trace_id to response headers for debugging
        response.headers["x-trace-id"] = trace_id

        return response
