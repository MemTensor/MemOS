from __future__ import annotations

import sys

from pathlib import Path

from aotai_hike.router import router
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from loguru import logger


ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"

app = FastAPI(title="AoTai Pixel Hike Demo", version="0.1.0")
app.include_router(router)
app.mount("/demo/ao-tai", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="ao-tai-demo")

logger.remove()
logger.add(
    sys.stdout,
    level="INFO",
    format="{time:YYYY-MM-DD HH:mm:ss} | {level} | {message}",
)
