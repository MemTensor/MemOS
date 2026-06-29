"""Regression tests for issue #1273 — bound search thread-pool growth.

The Searcher used to instantiate a fresh ContextThreadPoolExecutor on every
search request inside four methods. If any worker hung on a slow Neo4j /
embedding / HTTP call, the per-request `shutdown(wait=True)` blocked
forever, the worker threads could not be reclaimed, and subsequent requests
allocated new pools — unbounded thread accumulation up to the container's
pthread limit. These tests pin the new behaviour: shared class-level
executors, bounded thread count, and a per-future timeout that does not
leak the wait to the caller.
"""

from __future__ import annotations

import threading
import time

from unittest.mock import MagicMock, patch

from memos.context.context import ContextThreadPoolExecutor
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.retrieve import searcher as searcher_module
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.reranker.base import BaseReranker


def _build_searcher() -> Searcher:
    dispatcher_llm = MagicMock()
    graph_store = MagicMock()
    embedder = MagicMock()
    reranker = MagicMock(spec=BaseReranker)
    s = Searcher(dispatcher_llm, graph_store, embedder, reranker)
    s.task_goal_parser = MagicMock()
    s.graph_retriever = MagicMock()
    s.reasoner = MagicMock()
    return s


def _make_item(content: str) -> TextualMemoryItem:
    return TextualMemoryItem(
        memory=content,
        metadata=TreeNodeTextualMemoryMetadata(embedding=[0.1] * 5, usage=[]),
    )


def _prime_simple_pipeline(s: Searcher) -> None:
    parsed_goal = MagicMock()
    parsed_goal.memories = ["seed"]
    parsed_goal.rephrased_query = None
    parsed_goal.internet_search = False
    s.task_goal_parser.parse.return_value = parsed_goal
    s.embedder.embed.return_value = [[0.1] * 5, [0.2] * 5]
    s.graph_retriever.retrieve.return_value = [_make_item("hit")]
    s.reranker.rerank.return_value = [(_make_item("hit"), 0.5)]


def test_search_executors_are_class_level_singletons():
    """Both shared executors must be created once per Searcher and reused."""
    s = _build_searcher()

    assert hasattr(s, "_search_executor"), "Searcher must expose a class-level _search_executor"
    assert hasattr(s, "_search_subtask_executor"), (
        "Searcher must expose a class-level _search_subtask_executor"
    )

    assert isinstance(s._search_executor, ContextThreadPoolExecutor)
    assert isinstance(s._search_subtask_executor, ContextThreadPoolExecutor)

    # And they must NOT be the same object — the whole point of two pools is
    # to avoid nested-submission deadlock.
    assert s._search_executor is not s._search_subtask_executor


def test_search_executor_configuration():
    """Pool sizes and thread-name prefixes are pinned to the spec."""
    s = _build_searcher()

    assert s._search_executor._max_workers == 10
    assert s._search_executor._thread_name_prefix == "search"

    assert s._search_subtask_executor._max_workers == 10
    assert s._search_subtask_executor._thread_name_prefix == "search-sub"


def test_no_per_request_executor_creation():
    """No new ContextThreadPoolExecutor must be built during a search call.

    This is the load-bearing regression: the bug was that every request
    constructed fresh pools. We patch the symbol the searcher module
    binds and assert it stays at zero invocations during _retrieve_paths.
    """
    s = _build_searcher()
    _prime_simple_pipeline(s)

    with patch.object(
        searcher_module, "ContextThreadPoolExecutor", wraps=ContextThreadPoolExecutor
    ) as ctor:
        s.search(
            query="anything",
            top_k=1,
            info={"test": True},
            mode="fast",
            memory_type="WorkingMemory",
        )
        # No per-request executor allowed in the four refactored methods.
        assert ctor.call_count == 0, (
            f"Expected no per-request ContextThreadPoolExecutor construction; "
            f"got {ctor.call_count} call(s): {ctor.call_args_list}"
        )


def test_thread_count_bounded_under_repeated_search():
    """16 sequential searches must not multiply 'search'-prefixed threads."""
    s = _build_searcher()
    _prime_simple_pipeline(s)

    iterations = 16
    for _ in range(iterations):
        s.search(
            query="anything",
            top_k=1,
            info={"test": True},
            mode="fast",
            memory_type="WorkingMemory",
        )

    # Even if the worker pool warmed all 10 slots, no more than the bound.
    live_search_threads = [t for t in threading.enumerate() if t.name.startswith("search")]
    search_only = [t for t in live_search_threads if t.name.startswith("search_")]
    subtask_only = [t for t in live_search_threads if t.name.startswith("search-sub")]

    assert len(search_only) <= 10, (
        f"search executor leaked threads: {len(search_only)} > 10 after {iterations} requests"
    )
    assert len(subtask_only) <= 10, (
        f"search-sub executor leaked threads: {len(subtask_only)} > 10 after {iterations} requests"
    )


