"""Final-hit selection, rank and isolation beyond the root restart smoke test."""

from copy import deepcopy

from memos_smartcomment.config import SmartCommentSettings
from memos_smartcomment.handlers.add_handler import AddHandler
from memos_smartcomment.handlers.search_handler import SearchHandler
from memos_smartcomment.lineage import connect_search_lineage
from memos_smartcomment.recorder import SmartCommentRecorder


# isort: split
from memos.plugins.hook_context import HookContext


def _memory(memory_id, score=None):
    return {"id": memory_id, "memory": f"Synthetic memory {memory_id}", "score": score}


def _history(ids, *, user="user", project="memos"):
    events = []
    AddHandler(events.append).on_text_memory_add_after(
        hook_context=HookContext(
            trace_id=f"add:{user}:{project}", user_id=user, cube_ids=("cube",)
        ),
        text_memory=None,
        memories=[_memory(memory_id) for memory_id in ids],
        kwargs={},
        result=ids,
    )
    (event,) = events
    recorder = SmartCommentRecorder(SmartCommentSettings(project_id=project, strict=True), event)
    recorder.record(event)
    return recorder.export_graph()


def test_final_hits_link_only_matching_ancestry_with_first_rank_and_score() -> None:
    sources = [
        _history(["a", "b", "unrelated"]),
        _history(["foreign-user"], user="other"),
        _history(["foreign-project"], project="other"),
    ]
    original = deepcopy(sources)
    events = []
    SearchHandler(events.append).on_search_results_after_rerank(
        hook_context=HookContext(trace_id="search", user_id="user", operation_id="rerank-op"),
        search_req={"query": "Synthetic query"},
        results={
            "text_mem": [
                {
                    "cube_id": "cube",
                    "memories": [
                        _memory("missing", 0.95),
                        _memory("a", 0),
                        _memory("a", 0.9),
                        _memory(None, 0.2),
                        _memory("b"),
                        _memory("foreign-user"),
                        _memory("foreign-project"),
                    ],
                },
                {"cube_id": "other", "memories": [_memory("a", 0.7)]},
            ],
            "tool_mem": [{"cube_id": "cube", "memories": [_memory("a", 0.8)]}],
        },
    )
    (event,) = events
    recorder = SmartCommentRecorder(SmartCommentSettings(strict=True), event)
    recorder.record(event)
    merged, linked = connect_search_lineage(recorder.export_graph(), event, sources)
    assert sources == original
    assert linked.metadata["linked_count"] == 3 and linked.metadata["unresolved_count"] == 4
    recorder.restore_graph(merged)
    recorder.record(linked)
    data = recorder.export_graph()["data"]
    nodes = {node["full_node_id"]: node for node in data["nodes"]}
    links = [edge for edge in data["edges"] if edge["category"] == "memory_search_lineage"]
    assert [(edge["metadata"]["rank"], edge["metadata"]["score"]) for edge in links] == [
        (2, 0),
        (5, None),
        (1, 0.8),
    ]
    for edge in links:
        assert nodes[edge["source_full_node_id"]]["category"] == "search_memory_list_rerank"
        assert nodes[edge["target_full_node_id"]]["category"] == "persisted_memory"
        assert edge["metadata"]["operation_id"] == "rerank-op"
    imported = [node for node in nodes.values() if node["metadata"].get("lineage_source_trace_id")]
    assert {node["category"] for node in imported} == {"extracted_memory", "persisted_memory"}
    assert {
        node["metadata"]["memory_id"] for node in imported if node["category"] == "persisted_memory"
    } == {"a", "b"}
