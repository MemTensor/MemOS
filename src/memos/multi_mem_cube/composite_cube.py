from __future__ import annotations

from concurrent.futures import as_completed
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from memos.context.context import ContextThreadPoolExecutor
from memos.exceptions import MemCubeError
from memos.multi_mem_cube.views import MemCubeView
from memos.utils import timed_stage


if TYPE_CHECKING:
    from memos.api.product_models import APIADDRequest, APIFeedbackRequest, APISearchRequest
    from memos.multi_mem_cube.single_cube import SingleCubeView


@dataclass
class CompositeCubeView(MemCubeView):
    """
    A composite view over multiple logical cubes.

    By default, operations keep the legacy fan-out behavior. If request metadata
    explicitly names ``info.target_cube_id``, operations are routed only to that
    cube and fall back to fan-out when it does not match.

    Cube operations are isolated from each other. A partial failure is logged
    and successful results are returned; if every selected cube fails, the
    operation raises ``MemCubeError``.
    """

    cube_views: list[SingleCubeView]
    logger: Any

    def _request_info(self, request: Any) -> dict[str, Any]:
        info = getattr(request, "info", None)
        return info if isinstance(info, dict) else {}

    def _route_views(self, request: Any) -> list[SingleCubeView]:
        target_cube_id = self._request_info(request).get("target_cube_id")
        if target_cube_id:
            routed = [view for view in self.cube_views if view.cube_id == target_cube_id]
            if routed:
                return routed
            self.logger.warning(
                "[CompositeCubeView] target cube %s not found; fallback to fan-out",
                target_cube_id,
            )

        return self.cube_views

    def _handle_failures(
        self,
        operation: str,
        attempted_count: int,
        succeeded_count: int,
        failures: list[tuple[str, Exception]],
    ) -> None:
        if not failures:
            return

        failed_cube_ids = [cube_id for cube_id, _ in failures]
        if succeeded_count:
            self.logger.warning(
                "[CompositeCubeView] partial failure operation=%s succeeded=%d failed=%d "
                "failed_cubes=%s",
                operation,
                succeeded_count,
                len(failures),
                failed_cube_ids,
            )
            return

        message = (
            f"Composite cube {operation} failed for all {attempted_count} selected cubes: "
            f"{failed_cube_ids}"
        )
        error = MemCubeError(message)
        error.causes = [exc for _, exc in failures]
        raise error from failures[0][1]

    def add_memories(self, add_req: APIADDRequest) -> list[dict[str, Any]]:
        all_results: list[dict[str, Any]] = []
        target_views = self._route_views(add_req)
        cube_count = len(target_views)
        succeeded_count = 0
        failures: list[tuple[str, Exception]] = []

        with timed_stage("add", "multi_cube", cube_count=cube_count):
            for idx, view in enumerate(target_views):
                self.logger.info(
                    "[CompositeCubeView] route add to cube=%s (%d/%d)",
                    view.cube_id,
                    idx + 1,
                    cube_count,
                )
                try:
                    results = view.add_memories(add_req)
                except Exception as exc:
                    failures.append((view.cube_id, exc))
                    self.logger.error(
                        "[CompositeCubeView] add failed for cube=%s",
                        view.cube_id,
                        exc_info=True,
                    )
                else:
                    succeeded_count += 1
                    all_results.extend(results)

        self._handle_failures("add", cube_count, succeeded_count, failures)
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
        target_views = self._route_views(search_req)
        succeeded_count = 0
        failures: list[tuple[str, Exception]] = []

        def _search_single_cube(view: SingleCubeView) -> dict[str, Any]:
            self.logger.info(
                "[CompositeCubeView] route search to cube=%s",
                view.cube_id,
            )
            return view.search_memories(search_req)

        # parallel search for each cube
        with ContextThreadPoolExecutor(max_workers=2) as executor:
            future_to_view = {
                executor.submit(_search_single_cube, view): view for view in target_views
            }

            for future in as_completed(future_to_view):
                view = future_to_view[future]
                try:
                    cube_result = future.result()
                except Exception as exc:
                    failures.append((view.cube_id, exc))
                    self.logger.error(
                        "[CompositeCubeView] search failed for cube=%s",
                        view.cube_id,
                        exc_info=True,
                    )
                    continue

                succeeded_count += 1
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

        self._handle_failures("search", len(target_views), succeeded_count, failures)
        return merged_results

    def feedback_memories(self, feedback_req: APIFeedbackRequest) -> list[dict[str, Any]]:
        all_results: list[dict[str, Any]] = []
        target_views = self._route_views(feedback_req)
        succeeded_count = 0
        failures: list[tuple[str, Exception]] = []

        for view in target_views:
            self.logger.info(
                "[CompositeCubeView] route feedback to cube=%s",
                view.cube_id,
            )
            try:
                results = view.feedback_memories(feedback_req)
            except Exception as exc:
                failures.append((view.cube_id, exc))
                self.logger.error(
                    "[CompositeCubeView] feedback failed for cube=%s",
                    view.cube_id,
                    exc_info=True,
                )
            else:
                succeeded_count += 1
                all_results.extend(results)

        self._handle_failures("feedback", len(target_views), succeeded_count, failures)
        return all_results
