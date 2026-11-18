"""Retained lists, stage transitions and disabled post-processing."""

from itertools import pairwise

import pytest

from memos_smartcomment.config import SmartCommentSettings
from memos_smartcomment.handlers.search_handler import SearchHandler
from memos_smartcomment.recorder import SmartCommentRecorder


# isort: split
from memos.plugins.hook_context import HookContext


def _bucket(cube, memories):
    return {"cube_id": cube, "memories": memories}


def _lists(event):
    return {
        node.metadata["cube_id"]: node
        for node in event.outputs
        if node.class_name == "search_memory_list"
    }


def test_search_pipeline_keeps_bucket_lists_and_observed_order() -> None:
    events = []
    handler = SearchHandler(events.append)
    request = {"query": "Synthetic query", "relativity": 0.5, "dedup": "sim"}
    memories = [{"id": str(i), "memory": f"Memory {i}", "score": 0} for i in range(200)]
    first, second = memories[:2]
    stages = (
        (
            handler.on_search_memory_results,
            [_bucket("a", [*memories, first]), _bucket("b", [first])],
        ),
        (
            handler.on_search_results_after_threshold,
            [_bucket("b", [first]), _bucket("a", [first, first, second])],
        ),
        (handler.on_search_results_after_dedup, [_bucket("a", [first, second])]),
        (handler.on_search_results_after_rerank, [_bucket("a", [second, first])]),
    )
    for index, (callback, buckets) in enumerate(stages):
        callback(
            search_req=request,
            results={"text_mem": buckets},
            hook_context=HookContext(trace_id="search", operation_id=f"stage-{index}"),
        )

    assert len(events[0].outputs) == 5  # One type, two cubes, two lists; not one node per hit.
    assert len(_lists(events[0])["a"].value) == 201
    assert [event.metadata["filtered_count"] for event in events] == [0, 198, 2, 0]
    assert [event.metadata["operation_id"] for event in events] == [f"stage-{i}" for i in range(4)]
    for previous, current in pairwise(events):
        assert len(current.outputs) == len(current.links) == 2
        for link in current.links:
            cube = link.target.metadata["cube_id"]
            assert link.source.identity == _lists(previous)[cube].identity
            assert link.target == _lists(current)[cube]
    assert [item["memory_id"] for item in _lists(events[-1])["a"].value] == ["1", "0"]
    assert _lists(events[-1])["b"].value == []

    recorder = SmartCommentRecorder(SmartCommentSettings(strict=True), events[0])
    for event in events:
        recorder.record(event)
    data = recorder.export_graph()["data"]
    assert len(data["nodes"]) == 12 and len(data["edges"]) == 11
    assert not any(node["category"] == "search_filter_result" for node in data["nodes"])


@pytest.mark.parametrize("empty", [False, True])
def test_disabled_stages_preserve_raw_predecessor_or_empty_result(empty) -> None:
    events = []
    handler = SearchHandler(events.append)
    request = {"trace_id": "search", "query": "Synthetic query", "relativity": 0, "dedup": "no"}
    results = {} if empty else {"text_mem": [_bucket("cube", [{"id": "a", "memory": "Memory A"}])]}
    handler.on_search_memory_results(search_req=request, results=results)
    handler.on_search_results_after_threshold(search_req=request, results=results)
    handler.on_search_results_after_dedup(search_req=request, results=results)
    handler.on_search_results_after_rerank(search_req=request, results={})
    raw, final = events
    if empty:
        assert raw.outputs == final.outputs == final.links == ()
    else:
        (link,) = final.links
        assert link.source.identity == _lists(raw)["cube"].identity
        assert link.target.value == []
        assert final.metadata["filtered_count"] == 1
