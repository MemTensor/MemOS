"""Optional model parsing cannot discard successfully retrieved memories."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import memos.api.handlers  # noqa: F401 - initialize the existing handler import cycle

from memos.api.product_models import APISearchRequest
from memos.exceptions import GraphDBError
from memos.mem_scheduler.memory_manage_modules.enhancement_pipeline import EnhancementPipeline
from memos.memories.textual.item import TextualMemoryItem
from memos.multi_mem_cube.single_cube import SingleCubeView
from memos.types.general_types import FineStrategy, SearchMode, UserContext


@pytest.mark.parametrize(
    "response",
    [
        "",
        "not JSON",
        '{"hint": null}',
        '{"hint": 42}',
        '{"hint":"x","trigger_recall":"false"}',
        ValueError("model"),
        OSError("offline"),
    ],
)
def test_optional_recall_failure_preserves_raw_search_result(monkeypatch, response):
    monkeypatch.setattr("memos.multi_mem_cube.single_cube.FINE_STRATEGY", FineStrategy.RECREATE)
    llm = Mock()
    if isinstance(response, Exception):
        llm.generate.side_effect = response
    else:
        llm.generate.return_value = response
    pipeline = EnhancementPipeline(llm, SimpleNamespace(), lambda **_: "fixture")
    raw = TextualMemoryItem(memory="already retrieved")
    searcher = Mock(post_retrieve=Mock(return_value=[raw]))
    retriever = SimpleNamespace(
        enhance_memories_with_query=lambda **_: ([], True),
        recall_for_missing_memories=pipeline.recall_for_missing_memories,
    )
    view = SingleCubeView(
        "A", Mock(), Mock(), SimpleNamespace(retriever=retriever), Mock(), searcher
    )
    view._postformat_memories = Mock(side_effect=lambda memories, *args, **kwargs: memories)
    assert view._search_text(
        APISearchRequest(query="q", user_id="u"),
        UserContext(user_id="u", mem_cube_id="A"),
        SearchMode.FINE,
    ) == [raw]
    searcher.search.assert_not_called()


@pytest.mark.parametrize(
    "response,expected",
    [
        ("{}", ("", False)),
        ('{"hint":""}', ("", False)),
        ('{"hint":"topic"}', ("topic", False)),
        ('{"hint":"topic","trigger_recall":true}', ("topic", True)),
    ],
)
def test_valid_recall_contract(response, expected):
    pipeline = EnhancementPipeline(
        Mock(generate=Mock(return_value=response)), SimpleNamespace(), lambda **_: "fixture"
    )
    assert pipeline.recall_for_missing_memories("q", ["memory"]) == expected


def test_recall_does_not_reclassify_storage_error():
    failure = GraphDBError("storage")
    pipeline = EnhancementPipeline(
        Mock(generate=Mock(side_effect=failure)), SimpleNamespace(), lambda **_: "fixture"
    )
    with pytest.raises(GraphDBError) as caught:
        pipeline.recall_for_missing_memories("q", [])
    assert caught.value is failure
