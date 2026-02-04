from __future__ import annotations

import os
import zlib

from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar
from urllib.parse import quote

from aotai_hike.schemas import BackgroundAsset


@dataclass
class BackgroundRequest:
    scene_id: str
    style: str = "pixel"
    animate: bool = False


class BackgroundProvider:
    def get_background(self, req: BackgroundRequest) -> BackgroundAsset:
        raise NotImplementedError


class StaticBackgroundProvider(BackgroundProvider):
    """Pick a background from the user's local pixel asset library.

    Rules (demo-friendly):
    - Prefer user-provided raster assets under `frontend/assets/` (png/jpg/webp/gif).
    - Exclude avatars and legacy `bg_*.svg`.
    - Deterministically map `scene_id` -> one asset, so the same scene is stable.

    You can refine selection by setting env vars:
      - AOTAI_BG_INCLUDE: substring that must appear in filename (case-insensitive)
      - AOTAI_BG_EXCLUDE: substring that must NOT appear in filename (case-insensitive)
    """

    _IMG_EXTS: ClassVar[frozenset[str]] = frozenset(
        {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}
    )

    def __init__(
        self,
        *,
        base_url: str = "/demo/ao-tai/assets",
        assets_dir: Path | None = None,
    ):
        self._base_url = base_url.rstrip("/")

        if assets_dir is None:
            # .../AOTAI_Hike/backend/aotai_hike/adapters/background.py -> parents[3] is demo root
            assets_dir = Path(__file__).resolve().parents[3] / "frontend" / "assets"
        self._assets_dir = assets_dir

        inc = os.getenv("AOTAI_BG_INCLUDE", "")
        exc = os.getenv("AOTAI_BG_EXCLUDE", "tilemap")
        self._include = inc.strip().lower() if inc else ""
        self._exclude = exc.strip().lower() if exc else ""

        self._candidates = self._discover_candidates()

    def _discover_candidates(self) -> list[str]:
        if not self._assets_dir.exists():
            return []

        out: list[str] = []
        for p in sorted(self._assets_dir.rglob("*")):
            if not p.is_file():
                continue
            if p.suffix.lower() not in self._IMG_EXTS:
                continue

            rel = p.relative_to(self._assets_dir).as_posix()
            low = rel.lower()

            # Skip avatars
            if low.startswith("avatars/"):
                continue

            # Skip legacy demo backgrounds
            if low.startswith("bg_") and low.endswith(".svg"):
                continue

            # Optional include/exclude substrings
            if self._include and (self._include not in low):
                continue
            if self._exclude and (self._exclude in low):
                continue

            # Skip mock-up style sheets by default
            if "mock up" in low or "mock_up" in low:
                continue

            out.append(rel)

        # If filtering is too strict and yields nothing, fall back to all non-avatar images except legacy bg_*.svg
        if not out:
            for p in sorted(self._assets_dir.rglob("*")):
                if not p.is_file():
                    continue
                if p.suffix.lower() not in self._IMG_EXTS:
                    continue
                rel = p.relative_to(self._assets_dir).as_posix()
                low = rel.lower()
                if low.startswith("avatars/"):
                    continue
                if low.startswith("bg_") and low.endswith(".svg"):
                    continue
                out.append(rel)

        return out

    def _pick(self, scene_id: str) -> str | None:
        if not self._candidates:
            return None
        h = zlib.crc32(scene_id.encode("utf-8"))
        return self._candidates[h % len(self._candidates)]

    def get_background(self, req: BackgroundRequest) -> BackgroundAsset:
        chosen = self._pick(req.scene_id)
        if not chosen:
            # last resort: legacy
            return BackgroundAsset(
                scene_id=req.scene_id,
                asset_url=f"{self._base_url}/bg_{req.scene_id}.svg",
                type="svg",
                meta={"style": req.style, "animate": req.animate, "fallback": True},
            )

        ext = Path(chosen).suffix.lower().lstrip(".")
        # URL encode each segment (handles spaces)
        encoded = "/".join(quote(seg) for seg in chosen.split("/"))
        return BackgroundAsset(
            scene_id=req.scene_id,
            asset_url=f"{self._base_url}/{encoded}",
            type=ext if ext in {"png", "jpg", "jpeg", "webp", "gif", "svg"} else "none",
            meta={
                "style": req.style,
                "animate": req.animate,
                "picked": chosen,
                "candidates": len(self._candidates),
            },
        )
