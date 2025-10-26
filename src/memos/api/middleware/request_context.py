"""
Request context middleware for automatic trace_id injection.
"""

import os
import time

from collections.abc import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

import memos.log

from memos.context.context import RequestContext, generate_trace_id, set_request_context


logger = memos.log.get_logger(__name__)

print("ARMS_APP_NAME", os.environ["ARMS_APP_NAME"])
print("ARMS_REGION_ID", os.environ["ARMS_REGION_ID"])
print("ARMS_LICENSE_KEY", os.environ["ARMS_LICENSE_KEY"])


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

        start_time = time.time()

        # Create and set request context
        context = RequestContext(trace_id=trace_id, api_path=request.url.path)
        set_request_context(context)

        # Log request start with parameters
        params_log = {}

        # Get query parameters
        if request.query_params:
            params_log["query_params"] = dict(request.query_params)

        logger.info(f"Request started, params: {params_log}, headers: {request.headers}")

        # Process the request
        try:
            response = await call_next(request)
            end_time = time.time()
            logger.info(f"response is: {response.body}")

            # 记录请求状态
            if response.status_code == 200:
                logger.info(
                    f"Request completed: {request.url.path}, status: {response.status_code}, cost: {(end_time - start_time) * 1000:.2f}ms"
                )
            else:
                logger.error(
                    f"Request Failed: {request.url.path}, status: {response.status_code}, cost: {(end_time - start_time) * 1000:.2f}ms"
                )
        except Exception as e:
            end_time = time.time()
            logger.error(
                f"Request Exception Error: {e}, cost: {(end_time - start_time) * 1000:.2f}ms"
            )
            raise e

        return response
