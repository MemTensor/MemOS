import json
import logging
import os
import sys

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


def _validate_auth_config_or_exit() -> None:
    """Refuse to start if auth is required but no usable agent registry exists.

    Previously the server would happily start with ``MEMOS_AUTH_REQUIRED=true``
    and an empty/missing ``agents-auth.json`` — every authenticated request
    would then 401, leaving demo agents memory-blind with no obvious cause.
    Fail loud at startup instead so the operator notices immediately.

    Pass conditions when ``MEMOS_AUTH_REQUIRED=true``:
      - ``MEMOS_AGENT_AUTH_CONFIG`` is set
      - the file at that path exists and is readable
      - it parses as JSON
      - it contains at least one ``agents[*].key_hash`` entry (v2)
        OR at least one ``agents[*].key`` entry (legacy v1)

    Anything else → write a clear stderr message and ``sys.exit(2)`` before
    we bind a port.
    """
    if os.getenv("MEMOS_AUTH_REQUIRED", "false").lower() != "true":
        return  # Auth optional — empty registry is allowed.

    config_path = os.getenv("MEMOS_AGENT_AUTH_CONFIG", "").strip()
    if not config_path:
        print(
            "FATAL: MEMOS_AUTH_REQUIRED=true but MEMOS_AGENT_AUTH_CONFIG is unset. "
            "Run deploy/scripts/setup-memos-agents.py to provision agents and set "
            "MEMOS_AGENT_AUTH_CONFIG to the resulting file path. Refusing to start.",
            file=sys.stderr,
        )
        sys.exit(2)
    if not os.path.exists(config_path):
        print(
            f"FATAL: MEMOS_AUTH_REQUIRED=true but agent-auth file is missing at "
            f"{config_path!r}. Run deploy/scripts/setup-memos-agents.py to "
            f"recreate it. Refusing to start.",
            file=sys.stderr,
        )
        sys.exit(2)
    try:
        with open(config_path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(
            f"FATAL: agent-auth file at {config_path!r} is unreadable or not "
            f"valid JSON ({type(e).__name__}: {e}). Refusing to start.",
            file=sys.stderr,
        )
        sys.exit(2)

    agents = data.get("agents", []) if isinstance(data, dict) else []
    has_v2 = any(a.get("key_hash") for a in agents)
    has_v1 = any(a.get("key") for a in agents)
    if not (has_v2 or has_v1):
        print(
            f"FATAL: agent-auth file at {config_path!r} contains zero agent keys. "
            "Run deploy/scripts/setup-memos-agents.py to provision the demo agents. "
            "Refusing to start.",
            file=sys.stderr,
        )
        sys.exit(2)


_validate_auth_config_or_exit()

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
