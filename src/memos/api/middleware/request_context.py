"""
Request context middleware for automatic trace_id injection.
"""

import time

from collections.abc import Callable

from fastapi.responses import StreamingResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

import memos.log

from memos.context.context import RequestContext, generate_trace_id, set_request_context


async def _tee_stream(
    original: StreamingResponse,
) -> StreamingResponse:
    chunks = []

    async for chunk in original.body_iterator:
        chunks.append(chunk)
        yield chunk

    body_str = "".join(chunks).decode("utf-8", errors="replace")

    logger.info(f"Response content: {body_str}")


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

        env = request.headers.get("x-env")
        user_type = request.headers.get("x-user-type")
        user_name = request.headers.get("x-user-name")
        start_time = time.time()

        # Create and set request context
        context = RequestContext(
            trace_id=trace_id,
            api_path=request.url.path,
            env=env,
            user_type=user_type,
            user_name=user_name,
        )
        set_request_context(context)

        # Log request start with parameters
        params_log = {}

        # Get query parameters
        if request.query_params:
            params_log["query_params"] = dict(request.query_params)

        logger.info(f"Request started, params: {params_log}, headers: {request.headers}")

        # Process the request
        response = await call_next(request)
        end_time = time.time()
        content = _tee_stream(response)

        if response.status_code == 200:
            logger.info(
                f"Request completed: {request.url.path}, content: {content}, status: {response.status_code}, cost: {(end_time - start_time) * 1000:.2f}ms"
            )
        else:
            logger.error(
                f"Request Failed: {request.url.path}, content: {content}, status: {response.status_code}, cost: {(end_time - start_time) * 1000:.2f}ms"
            )

        return response