def test_search_timeout_constant_present():
    """The default per-future timeout must be exposed as a module constant."""
    assert hasattr(searcher_module, "SEARCH_TASK_TIMEOUT_SECONDS")
    assert isinstance(searcher_module.SEARCH_TASK_TIMEOUT_SECONDS, (int, float))
    # Reporter suggested 30 s; we accept any positive default <= 60 s.
    assert 0 < searcher_module.SEARCH_TASK_TIMEOUT_SECONDS <= 60


def test_retrieve_paths_passes_timeout_to_future_result():
    """`_retrieve_paths` MUST call task.result with a timeout argument."""
    s = _build_searcher()
    _prime_simple_pipeline(s)
    parsed_goal = s.task_goal_parser.parse.return_value

    captured: list[float | None] = []

    real_submit = s._search_executor.submit

    def tracking_submit(fn, *args, **kwargs):
        future = real_submit(fn, *args, **kwargs)
        original_result = future.result

        def wrapped_result(timeout=None):
            captured.append(timeout)
            return original_result(timeout=timeout)

        future.result = wrapped_result  # type: ignore[method-assign]
        return future

    with patch.object(s._search_executor, "submit", side_effect=tracking_submit):
        s._retrieve_paths(
            query="q",
            parsed_goal=parsed_goal,
            query_embedding=[[0.1] * 5],
            info={"user_id": "u", "session_id": "sess"},
            top_k=1,
            mode="fast",
            memory_type="WorkingMemory",
        )

    assert captured, "Expected at least one future.result() call to be tracked."
    assert all(t is not None and t > 0 for t in captured), (
        f"task.result() must be called with a positive timeout; got {captured}"
    )


def test_hanging_subtask_does_not_block_request_forever(monkeypatch):
    """A hung path must not freeze the request; warning must be logged."""
    s = _build_searcher()
    _prime_simple_pipeline(s)
    parsed_goal = s.task_goal_parser.parse.return_value

    # Force a tiny timeout so the test runs fast.
    monkeypatch.setattr(searcher_module, "SEARCH_TASK_TIMEOUT_SECONDS", 0.5)

    block_event = threading.Event()

    def hanging_retrieve(*args, **kwargs):
        # Mimic a stuck downstream call. The Event is set in the finally
        # block of the test to release the thread for clean teardown.
        block_event.wait(timeout=10)
        return []

    s.graph_retriever.retrieve.side_effect = hanging_retrieve

    warnings_seen: list[str] = []

    def capture_warning(msg, *args, **kwargs):
        try:
            warnings_seen.append(msg % args if args else msg)
        except Exception:
            warnings_seen.append(str(msg))

    monkeypatch.setattr(searcher_module.logger, "warning", capture_warning)

    started = time.monotonic()
    try:
        result = s._retrieve_paths(
            query="q",
            parsed_goal=parsed_goal,
            query_embedding=[[0.1] * 5],
            info={"user_id": "u", "session_id": "sess"},
            top_k=1,
            mode="fast",
            memory_type="WorkingMemory",
        )
    finally:
        block_event.set()
    elapsed = time.monotonic() - started

    # Must not have waited the full 10 s; budget = timeout + slack.
    assert elapsed < 5.0, f"_retrieve_paths blocked for {elapsed:.2f}s — timeout did not fire"
    # Result is whatever non-timed-out paths produced (could be empty list).
    assert isinstance(result, list)
    assert any("timeout" in w.lower() or "timed out" in w.lower() for w in warnings_seen), (
        f"Expected a timeout warning to be logged; saw: {warnings_seen}"
    )


def test_searcher_executors_survive_multiple_retrieve_paths_calls():
    """Identity check: same executor instance across calls (no rebuild)."""
    s = _build_searcher()
    _prime_simple_pipeline(s)

    outer_ref = s._search_executor
    inner_ref = s._search_subtask_executor

    for _ in range(3):
        s.search(
            query="anything",
            top_k=1,
            info={"test": True},
            mode="fast",
            memory_type="WorkingMemory",
        )

    assert s._search_executor is outer_ref
    assert s._search_subtask_executor is inner_ref


