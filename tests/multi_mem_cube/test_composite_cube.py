import logging

from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from memos.multi_mem_cube.composite_cube import CompositeCubeView


@dataclass
class FakeCubeView:
    cube_id: str
    responsibility: str | None = None
    result: list[dict[str, Any]] = field(default_factory=list)
    search_result: dict[str, Any] = field(default_factory=dict)
    add_calls: int = 0
    feedback_calls: int = 0

    def add_memories(self, _add_req):
        self.add_calls += 1
        return list(self.result)

    def feedback_memories(self, _feedback_req):
        self.feedback_calls += 1
        return list(self.result)

    def search_memories(self, _search_req):
        return dict(self.search_result)


def test_composite_routes_add_to_explicit_target_cube():
    general = FakeCubeView(cube_id="general", result=[{"memory": "g"}])
    product = FakeCubeView(cube_id="product", result=[{"memory": "p"}])
    composite = CompositeCubeView(
        cube_views=[general, product],
        logger=logging.getLogger("test.composite"),
    )

    result = composite.add_memories(SimpleNamespace(info={"target_cube_id": "product"}))

    assert result == [{"memory": "p"}]
    assert general.add_calls == 0
    assert product.add_calls == 1


def test_composite_routes_feedback_by_responsibility():
    general = FakeCubeView(cube_id="general", responsibility="general")
    product = FakeCubeView(cube_id="product", responsibility="shopping", result=[{"ok": True}])
    composite = CompositeCubeView(
        cube_views=[general, product],
        logger=logging.getLogger("test.composite"),
    )

    result = composite.feedback_memories(SimpleNamespace(info={"responsibility": "shopping"}))

    assert result == [{"ok": True}]
    assert general.feedback_calls == 0
    assert product.feedback_calls == 1


def test_composite_falls_back_to_fanout_without_route_match():
    general = FakeCubeView(cube_id="general", result=[{"memory": "g"}])
    product = FakeCubeView(cube_id="product", result=[{"memory": "p"}])
    composite = CompositeCubeView(
        cube_views=[general, product],
        logger=logging.getLogger("test.composite"),
    )

    result = composite.add_memories(SimpleNamespace(info={"responsibility": "unknown"}))

    assert result == [{"memory": "g"}, {"memory": "p"}]
    assert general.add_calls == 1
    assert product.add_calls == 1


def test_composite_search_adds_missing_cube_provenance():
    general = FakeCubeView(
        cube_id="general",
        search_result={"text_mem": [{"memory": "g"}], "pref_note": "general note"},
    )
    product = FakeCubeView(
        cube_id="product",
        search_result={"text_mem": [{"memory": "p", "cube_id": "existing"}]},
    )
    composite = CompositeCubeView(
        cube_views=[general, product],
        logger=logging.getLogger("test.composite"),
    )

    result = composite.search_memories(SimpleNamespace())

    by_memory = {item["memory"]: item for item in result["text_mem"]}
    assert by_memory["g"]["cube_id"] == "general"
    assert by_memory["p"]["cube_id"] == "existing"
