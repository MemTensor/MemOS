import copy
import logging

from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest

from memos.exceptions import MemCubeError
from memos.multi_mem_cube.composite_cube import CompositeCubeView


@dataclass
class FakeCubeView:
    cube_id: str
    result: list[dict[str, Any]] = field(default_factory=list)
    search_result: dict[str, Any] = field(default_factory=dict)
    error: Exception | None = None
    add_calls: int = 0
    search_calls: int = 0
    feedback_calls: int = 0

    def add_memories(self, _add_req):
        self.add_calls += 1
        if self.error:
            raise self.error
        return list(self.result)

    def feedback_memories(self, _feedback_req):
        self.feedback_calls += 1
        if self.error:
            raise self.error
        return list(self.result)

    def search_memories(self, _search_req):
        self.search_calls += 1
        if self.error:
            raise self.error
        return copy.deepcopy(self.search_result)


def test_add_handler_routes_to_explicit_target_cube(monkeypatch):
    from memos.api.handlers.add_handler import AddHandler
    from memos.api.handlers.base_handler import HandlerDependencies
    from memos.api.product_models import APIADDRequest

    handler = AddHandler(
        HandlerDependencies(
            naive_mem_cube=object(),
            mem_reader=object(),
            mem_scheduler=object(),
            feedback_server=object(),
        )
    )
    request = APIADDRequest(
        user_id="user",
        writable_cube_ids=["general", "product"],
        info={"target_cube_id": "product"},
    )
    composite = handler._build_cube_view(request)
    calls: list[str] = []

    def add_memories(view, _request):
        calls.append(view.cube_id)
        return [{"memory": view.cube_id}]

    monkeypatch.setattr(type(composite.cube_views[0]), "add_memories", add_memories)

    result = composite.add_memories(request)

    assert result == [{"memory": "product"}]
    assert calls == ["product"]


def test_composite_falls_back_to_fanout_without_route_match():
    general = FakeCubeView(cube_id="general", result=[{"memory": "g"}])
    product = FakeCubeView(cube_id="product", result=[{"memory": "p"}])
    composite = CompositeCubeView(
        cube_views=[general, product],
        logger=logging.getLogger("test.composite"),
    )

    result = composite.add_memories(SimpleNamespace(info={"target_cube_id": "unknown"}))

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
    assert general.search_result == {
        "text_mem": [{"memory": "g"}],
        "pref_note": "general note",
    }


def test_composite_search_routes_to_explicit_target_cube():
    general = FakeCubeView(
        cube_id="general",
        search_result={"text_mem": [{"memory": "g"}]},
    )
    product = FakeCubeView(
        cube_id="product",
        search_result={"text_mem": [{"memory": "p"}]},
    )
    composite = CompositeCubeView(
        cube_views=[general, product],
        logger=logging.getLogger("test.composite"),
    )

    result = composite.search_memories(SimpleNamespace(info={"target_cube_id": "product"}))

    assert result["text_mem"] == [{"memory": "p", "cube_id": "product"}]
    assert general.search_calls == 0
    assert product.search_calls == 1


def test_composite_add_continues_after_partial_failure(caplog):
    failing = FakeCubeView(cube_id="failing", error=ValueError("unavailable"))
    healthy = FakeCubeView(cube_id="healthy", result=[{"memory": "saved"}])
    composite = CompositeCubeView(
        cube_views=[failing, healthy],
        logger=logging.getLogger("test.composite"),
    )

    with caplog.at_level(logging.WARNING):
        result = composite.add_memories(SimpleNamespace(info={}))

    assert result == [{"memory": "saved"}]
    assert "partial failure operation=add" in caplog.text
    assert "failing" in caplog.text


def test_composite_search_continues_after_partial_failure(caplog):
    failing = FakeCubeView(cube_id="failing", error=ValueError("unavailable"))
    healthy = FakeCubeView(
        cube_id="healthy",
        search_result={"text_mem": [{"memory": "found"}]},
    )
    composite = CompositeCubeView(
        cube_views=[failing, healthy],
        logger=logging.getLogger("test.composite"),
    )

    with caplog.at_level(logging.WARNING):
        result = composite.search_memories(SimpleNamespace())

    assert result["text_mem"] == [{"memory": "found", "cube_id": "healthy"}]
    assert "partial failure operation=search" in caplog.text


def test_composite_feedback_continues_after_partial_failure(caplog):
    failing = FakeCubeView(cube_id="failing", error=ValueError("unavailable"))
    healthy = FakeCubeView(cube_id="healthy", result=[{"ok": True}])
    composite = CompositeCubeView(
        cube_views=[failing, healthy],
        logger=logging.getLogger("test.composite"),
    )

    with caplog.at_level(logging.WARNING):
        result = composite.feedback_memories(SimpleNamespace(info={}))

    assert result == [{"ok": True}]
    assert "partial failure operation=feedback" in caplog.text


@pytest.mark.parametrize("operation", ["add", "search", "feedback"])
def test_composite_raises_memcube_error_when_all_cubes_fail(operation):
    causes = [ValueError("first failure"), ValueError("second failure")]
    composite = CompositeCubeView(
        cube_views=[
            FakeCubeView(cube_id="first", error=causes[0]),
            FakeCubeView(cube_id="second", error=causes[1]),
        ],
        logger=logging.getLogger("test.composite"),
    )
    request = SimpleNamespace(info={})

    with pytest.raises(
        MemCubeError, match=f"{operation} failed for all 2 selected cubes"
    ) as exc_info:
        if operation == "add":
            composite.add_memories(request)
        elif operation == "search":
            composite.search_memories(request)
        else:
            composite.feedback_memories(request)

    assert exc_info.value.causes == causes
