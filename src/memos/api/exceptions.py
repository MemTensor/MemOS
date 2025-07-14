import logging

from fastapi.requests import Request
from fastapi.responses import JSONResponse


logger = logging.getLogger(__name__)


class APIExceptionHandler:
    """Centralized exception handling for MemOS APIs."""

    @staticmethod
    async def value_error_handler(request: Request, exc: ValueError):
        """Handle ValueError exceptions globally."""
        return JSONResponse(
            status_code=400,
            content={"code": 400, "message": str(exc), "data": None},
        )

    @staticmethod
    async def global_exception_handler(request: Request, exc: Exception):
        """Handle all unhandled exceptions globally."""
        logger.exception("Unhandled error:")
        return JSONResponse(
            status_code=500,
            content={"code": 500, "message": str(exc), "data": None},
        )
