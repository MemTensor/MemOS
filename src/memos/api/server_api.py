import logging
import os

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from starlette.staticfiles import StaticFiles

from memos.api.exceptions import APIExceptionHandler
from memos.api.lifecycle import shutdown_components
from memos.api.middleware.request_context import RequestContextMiddleware
from memos.api.routers import server_router as server_router_module
from memos.plugins.manager import plugin_manager

# OTel: bootstrap the SDK (TracerProvider + OTLP exporters) from the environment,
# then instrument FastAPI so agent HTTP calls produce end-to-end traces.
#
# configure_from_env() MUST run before FastAPIInstrumentor.instrument_app() so the
# instrumentor binds to the real (exporting) TracerProvider rather than the global
# no-op default.  It is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set, so local
# runs without a collector stay silent.  In the memory-benchmark cluster we set
# OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.observability:4317.
from memos import telemetry as _telemetry

try:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor as _FastAPIInstrumentor
    _OTEL_FASTAPI_AVAILABLE = True
except ImportError:
    _OTEL_FASTAPI_AVAILABLE = False


load_dotenv()

plugin_manager.discover()

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)
logger.info(
    "[SERVER_API] load_dotenv completed. env_MEMSCHEDULER_STREAM_KEY_PREFIX=%s, env_MEMSCHEDULER_REDIS_STREAM_KEY_PREFIX=%s",
    os.getenv("MEMSCHEDULER_STREAM_KEY_PREFIX"),
    os.getenv("MEMSCHEDULER_REDIS_STREAM_KEY_PREFIX"),
)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield
    shutdown_components(server_router_module.components)


app = FastAPI(
    title="MemOS Server REST APIs",
    description="A REST API for managing multiple users with MemOS Server.",
    version="1.0.1",
    lifespan=lifespan,
)

app.mount("/download", StaticFiles(directory=os.getenv("FILE_LOCAL_PATH")), name="static_mapping")

app.add_middleware(RequestContextMiddleware, source="server_api")

# Bootstrap the OTel SDK from env (no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set),
# then attach FastAPI instrumentation. Ordering matters: instrument_app() binds to
# whatever TracerProvider is global at call time, so configure_from_env() runs first.
_OTEL_CONFIGURED = _telemetry.configure_from_env()
if _OTEL_CONFIGURED:
    logger.info(
        "[SERVER_API] OTel telemetry configured -> %s (service=%s)",
        os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        os.getenv("OTEL_SERVICE_NAME", "memos"),
    )
else:
    logger.info("[SERVER_API] OTel telemetry not configured (OTEL_EXPORTER_OTLP_ENDPOINT unset)")

# Attach OTel FastAPI instrumentation. This creates server-side spans for each
# request and propagates W3C traceparent headers, so downstream memory.* spans
# appear nested under the agent's root span.
if _OTEL_FASTAPI_AVAILABLE:
    _FastAPIInstrumentor.instrument_app(app)

# Include routers
app.include_router(server_router_module.router)


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

plugin_manager.init_app(app)


if __name__ == "__main__":
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()
    uvicorn.run("memos.api.server_api:app", host="0.0.0.0", port=args.port, workers=args.workers)
