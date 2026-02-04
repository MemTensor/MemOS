from __future__ import annotations

from dataclasses import dataclass

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
    def __init__(self, *, base_url: str = "/demo/ao-tai/assets"):
        self._base_url = base_url.rstrip("/")

    def get_background(self, req: BackgroundRequest) -> BackgroundAsset:
        return BackgroundAsset(
            scene_id=req.scene_id,
            asset_url=f"{self._base_url}/bg_{req.scene_id}.svg",
            type="svg",
            meta={"style": req.style, "animate": req.animate},
        )
