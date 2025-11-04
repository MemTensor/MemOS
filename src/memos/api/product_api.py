import logging

from fastapi import FastAPI

from memos.api.exceptions import APIExceptionHandler
from memos.api.middleware.request_context import RequestContextMiddleware
from memos.api.routers.product_router import router as product_router


# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(
    title="MemOS Product REST APIs",
    description="A REST API for managing multiple users with MemOS Product.",
    version="1.0.1",
)

app.add_middleware(RequestContextMiddleware, source="product_api")
# Include routers
app.include_router(product_router)

# Exception handlers
app.exception_handler(ValueError)(APIExceptionHandler.value_error_handler)
app.exception_handler(Exception)(APIExceptionHandler.global_exception_handler)


if __name__ == "__main__":
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()
    uvicorn.run("memos.api.product_api:app", host="0.0.0.0", port=args.port, workers=args.workers)
