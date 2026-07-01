from __future__ import annotations

from concurrent.futures import as_completed
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from memos.context.context import ContextThreadPoolExecutor
from memos.multi_mem_cube.views import MemCubeView
from memos.utils import timed_stage


if TYPE_CHECKING:
    from memos.api.product_models import APIADDRequest, APIFeedbackRequest, APISearchRequest
    from memos.multi_mem_cube.single_cube import SingleCubeView


@dataclass
class CompositeCubeView(MemCubeView):
    """
    A composite view over multiple logical cubes.

    By default, writes keep the legacy fan-out behavior. If request metadata
    explicitly names a target cube or responsibility, writes are routed only to
    matching cube views and fall back to fan-out when nothing matches.
    """

    cube_views: list[SingleCubeView]
    logger: Any

    def _request_info(self, request: Any) -> dict[str, Any]:
        info = getattr(request, "info", None)
        return info if isinstance(info, dict) else {}

    def _view_responsibilities(self, view: SingleCubeView) -> set[str]:
        values: set[str] = set()
        for attr in ("responsibility", "responsibilities"):
            raw = getattr(view, attr, None)
            if isinstance(raw, str):
                values.add(raw)
            elif isinstance(raw, (list, tuple, set)):
                values.update(str(item) for item in raw if item)
        return values

    def _route_views(self, request: Any) -> list[SingleCubeView]:
        info = self._request_info(request)
        target_cube_id = info.get("target_cube_id") or info.get("cube_id")
        if target_cube_id:
            routed = [view for view in self.cube_views if view.cube_id == target_cube_id]
            if routed:
                return routed
            self.logger.warning(
                "[CompositeCubeView] target cube %s not found; fallback to fan-out",
                target_cube_id,
            )

        responsibility = info.get("responsibility") or info.get("cube_responsibility")
        if responsibility:
            routed = [
                view
                for view in self.cube_views
                if responsibility in self._view_responsibilities(view)
            ]
            if routed:
                return routed
            self.logger.warning(
                "[CompositeCubeView] responsibility %s not matched; fallback to fan-out",
                responsibility,
            )

        return self.cube_views

    def add_memories(self, add_req: APIADDRequest) -> list[dict[str, Any]]:
        all_results: list[dict[str, Any]] = []
        target_views = self._route_views(add_req)
        cube_count = len(target_views)

        with timed_stage("add", "multi_cube", cube_count=cube_count):
            for idx, view in enumerate(target_views):
                self.logger.info(
                    "[CompositeCubeView] route add to cube=%s (%d/%d)",
                    view.cube_id,
                    idx + 1,
                    cube_count,
                )
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
            "skill_mem": [],
        }

        def _search_single_cube(view: SingleCubeView) -> dict[str, Any]:
            self.logger.info(f"[CompositeCubeView] fan-out search to cube={view.cube_id}")
            return view.search_memories(search_req)

        # parallel search for each cube
        with ContextThreadPoolExecutor(max_workers=2) as executor:
            future_to_view = {
                executor.submit(_search_single_cube, view): view for view in self.cube_views
            }

            for future in as_completed(future_to_view):
                view = future_to_view[future]
                cube_result = future.result()
                memory_keys = (
                    "text_mem",
                    "act_mem",
                    "para_mem",
                    "pref_mem",
                    "tool_mem",
                    "skill_mem",
                )
                for key in memory_keys:
                    memories = cube_result.get(key, [])
                    for memory in memories:
                        if isinstance(memory, dict):
                            memory.setdefault("cube_id", view.cube_id)
                    merged_results[key].extend(memories)
                note = cube_result.get("pref_note")
                if note:
                    if merged_results["pref_note"]:
                        merged_results["pref_note"] += " | " + note
                    else:
                        merged_results["pref_note"] = note

        return merged_results

    def feedback_memories(self, feedback_req: APIFeedbackRequest) -> list[dict[str, Any]]:
        all_results: list[dict[str, Any]] = []
        target_views = self._route_views(feedback_req)

        for view in target_views:
            self.logger.info(f"[CompositeCubeView] route feedback to cube={view.cube_id}")
            results = view.feedback_memories(feedback_req)
            all_results.extend(results)

        return all_results
