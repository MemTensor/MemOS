import logging

from fastapi import FastAPI

from memos.api.exceptions import APIExceptionHandler
from memos.api.routers.product_router import router as product_router


# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(
    title="MemOS Product REST APIs",
    description="A REST API for managing multiple users with MemOS Product.",
    version="1.0.0",
)

# Include routers
app.include_router(product_router)

# Exception handlers
app.exception_handler(ValueError)(APIExceptionHandler.value_error_handler)
app.exception_handler(Exception)(APIExceptionHandler.global_exception_handler)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)
