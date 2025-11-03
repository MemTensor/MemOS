"""
Request context middleware for automatic trace_id injection.
"""

import json
import os
import time

from collections.abc import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

import memos.log

from memos.context.context import RequestContext, generate_trace_id, set_request_context


logger = memos.log.get_logger(__name__)

# Maximum body size to read for logging (in bytes) - bodies larger than this will be skipped
MAX_BODY_LOG_SIZE = os.getenv("MAX_BODY_LOG_SIZE", 10 * 1024)


def extract_trace_id_from_headers(request: Request) -> str | None:
    """Extract trace_id from various possible headers with priority: g-trace-id > x-trace-id > trace-id."""
    for header in ["g-trace-id", "x-trace-id", "trace-id"]:
        if trace_id := request.headers.get(header):
            return trace_id
    return None


def _is_json_request(request: Request) -> tuple[bool, str]:
    """
    Check if request is a JSON request.

    Args:
        request: The request object

    Returns:
        Tuple of (is_json, content_type)
    """
    if request.method not in ("POST", "PUT", "PATCH", "DELETE"):
        return False, ""

    content_type = request.headers.get("content-type", "")
    if not content_type:
        return False, ""

    is_json = "application/json" in content_type.lower()
    return is_json, content_type


def _should_read_body(content_length: str | None) -> tuple[bool, int | None]:
    """
    Check if body should be read based on content-length header.

    Args:
        content_length: Content-Length header value

    Returns:
        Tuple of (should_read, body_size). body_size is None if header is invalid.
    """
    if not content_length:
        return True, None

    try:
        body_size = int(content_length)
        return body_size <= MAX_BODY_LOG_SIZE, body_size
    except ValueError:
        return True, None


def _create_body_info(content_type: str, body_size: int) -> dict:
    """Create body_info dict for large bodies that are skipped."""
    return {
        "content_type": content_type,
        "content_length": body_size,
        "note": f"body too large ({body_size} bytes), skipping read",
    }


def _parse_json_body(body_bytes: bytes) -> dict | str:
    """
    Parse JSON body bytes.

    Args:
        body_bytes: Raw body bytes

    Returns:
        Parsed JSON dict, or error message string if parsing fails
    """
    try:
        return json.loads(body_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        return f"<unable to parse JSON: {e!s}>"


async def get_request_params(request: Request) -> tuple[dict, bytes | None]:
    """
    Extract request parameters (query params and body) for logging.

    Only reads body for application/json requests that are within size limits.

    This function is wrapped with exception handling to ensure logging failures
    don't affect the actual request processing.

    Args:
        request: The incoming request object

    Returns:
        Tuple of (params_dict, body_bytes). body_bytes is None if body was not read.
        Returns empty dict and None on any error.
    """
    try:
        params_log = {}

        # Check if this is a JSON request
        is_json, content_type = _is_json_request(request)
        if not is_json:
            return params_log, None

        # Pre-check body size using content-length header
        content_length = request.headers.get("content-length")
        should_read, body_size = _should_read_body(content_length)

        if not should_read and body_size is not None:
            params_log["body_info"] = _create_body_info(content_type, body_size)
            return params_log, None

        # Read body
        body_bytes = await request.body()

        if not body_bytes:
            return params_log, None

        # Post-check: verify actual size (content-length might be missing or wrong)
        actual_size = len(body_bytes)
        if actual_size > MAX_BODY_LOG_SIZE:
            params_log["body_info"] = _create_body_info(content_type, actual_size)
            return params_log, None

        # Parse JSON body
        params_log["body"] = _parse_json_body(body_bytes)
        return params_log, body_bytes

    except Exception as e:
        # Catch-all for any unexpected errors
        logger.error(f"Unexpected error in get_request_params: {e}", exc_info=True)
        # Return empty dict to ensure request can continue
        return {}, None


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
        self.source = source

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

        # Get request parameters for logging
        # Wrap in try-catch to ensure logging failures don't break the request
        params_log, body_bytes = await get_request_params(request)

        # Re-create the request receive function if body was read
        # This ensures downstream handlers can still read the body
        if body_bytes is not None:
            try:

                async def receive():
                    return {"type": "http.request", "body": body_bytes, "more_body": False}

                request._receive = receive
            except Exception as e:
                logger.error(f"Failed to recreate request receive function: {e}")
                # Continue without restoring body, downstream handlers will handle it

        source_info = f", source: {self.source}" if self.source else ""
        logger.info(
            f"Request started, method: {request.method}, path: {request.url.path}{source_info}, "
            f"request params: {params_log}, headers: {request.headers}"
        )

        # Process the request
        try:
            response = await call_next(request)
            end_time = time.time()
            source_info = f", source: {self.source}" if self.source else ""
            if response.status_code == 200:
                logger.info(
                    f"Request completed: {request.url.path}{source_info}, status: {response.status_code}, cost: {(end_time - start_time) * 1000:.2f}ms"
                )
            else:
                logger.error(
                    f"Request Failed: {request.url.path}{source_info}, status: {response.status_code}, cost: {(end_time - start_time) * 1000:.2f}ms"
                )
        except Exception as e:
            end_time = time.time()
            source_info = f", source: {self.source}" if self.source else ""
            logger.error(
                f"Request Exception Error: {e}{source_info}, cost: {(end_time - start_time) * 1000:.2f}ms"
            )
            raise e

        return response
