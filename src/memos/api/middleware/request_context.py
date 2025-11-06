"""
Request context middleware for automatic trace_id injection.
"""

import time

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

    def __init__(self, app, source: str | None = None):
        """
        Initialize the middleware.

        Args:
            app: The ASGI application
            source: Source identifier (e.g., 'product' or 'server') to distinguish request origin
        """
        super().__init__(app)
        self.source = source or "api"

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
            source=self.source,
        )
        set_request_context(context)

        logger.info(
            f"Request started, source: {self.source}, method: {request.method}, path: {request.url.path}, "
            f"headers: {request.headers}"
        )

        response = await call_next(request)
        end_time = time.time()

        # Process the request
        try:
            if not response:
                logger.error(
                    f"Request Failed No Response, path: {request.url.path}, status: {response.status_code}, cost: {(end_time - start_time) * 1000:.2f}ms"
                )

                return response

            if response.status_code == 200:
                logger.info(
                    f"Request completed: source: {self.source}, path: {request.url.path}, status: {response.status_code}, cost: {(end_time - start_time) * 1000:.2f}ms"
                )
            else:
                logger.error(
                    f"Request Failed: source: {self.source}, path: {request.url.path}, status: {response.status_code}, cost: {(end_time - start_time) * 1000:.2f}ms"
                )
        except Exception as e:
            end_time = time.time()
            logger.error(
                f"Request Exception Error: source: {self.source}, path: {request.url.path}, error: {e}, cost: {(end_time - start_time) * 1000:.2f}ms"
            )

        return response
