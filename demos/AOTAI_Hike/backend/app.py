from __future__ import annotations

from pathlib import Path

from aotai_hike.router import router
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"

app = FastAPI(title="AoTai Pixel Hike Demo", version="0.1.0")
app.include_router(router)
app.mount("/demo/ao-tai", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="ao-tai-demo")
