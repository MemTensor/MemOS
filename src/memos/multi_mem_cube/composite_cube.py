from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from memos.multi_mem_cube.views import MemCubeView


if TYPE_CHECKING:
    from memos.api.product_models import APIADDRequest, APIFeedbackRequest, APISearchRequest
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

    def search_memories(self, search_req: APISearchRequest) -> dict[str, Any]:
        # aggregated MOSSearchResult
        merged_results: dict[str, Any] = {
            "text_mem": [],
            "act_mem": [],
            "para_mem": [],
            "pref_mem": [],
            "pref_note": "",
            "tool_mem": [],
        }

        for view in self.cube_views:
            self.logger.info(f"[CompositeCubeView] fan-out search to cube={view.cube_id}")
            cube_result = view.search_memories(search_req)
            merged_results["text_mem"].extend(cube_result.get("text_mem", []))
            merged_results["act_mem"].extend(cube_result.get("act_mem", []))
            merged_results["para_mem"].extend(cube_result.get("para_mem", []))
            merged_results["pref_mem"].extend(cube_result.get("pref_mem", []))
            merged_results["tool_mem"].extend(cube_result.get("tool_mem", []))

            note = cube_result.get("pref_note")
            if note:
                if merged_results["pref_note"]:
                    merged_results["pref_note"] += " | " + note
                else:
                    merged_results["pref_note"] = note

        return merged_results

    def feedback_memories(self, feedback_req: APIFeedbackRequest) -> list[dict[str, Any]]:
        all_results: list[dict[str, Any]] = []

        for view in self.cube_views:
            self.logger.info(f"[CompositeCubeView] fan-out add to cube={view.cube_id}")
            results = view.feedback_memories(feedback_req)
            all_results.extend(results)

        return all_results
