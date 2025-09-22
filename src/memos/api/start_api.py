import logging

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import RedirectResponse

from memos.api.exceptions import APIExceptionHandler
from memos.api.middleware.request_context import RequestContextMiddleware
from memos.api.routers.start_router import router as start_router


# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Create FastAPI application
app = FastAPI(
    title="MemOS Basic REST APIs",
    description="A REST API for managing and searching memories using MemOS core functionality.",
    version="1.0.0",
)

app.add_middleware(RequestContextMiddleware)

# Include routers
app.include_router(start_router)

# Exception handlers
app.exception_handler(ValueError)(APIExceptionHandler.value_error_handler)
app.exception_handler(Exception)(APIExceptionHandler.global_exception_handler)


@app.get("/", summary="Redirect to the OpenAPI documentation", include_in_schema=False)
async def home():
    """Redirect to the OpenAPI documentation."""
    return RedirectResponse(url="/docs", status_code=307)


if __name__ == "__main__":
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000, help="Port to run the server on")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Host to run the server on")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    args = parser.parse_args()

    logger.info(f"Starting MemOS Basic API server on {args.host}:{args.port}")
    uvicorn.run("memos.api.start_api:app", host=args.host, port=args.port, reload=args.reload)
