from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from memos.multi_mem_cube.views import MemCubeView


if TYPE_CHECKING:
    from memos.api.product_models import APIADDRequest
    from memos.multi_mem_cube.single_cube import SingleCubeView


@dataclass
class CompositeCubeView(MemCubeView):
    """
    A composite view over multiple logical cubes.

    For now (fast mode), it simply fan-out writes to all cubes;
    later we can add smarter routing / slow mode here.
    """

    cube_views: list[SingleCubeView]
    logger: Any

    def add_memories(self, add_req: APIADDRequest) -> list[dict[str, Any]]:
        all_results: list[dict[str, Any]] = []

        # fast mode: for each cube view, add memories
        # maybe add more strategies in add_req.async_mode
        for view in self.cube_views:
            self.logger.info(f"[CompositeCubeView] fan-out add to cube={view.cube_id}")
            results = view.add_memories(add_req)
            all_results.extend(results)

        return all_results
