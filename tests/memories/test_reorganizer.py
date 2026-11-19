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
    graph_store.config = SimpleNamespace(user_name="memosdefault", use_multi_db=False)
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

    reorganizer.optimize_structure.assert_called_once_with(
        scope="LongTermMemory", user_name="memosdefault"
    )


def test_optimize_all_users_falls_back_on_enumeration_error(reorganizer):
    reorganizer.graph_store.get_all_user_names.side_effect = RuntimeError("driver closed")
    reorganizer.optimize_structure = MagicMock()

    reorganizer._optimize_all_users(scope="UserMemory")

    reorganizer.optimize_structure.assert_called_once_with(
        scope="UserMemory", user_name="memosdefault"
    )


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

    scheduler = schedule.Scheduler()
    run_pending = MagicMock()
    scheduler.run_pending = run_pending
    monkeypatch.setattr(schedule, "Scheduler", lambda: scheduler)

    def fake_sleep(_seconds):
        reorganizer._stop_scheduler = True

    reorganizer._scheduler_stop_event = SimpleNamespace(wait=fake_sleep)
    reorganizer._run_structure_organizer_loop()
    return run_pending


def test_loop_calls_schedule_run_pending(monkeypatch, reorganizer):
    reorganizer._reorganize_needed = False
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


def test_parse_preserves_json_word_in_memory_text(reorganizer):
    value = {"key": "json tools", "value": "Uses json.loads for work"}
    import json

    assert reorganizer._parse_json_result(json.dumps(value)) == value


@pytest.mark.parametrize("response", ['[{"key": "x", "value": "y"}]', "null", "42", "true"])
def test_parse_rejects_top_level_non_objects(reorganizer, response):
    assert reorganizer._parse_json_result(response) is None


@pytest.mark.parametrize(
    "response",
    [
        "{}",
        '{"key": "", "value": "x"}',
        '{"key": "x", "value": ""}',
        '{"key": null, "value": "x"}',
        '{"key": "x", "value": []}',
        '{"key": "x", "value": "y", "tags": "bad"}',
    ],
)
def test_summary_rejects_empty_or_invalid_fields_before_embedding(reorganizer, response):
    reorganizer.llm.generate.return_value = response
    assert reorganizer._summarize_cluster([make_node("n1", "m1")], "LongTermMemory") is None
    reorganizer.embedder.embed.assert_not_called()


@pytest.mark.parametrize(
    "response",
    [
        '{"clusters": null}',
        '{"clusters": "bad"}',
        '{"clusters": [null, {"ids": null}, {"ids": ["a", "b"]}]}',
    ],
)
def test_local_subcluster_tolerates_wrong_shapes(reorganizer, response):
    reorganizer.llm.generate.return_value = response
    nodes = [make_node("a", "ma"), make_node("b", "mb")]
    result = reorganizer._local_subcluster(nodes)
    assert result == ([nodes] if '"a"' in response else [])


def test_fallback_failure_is_isolated(reorganizer):
    reorganizer.graph_store.get_all_user_names.return_value = []
    reorganizer.graph_store.config = SimpleNamespace(user_name="default")
    reorganizer.optimize_structure = MagicMock(side_effect=OSError("Synthetic failure"))
    reorganizer._optimize_all_users("LongTermMemory")
    reorganizer.optimize_structure.assert_called_once_with(
        scope="LongTermMemory", user_name="default"
    )


def test_missing_tenant_scope_cannot_run_unscoped(reorganizer):
    reorganizer.graph_store.get_all_user_names.return_value = [None, "", " "]
    reorganizer.graph_store.config = SimpleNamespace(user_name=None, use_multi_db=False)
    reorganizer.optimize_structure = MagicMock()
    reorganizer._optimize_all_users("LongTermMemory")
    reorganizer.optimize_structure.assert_not_called()


def test_tenant_names_are_validated_and_deduplicated(reorganizer):
    reorganizer.graph_store.get_all_user_names.return_value = ["alice", "alice", None, "bob", ""]
    reorganizer.optimize_structure = MagicMock()
    reorganizer._optimize_all_users("LongTermMemory")
    assert [call.kwargs["user_name"] for call in reorganizer.optimize_structure.call_args_list] == [
        "alice",
        "bob",
    ]


def test_disabled_reorganizer_supports_explicit_optimization(reorganizer):
    reorganizer.graph_store.node_not_exist.return_value = True
    reorganizer.optimize_structure(scope="LongTermMemory", user_name="alice")