def test_long_term_path_uses_subtask_executor(monkeypatch):
    """`_retrieve_from_long_term_and_user` MUST submit to the subtask pool."""
    s = _build_searcher()
    _prime_simple_pipeline(s)
    parsed_goal = s.task_goal_parser.parse.return_value
    parsed_goal.context = []

    submitted_executors: list[ContextThreadPoolExecutor] = []
    real_submit = s._search_subtask_executor.submit

    def tracking_submit(fn, *args, **kwargs):
        submitted_executors.append(s._search_subtask_executor)
        return real_submit(fn, *args, **kwargs)

    with patch.object(s._search_subtask_executor, "submit", side_effect=tracking_submit):
        s._retrieve_from_long_term_and_user(
            query="q",
            parsed_goal=parsed_goal,
            query_embedding=[[0.1] * 5],
            top_k=1,
            memory_type="LongTermMemory",
            id_filter=None,
            mode="fast",
        )

    assert submitted_executors, (
        "_retrieve_from_long_term_and_user must submit to the shared subtask "
        "executor, not a fresh per-call pool"
    )


def test_tool_memory_path_uses_subtask_executor():
    """`_retrieve_from_tool_memory` MUST submit to the subtask pool."""
    s = _build_searcher()
    _prime_simple_pipeline(s)
    parsed_goal = s.task_goal_parser.parse.return_value
    parsed_goal.context = []

    tool_item = TextualMemoryItem(
        memory="tool",
        metadata=TreeNodeTextualMemoryMetadata(
            embedding=[0.1] * 5, usage=[], memory_type="ToolSchemaMemory"
        ),
    )
    s.graph_retriever.retrieve.return_value = [tool_item]

    submitted = []
    real_submit = s._search_subtask_executor.submit

    def tracking_submit(fn, *args, **kwargs):
        submitted.append(1)
        return real_submit(fn, *args, **kwargs)

    with patch.object(s._search_subtask_executor, "submit", side_effect=tracking_submit):
        s._retrieve_from_tool_memory(
            query="q",
            parsed_goal=parsed_goal,
            query_embedding=[[0.1] * 5],
            top_k=1,
            memory_type="ToolSchemaMemory",
            id_filter=None,
            mode="fast",
        )

    assert submitted, "_retrieve_from_tool_memory must submit to the shared subtask executor"


def test_dedup_rawfile_uses_subtask_executor():
    """`_deduplicate_rawfile_results` MUST submit to the subtask pool when
    there are RawFileMemory items to inspect."""
    s = _build_searcher()
    s.graph_store.get_edges = MagicMock(return_value=[])

    rawfile_item = TextualMemoryItem(
        memory="raw",
        metadata=TreeNodeTextualMemoryMetadata(
            embedding=[0.1] * 5, usage=[], memory_type="RawFileMemory"
        ),
    )

    submitted = []
    real_submit = s._search_subtask_executor.submit

    def tracking_submit(fn, *args, **kwargs):
        submitted.append(1)
        return real_submit(fn, *args, **kwargs)

    with patch.object(s._search_subtask_executor, "submit", side_effect=tracking_submit):
        s._deduplicate_rawfile_results([rawfile_item], user_name="u")

    assert submitted, (
        "_deduplicate_rawfile_results must submit to the shared subtask "
        "executor when RawFileMemory items are present"
    )


def test_dedup_rawfile_timeout_returns_partial_results(monkeypatch):
    """If get_edges hangs, dedup MUST not block the caller forever."""
    s = _build_searcher()
    monkeypatch.setattr(searcher_module, "SEARCH_TASK_TIMEOUT_SECONDS", 0.5)

    block_event = threading.Event()

    def hanging_get_edges(*args, **kwargs):
        block_event.wait(timeout=10)
        return []

    s.graph_store.get_edges = MagicMock(side_effect=hanging_get_edges)

    rawfile_item = TextualMemoryItem(
        memory="raw",
        metadata=TreeNodeTextualMemoryMetadata(
            embedding=[0.1] * 5, usage=[], memory_type="RawFileMemory"
        ),
    )

    warnings_seen: list[str] = []
    monkeypatch.setattr(
        searcher_module.logger,
        "warning",
        lambda msg, *a, **kw: warnings_seen.append(msg % a if a else str(msg)),
    )

    started = time.monotonic()
    try:
        out = s._deduplicate_rawfile_results([rawfile_item], user_name="u")
    finally:
        block_event.set()
    elapsed = time.monotonic() - started

    assert elapsed < 5.0, f"dedup blocked for {elapsed:.2f}s — timeout did not fire"
    # On timeout, original results are returned unfiltered (no edge data → no removal).
    assert out == [rawfile_item]
