"""Offline unit tests for GraphStructureReorganizer (issue #2480).

Covers three defects:
1. The periodic/_reorganize_needed optimization only ever touched the default
   configured tenant; it must enumerate all tenants present in the graph.
2. The schedule-based jobs were dead code: the loop never called
   ``schedule.run_pending()``.
3. A non-JSON LLM reply crashed the whole optimization round via
   ``AttributeError`` (and the ``JSONDecodeError`` path silently produced empty
   parent nodes).

Graph store / LLM / embedder are all stubbed; no Neo4j, LLM service, network,
or embedder is required.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import memos.memories.textual.tree_text_memory.organize.reorganizer as reorganizer_module

from memos.graph_dbs.base import BaseGraphDB
from memos.memories.textual.tree_text_memory.organize.reorganizer import (
    GraphStructureReorganizer,
    extract_first_to_last_brace,
)


def make_node(node_id: str, memory: str, key: str = "k", background: str = ""):
    return SimpleNamespace(
        id=node_id,
        memory=memory,
        metadata=SimpleNamespace(key=key, background=background),
    )


@pytest.fixture()
def reorganizer():
    graph_store = MagicMock()
    llm = MagicMock()
    embedder = MagicMock()
    # Avoid background threads: is_reorganize=False.
    return GraphStructureReorganizer(graph_store, llm, embedder, is_reorganize=False)


EMPTY_RELATION_RESULTS = {
    "relations": [],
    "inferred_nodes": [],
    "sequence_links": [],
    "aggregate_nodes": [],
}


# ---------------------------------------------------------------------------
# Defect C: LLM output parsing must never crash the optimization round
# ---------------------------------------------------------------------------


def test_extract_first_to_last_brace_without_braces_yields_none():
    """Upstream sentinel: no braces -> ("", None), must not raise."""
    json_str, parsed = extract_first_to_last_brace("sorry, I cannot answer that")
    assert json_str == ""
    assert parsed is None


def test_parse_json_result_plain_text_returns_none(reorganizer):
    assert reorganizer._parse_json_result("sorry, I cannot answer that") is None


def test_parse_json_result_malformed_json_returns_none(reorganizer):
    """Braces present but invalid JSON -> None (previously {})."""
    assert reorganizer._parse_json_result('{"key": "broken') is None


def test_parse_json_result_interior_brace_invalid_json_returns_none(reorganizer):
    """Braces exist but the enclosed text is invalid JSON -> None (previously {})."""
    assert reorganizer._parse_json_result('noise {"key": "broken} more noise') is None


def test_summarize_cluster_returns_none_on_malformed_json_no_empty_parent(reorganizer):
    """The JSONDecodeError path must not silently build an empty parent node."""
    reorganizer.llm.generate.return_value = 'noise {"key": "broken} more noise'

    result = reorganizer._summarize_cluster([make_node("n1", "m1")], "LongTermMemory")

    assert result is None
    reorganizer.embedder.embed.assert_not_called()


def test_parse_json_result_non_object_json_returns_none(reorganizer, monkeypatch):
    """A parsed JSON value that is not an object must not be passed through."""
    monkeypatch.setattr(
        reorganizer_module,
        "extract_first_to_last_brace",
        lambda text: (text, [{"key": "a"}]),
    )
    assert reorganizer._parse_json_result("whatever") is None


def test_parse_json_result_empty_text_returns_none(reorganizer):
    assert reorganizer._parse_json_result("") is None
    assert reorganizer._parse_json_result(None) is None


def test_parse_json_result_object_passthrough(reorganizer):
    text = 'Here you go:\n```json\n{"key": "travel", "value": "likes Kyoto"}\n```'
    assert reorganizer._parse_json_result(text) == {"key": "travel", "value": "likes Kyoto"}


def test_summarize_cluster_returns_none_on_non_json_llm_output(reorganizer):
    reorganizer.llm.generate.return_value = "sorry, I cannot answer that"

    result = reorganizer._summarize_cluster([make_node("n1", "m1")], "LongTermMemory")

    assert result is None
    reorganizer.embedder.embed.assert_not_called()


def test_summarize_cluster_builds_parent_node_from_llm_json(reorganizer):
    reorganizer.llm.generate.return_value = (
        '{"key": "travel", "value": "User likes Kyoto", '
        '"tags": ["travel"], "summary": "travel preference"}'
    )
    reorganizer.embedder.embed.return_value = [[0.1, 0.2, 0.3]]

    parent = reorganizer._summarize_cluster([make_node("n1", "m1")], "LongTermMemory")

    assert parent is not None
    assert parent.memory == "User likes Kyoto"
    assert parent.metadata.key == "travel"
    reorganizer.embedder.embed.assert_called_once_with(["User likes Kyoto"])


def test_local_subcluster_returns_empty_on_non_json_llm_output(reorganizer):
    reorganizer.llm.generate.return_value = "no json for you"

    assert reorganizer._local_subcluster([make_node("n1", "m1")]) == []


def test_local_subcluster_parses_valid_clusters(reorganizer):
    reorganizer.llm.generate.return_value = '{"clusters": [{"ids": ["a", "b"]}]}'
    nodes = [make_node("a", "ma"), make_node("b", "mb")]

    assert reorganizer._local_subcluster(nodes) == [nodes]


def test_process_cluster_skips_failed_summary_without_writing_empty_parents(reorganizer):
    reorganizer.llm.generate.return_value = "sorry, I cannot answer that"
    reorganizer.embedder.embed.return_value = [[0.1]]
    reorganizer.relation_detector.process_node = MagicMock(
        return_value=dict(EMPTY_RELATION_RESULTS)
    )
    cluster = [make_node(f"n{i}", f"m{i}") for i in range(4)]

    # Must not raise, and must not create any (empty) parent node.
    reorganizer._process_cluster_and_write(
        cluster, "LongTermMemory", local_tree_threshold=10, min_cluster_size=2
    )

    reorganizer.graph_store.add_node.assert_not_called()
    reorganizer.graph_store.add_edge.assert_not_called()


# ---------------------------------------------------------------------------
# Defect A: optimization must cover all graph tenants, not only the default one
# ---------------------------------------------------------------------------


def test_optimize_all_users_enumerates_graph_tenants(reorganizer):
    reorganizer.graph_store.get_all_user_names.return_value = ["alice", "bob", "memosdefault"]
    reorganizer.optimize_structure = MagicMock()

    reorganizer._optimize_all_users(scope="LongTermMemory")

    assert [
        (call.kwargs["scope"], call.kwargs["user_name"])
        for call in reorganizer.optimize_structure.call_args_list
    ] == [
        ("LongTermMemory", "alice"),
        ("LongTermMemory", "bob"),
        ("LongTermMemory", "memosdefault"),
    ]


def test_optimize_all_users_tolerates_single_tenant_failure(reorganizer):
    reorganizer.graph_store.get_all_user_names.return_value = ["alice", "bob"]
    reorganizer.optimize_structure = MagicMock(
        side_effect=[RuntimeError("neo4j unavailable"), None]
    )

    # The failing first tenant must not abort the second one.
    reorganizer._optimize_all_users(scope="UserMemory")

    assert reorganizer.optimize_structure.call_count == 2
    reorganizer.optimize_structure.assert_any_call(scope="UserMemory", user_name="bob")


def test_optimize_all_users_falls_back_without_tenant_enumeration(reorganizer):
    """Backends without get_all_user_names keep the previous single-tenant call."""
    del reorganizer.graph_store.get_all_user_names
    reorganizer.optimize_structure = MagicMock()

    reorganizer._optimize_all_users(scope="LongTermMemory")

    reorganizer.optimize_structure.assert_called_once_with(scope="LongTermMemory")


def test_optimize_all_users_falls_back_on_enumeration_error(reorganizer):
    reorganizer.graph_store.get_all_user_names.side_effect = RuntimeError("driver closed")
    reorganizer.optimize_structure = MagicMock()

    reorganizer._optimize_all_users(scope="UserMemory")

    reorganizer.optimize_structure.assert_called_once_with(scope="UserMemory")


def test_base_graph_db_default_returns_configured_user_name():
    """Backends that do not implement enumeration fall back to config.user_name."""
    dummy = SimpleNamespace(config=SimpleNamespace(user_name="tenant-a"))

    assert BaseGraphDB.get_all_user_names(dummy) == ["tenant-a"]


def test_base_graph_db_default_handles_missing_config():
    dummy = SimpleNamespace()  # no .config at all

    assert BaseGraphDB.get_all_user_names(dummy) == []


# ---------------------------------------------------------------------------
# Defect B: the loop must actually run the scheduled jobs
# ---------------------------------------------------------------------------


def _run_one_loop_iteration(monkeypatch, reorganizer):
    """Run _run_structure_organizer_loop until its first sleep, then stop."""
    import schedule

    # State normally initialized in __init__ only when is_reorganize=True
    # (the loop thread is never started otherwise).
    reorganizer._stop_scheduler = False
    reorganizer._is_optimizing = {"LongTermMemory": False, "UserMemory": False}

    monkeypatch.setattr(schedule, "every", MagicMock())
    run_pending = MagicMock()
    monkeypatch.setattr(schedule, "run_pending", run_pending)

    def fake_sleep(_seconds):
        reorganizer._stop_scheduler = True

    monkeypatch.setattr(reorganizer_module.time, "sleep", fake_sleep)
    reorganizer._run_structure_organizer_loop()
    return run_pending


def test_loop_calls_schedule_run_pending(monkeypatch, reorganizer):
    reorganizer.graph_store.get_all_user_names.return_value = ["alice"]
    reorganizer.optimize_structure = MagicMock()

    run_pending = _run_one_loop_iteration(monkeypatch, reorganizer)

    run_pending.assert_called()


def test_reorganize_trigger_covers_all_tenants(monkeypatch, reorganizer):
    reorganizer.graph_store.get_all_user_names.return_value = ["alice", "bob"]
    reorganizer.optimize_structure = MagicMock()
    reorganizer._reorganize_needed = True

    _run_one_loop_iteration(monkeypatch, reorganizer)

    assert not reorganizer._reorganize_needed
    assert {
        (call.kwargs["scope"], call.kwargs["user_name"])
        for call in reorganizer.optimize_structure.call_args_list
    } == {
        ("LongTermMemory", "alice"),
        ("LongTermMemory", "bob"),
        ("UserMemory", "alice"),
        ("UserMemory", "bob"),
    }
