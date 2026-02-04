from contextlib import asynccontextmanager

import uvicorn

from fastapi import FastAPI, HTTPException

from memos.extras.nli_model.server.config import NLI_DEVICE, NLI_MODEL_HOST, NLI_MODEL_PORT
from memos.extras.nli_model.server.handler import NLIHandler
from memos.extras.nli_model.types import CompareRequest, CompareResponse


# Global handler instance
nli_handler: NLIHandler | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global nli_handler
    nli_handler = NLIHandler(device=NLI_DEVICE)
    yield
    # Clean up if needed
    nli_handler = None


app = FastAPI(lifespan=lifespan)


@app.post("/compare_one_to_many", response_model=CompareResponse)
async def compare_one_to_many(request: CompareRequest):
    if nli_handler is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    try:
        results = nli_handler.compare_one_to_many(request.source, request.targets)
        return CompareResponse(results=results)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


def start_server(host: str = "0.0.0.0", port: int = 32532):
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    start_server(host=NLI_MODEL_HOST, port=NLI_MODEL_PORT)
