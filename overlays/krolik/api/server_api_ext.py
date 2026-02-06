"""
Extended Server API for Krolik deployment.

This module extends the base MemOS server_api with:
- API Key Authentication (PostgreSQL-backed)
- Redis Rate Limiting
- Admin API for key management
- Security Headers

Usage in Dockerfile:
    # Copy overlays after base installation
    COPY overlays/krolik/ /app/src/memos/

    # Use this as entrypoint instead of server_api
    CMD ["gunicorn", "memos.api.server_api_ext:app", ...]
"""

import logging
import os

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

# Import Krolik extensions
from memos.api.middleware.rate_limit import RateLimitMiddleware
from memos.api.routers.admin_router import router as admin_router

# Import base routers from MemOS
from memos.api.routers.server_router import router as server_router


# Try to import exception handlers (may vary between MemOS versions)
try:
    from memos.api.exceptions import APIExceptionHandler

    HAS_EXCEPTION_HANDLER = True
except ImportError:
    HAS_EXCEPTION_HANDLER = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to all responses."""

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
        return response


# Create FastAPI app
app = FastAPI(
    title="MemOS Server REST APIs (Krolik Extended)",
    description="MemOS API with authentication, rate limiting, and admin endpoints.",
    version="2.0.3-krolik",
)

# CORS configuration
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "").split(",")
CORS_ORIGINS = [origin.strip() for origin in CORS_ORIGINS if origin.strip()]

if not CORS_ORIGINS:
    CORS_ORIGINS = [
        "https://krolik.hully.one",
        "https://memos.hully.one",
        "http://localhost:3000",
    ]

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-API-Key", "X-User-Name"],
)

# Security headers
app.add_middleware(SecurityHeadersMiddleware)

# Rate limiting (before auth to protect against brute force)
RATE_LIMIT_ENABLED = os.getenv("RATE_LIMIT_ENABLED", "true").lower() == "true"
if RATE_LIMIT_ENABLED:
    app.add_middleware(RateLimitMiddleware)
    logger.info("Rate limiting enabled")

# Include routers
app.include_router(server_router)
app.include_router(admin_router)

# Exception handlers
if HAS_EXCEPTION_HANDLER:
    from fastapi import HTTPException

    app.exception_handler(RequestValidationError)(APIExceptionHandler.validation_error_handler)
    app.exception_handler(ValueError)(APIExceptionHandler.value_error_handler)
    app.exception_handler(HTTPException)(APIExceptionHandler.http_error_handler)
    app.exception_handler(Exception)(APIExceptionHandler.global_exception_handler)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "version": "2.0.3-krolik",
        "auth_enabled": os.getenv("AUTH_ENABLED", "false").lower() == "true",
        "rate_limit_enabled": RATE_LIMIT_ENABLED,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("memos.api.server_api_ext:app", host="0.0.0.0", port=8000, workers=1)