def test_scheduler_is_private_and_preserves_new_triggers(monkeypatch, reorganizer):
    import schedule

    sentinel = schedule.every(1000).seconds.do(lambda: None)
    before = list(schedule.jobs)
    reorganizer.graph_store.get_all_user_names.return_value = ["alice"]
    calls = []

    def optimize(**kwargs):
        calls.append(kwargs)
        reorganizer._reorganize_needed = True

    reorganizer.optimize_structure = optimize

    def stop_after_cycle(_seconds):
        reorganizer._stop_scheduler = True

    monkeypatch.setattr(reorganizer_module.time, "sleep", stop_after_cycle)
    # The corrected implementation uses an interruptible event wait.
    reorganizer._scheduler_stop_event = SimpleNamespace(wait=stop_after_cycle)
    try:
        reorganizer._run_structure_organizer_loop()
        assert schedule.jobs == before
        assert reorganizer._reorganize_needed
        assert len(calls) == 2
    finally:
        schedule.cancel_job(sentinel)
        for job in list(schedule.jobs):
            if job not in before:
                schedule.cancel_job(job)


def test_real_scheduler_runs_due_jobs_for_every_tenant(monkeypatch, reorganizer):
    from datetime import datetime, timedelta

    import schedule

    scheduler = schedule.Scheduler()
    monkeypatch.setattr(schedule, "Scheduler", lambda: scheduler)
    reorganizer._reorganize_needed = False
    reorganizer.graph_store.get_all_user_names.return_value = ["alice", "bob"]
    reorganizer.optimize_structure = MagicMock()
    waits = []

    def advance_then_stop(_seconds):
        waits.append(None)
        if len(waits) == 1:
            for job in scheduler.jobs:
                job.next_run = datetime.now() - timedelta(seconds=1)
        else:
            reorganizer._stop_scheduler = True

    reorganizer._scheduler_stop_event = SimpleNamespace(wait=advance_then_stop)
    reorganizer._run_structure_organizer_loop()

    assert {
        (call.kwargs["scope"], call.kwargs["user_name"])
        for call in reorganizer.optimize_structure.call_args_list
    } == {
        ("LongTermMemory", "alice"),
        ("LongTermMemory", "bob"),
        ("UserMemory", "alice"),
        ("UserMemory", "bob"),
    }
    assert scheduler.jobs == []


def test_multi_tenant_optimization_scopes_candidate_reads_and_graph_writes(reorganizer):
    from uuid import uuid4

    graph = reorganizer.graph_store
    graph.get_all_user_names.return_value = ["alice", "bob"]
    graph.node_not_exist.return_value = False
    graph.get_memory_count.return_value = 3
    graph.edge_exists.return_value = False
    tenants = {
        name: [
            {
                "id": str(uuid4()),
                "memory": f"{name} memory {index}",
                "metadata": {"memory_type": "LongTermMemory", "key": "topic", "embedding": [0.1]},
            }
            for index in range(3)
        ]
        for name in ("alice", "bob")
    }
    graph.get_structure_optimization_candidates.side_effect = lambda scope, user_name: tenants[
        user_name
    ]
    reorganizer._partition = lambda nodes: [nodes]
    reorganizer._local_subcluster = lambda nodes: [nodes]
    reorganizer.llm.generate.return_value = '{"key": "topic", "value": "Summary", "tags": []}'
    reorganizer.embedder.embed.return_value = [[0.1]]
    reorganizer.relation_detector.process_node = MagicMock(return_value=EMPTY_RELATION_RESULTS)

    reorganizer._optimize_all_users("LongTermMemory", min_group_size=3, min_cluster_size=2)

    assert [
        call.kwargs["user_name"]
        for call in graph.get_structure_optimization_candidates.call_args_list
    ] == ["alice", "bob"]
    assert [call.kwargs["user_name"] for call in graph.add_node.call_args_list] == ["alice", "bob"]
    assert len(graph.add_edge.call_args_list) == 6
    for call in graph.add_edge.call_args_list:
        tenant = call.kwargs["user_name"]
        assert call.args[1] in {node["id"] for node in tenants[tenant]}


def test_stop_interrupts_scheduler_wait(reorganizer):
    reorganizer.is_reorganize = True
    reorganizer.thread = MagicMock()
    reorganizer.structure_optimizer_thread = MagicMock()

    reorganizer.stop()

    assert reorganizer._stop_scheduler
    assert reorganizer._scheduler_stop_event.is_set()
    reorganizer.thread.join.assert_called_once()
    reorganizer.structure_optimizer_thread.join.assert_called_once()


def test_database_isolated_backend_can_optimize_its_configured_database(reorganizer):
    reorganizer.graph_store.get_all_user_names.return_value = []
    reorganizer.graph_store.config = SimpleNamespace(user_name=None, use_multi_db=True)
    reorganizer.optimize_structure = MagicMock()

    reorganizer._optimize_all_users("LongTermMemory")

    reorganizer.optimize_structure.assert_called_once_with(scope="LongTermMemory", user_name=None)


def test_malformed_array_is_not_reinterpreted_as_a_summary_object(reorganizer):
    assert reorganizer._parse_json_result('[{"key": "x", "value": "y"},]') is None
