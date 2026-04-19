import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from starlette.staticfiles import StaticFiles

from memos.api.exceptions import APIExceptionHandler
from memos.api.middleware.agent_auth import AgentAuthMiddleware
from memos.api.middleware.rate_limit import RateLimitMiddleware
from memos.api.middleware.request_context import RequestContextMiddleware
from memos.api.routers.admin_router import router as admin_router
from memos.api.routers.server_router import router as server_router


load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(
    title="MemOS Server REST APIs",
    description="A REST API for managing multiple users with MemOS Server.",
    version="1.0.1",
)

app.mount("/download", StaticFiles(directory=os.getenv("FILE_LOCAL_PATH")), name="static_mapping")

# Middleware execution order (outermost first):
# 1. RateLimitMiddleware — reject excessive requests before any processing
# 2. AgentAuthMiddleware — validate per-agent API keys, bind user_id to context
# 3. RequestContextMiddleware — inject trace_id, log request metadata
app.add_middleware(RateLimitMiddleware)
app.add_middleware(AgentAuthMiddleware)
app.add_middleware(RequestContextMiddleware, source="server_api")
# Include routers
app.include_router(server_router)
app.include_router(admin_router)


@app.get("/health")
def health_check():
    """Container and load balancer health endpoint."""
    return {
        "status": "healthy",
        "service": "memos",
        "version": app.version,
    }


# Request validation failed
app.exception_handler(RequestValidationError)(APIExceptionHandler.validation_error_handler)
# Invalid business code parameters
app.exception_handler(ValueError)(APIExceptionHandler.value_error_handler)
# Business layer manual exception
app.exception_handler(HTTPException)(APIExceptionHandler.http_error_handler)
# Fallback for unknown errors
app.exception_handler(Exception)(APIExceptionHandler.global_exception_handler)


if __name__ == "__main__":
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()
    bind_host = os.getenv("MEMOS_BIND_HOST", "127.0.0.1")
    uvicorn.run("memos.api.server_api:app", host=bind_host, port=args.port, workers=args.workers)
