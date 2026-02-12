from __future__ import annotations

import sys

from pathlib import Path

from aotai_hike.router import router
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from loguru import logger


logger.add("demos/AOTAI_Hike/logs/aotai_hike.log", encoding="utf-8", enqueue=True, backtrace=True)


ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"
LOG_DIR = ROOT / "logs"
LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "aotai_hike.log"

app = FastAPI(title="AoTai Pixel Hike Demo", version="0.1.0")

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify actual origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)
app.mount("/demo/ao-tai", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="ao-tai-demo")

# Configure logging: both stdout and file
logger.remove()
# Console output
logger.add(
    sys.stdout,
    level="INFO",
    format="{time:YYYY-MM-DD HH:mm:ss} | {level} | {message}",
    colorize=True,
)
# File output with rotation
logger.add(
    LOG_FILE,
    level="INFO",
    format="{time:YYYY-MM-DD HH:mm:ss} | {level} | {name}:{function}:{line} | {message}",
    rotation="100 MB",  # Rotate when file reaches 100MB
    retention="7 days",  # Keep logs for 7 days
    compression="zip",  # Compress old logs
    encoding="utf-8",
)
