import ast
import inspect
import time

from unittest.mock import MagicMock, patch

import pytest

from memos.context.context import ContextThreadPoolExecutor
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.retrieve import searcher as searcher_module
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.reranker.base import BaseReranker


@pytest.fixture
def mock_searcher():
    dispatcher_llm = MagicMock()
    graph_store = MagicMock()
    embedder = MagicMock()

    reranker = MagicMock(spec=BaseReranker)
    s = Searcher(dispatcher_llm, graph_store, embedder, reranker)

    # Mock internals
    s.task_goal_parser = MagicMock()
    s.graph_retriever = MagicMock()
    s.reasoner = MagicMock()

    return s


def make_item(content: str, score: float):
    # Simulate a TextualMemoryItem with usage list for update test
    return (
        TextualMemoryItem(
            memory=content,
            metadata=TreeNodeTextualMemoryMetadata(
                embedding=[0.1] * 5,
                usage=[],
            ),
        ),
        score,
    )


def test_searcher_fast_path(mock_searcher):
    query = "Tell me about cats"
    parsed_goal = MagicMock()
    parsed_goal.memories = ["Cats are cute"]

    mock_searcher.task_goal_parser.parse.return_value = parsed_goal

    mock_searcher.embedder.embed.return_value = [[0.1] * 5, [0.2] * 5]

    # working path mock
    # For "All", _retrieve_from_working_memory calls once (WorkingMemory),
    # and _retrieve_from_long_term_and_user calls 3 times (LongTermMemory, UserMemory, RawFileMemory)
    # Use a function to handle concurrent calls with different memory_scope
    def retrieve_side_effect(*args, **kwargs):
        memory_scope = kwargs.get("memory_scope", "")
        if memory_scope == "WorkingMemory":
            return [make_item("wm1", 0.9)[0]]
        elif memory_scope == "LongTermMemory":
            return [make_item("lt1", 0.8)[0]]
        elif memory_scope == "UserMemory":
            return [make_item("um1", 0.7)[0]]
        elif memory_scope == "RawFileMemory":
            return [make_item("rm1", 0.6)[0]]
        else:
            return []

    mock_searcher.graph_retriever.retrieve.side_effect = retrieve_side_effect
    mock_searcher.reranker.rerank.return_value = [
        make_item("wm1", 0.9),
        make_item("lt1", 0.8),
        make_item("um1", 0.7),
    ]

    result = mock_searcher.search(
        query=query, top_k=2, info={"test": True}, mode="fast", memory_type="All"
    )

    assert mock_searcher.task_goal_parser.parse.called
    mock_searcher.embedder.embed.assert_called_once()

    assert len(result) <= 2
    assert all(isinstance(item, TextualMemoryItem) for item in result)


def test_searcher_can_skip_rerank_per_request(mock_searcher):
    parsed_goal = MagicMock()
    parsed_goal.memories = ["Cats are cute"]
    parsed_goal.rephrased_query = None
    mock_searcher.task_goal_parser.parse.return_value = parsed_goal
    mock_searcher.embedder.embed.return_value = [[0.1] * 5, [0.2] * 5]
    mock_searcher.graph_retriever.retrieve.return_value = [make_item("wm1", 0.9)[0]]

    result = mock_searcher.search(
        query="Tell me about cats",
        top_k=1,
        info={"test": True},
        mode="fast",
        memory_type="WorkingMemory",
        rerank=False,
    )

    mock_searcher.reranker.rerank.assert_not_called()
    assert len(result) == 1
    assert result[0].memory == "wm1"


def test_searcher_fine_mode_triggers_reasoner(mock_searcher):
    parsed_goal = MagicMock()
    parsed_goal.memories = ["Cats"]

    mock_searcher.task_goal_parser.parse.return_value = parsed_goal
    mock_searcher.embedder.embed.return_value = [[0.1] * 5]

    # working + long-term/user
    mock_searcher.graph_retriever.retrieve.return_value = [make_item("mem", 0.5)[0]]
    mock_searcher.reranker.rerank.return_value = [make_item("mem", 0.5)]

    # Simulate reasoner output
    mock_searcher.reasoner.reason.return_value = [make_item("mem", 0.5)[0]]

    result = mock_searcher.search(
        query="Tell me about dogs",
        top_k=1,
        mode="fine",
    )
    assert len(result) == 1


def test_searcher_respects_memory_type(mock_searcher):
    parsed_goal = MagicMock()
    parsed_goal.memories = ["Something"]
    mock_searcher.task_goal_parser.parse.return_value = parsed_goal
    mock_searcher.embedder.embed.return_value = [[0.1] * 5]

    mock_searcher.graph_retriever.retrieve.return_value = []
    mock_searcher.reranker.rerank.return_value = []

    mock_searcher.search(
        query="x",
        top_k=1,
        mode="fast",
        memory_type="WorkingMemory",
    )
    # WorkingMemory triggers only once path A
    assert mock_searcher.graph_retriever.retrieve.call_args[1]["memory_scope"] == "WorkingMemory"


# ---------------------------------------------------------------------------
# Bug #1273 regression: bounded thread pools
# ---------------------------------------------------------------------------


def _make_searcher():
    dispatcher_llm = MagicMock()
    graph_store = MagicMock()
    embedder = MagicMock()
    reranker = MagicMock(spec=BaseReranker)
    return Searcher(dispatcher_llm, graph_store, embedder, reranker)


def test_searcher_creates_shared_executors_in_init():
    """Regression for #1273: Searcher must pre-allocate class-level shared
    ContextThreadPoolExecutor instances instead of constructing them per request."""
    s = _make_searcher()
    for attr, expected_workers in [
        ("_search_paths_executor", 5),
        ("_search_long_term_executor", 3),
        ("_search_tool_mem_executor", 2),
        ("_search_dedup_executor", 10),
    ]:
        assert hasattr(s, attr), f"Searcher must expose {attr}"
        executor = getattr(s, attr)
        assert isinstance(executor, ContextThreadPoolExecutor), (
            f"{attr} must be a ContextThreadPoolExecutor, got {type(executor)!r}"
        )
        # NOTE: ThreadPoolExecutor does not expose max_workers publicly, so we
        # inspect the private `_max_workers` attribute. This is stable on
        # CPython 3.9-3.13 (the versions this project tests against); use
        # getattr so a future rename fails with a clear assertion message
        # instead of an AttributeError.
        actual_workers = getattr(executor, "_max_workers", None)
        assert actual_workers == expected_workers, (
            f"{attr} max_workers={actual_workers}, expected {expected_workers} "
            "(None means the private _max_workers attribute is gone — "
            "update this test for the current Python version)"
        )


def test_searcher_reuses_pool_across_retrieve_paths_calls():
    """Regression for #1273: repeated _retrieve_paths calls must NOT spawn a
    fresh ContextThreadPoolExecutor each time. The class-level pool must be
    reused, keeping thread count bounded regardless of QPS."""
    s = _make_searcher()

    # stub internals so _retrieve_paths returns immediately
    s.task_goal_parser = MagicMock()
    s.graph_retriever = MagicMock()
    s.graph_retriever.retrieve.return_value = []
    s.reasoner = MagicMock()

    parsed_goal = MagicMock()
    parsed_goal.memories = []
    parsed_goal.rephrased_query = None
    s.task_goal_parser.parse.return_value = parsed_goal
    s.embedder.embed.return_value = [[0.1] * 5]

    pool_ids_seen = []
    original_paths_executor = s._search_paths_executor
    orig_submit = original_paths_executor.submit

    def tracking_submit(fn, *args, **kwargs):
        pool_ids_seen.append(id(original_paths_executor))
        return orig_submit(fn, *args, **kwargs)

    with patch.object(original_paths_executor, "submit", side_effect=tracking_submit):
        # First call
        s._retrieve_paths(
            query="q",
            parsed_goal=parsed_goal,
            query_embedding=[[0.1] * 5],
            info={},
            top_k=1,
            mode="fast",
            memory_type="WorkingMemory",
        )
        # Second call (distinct valid mode to also cover the 'fine' path)
        s._retrieve_paths(
            query="q",
            parsed_goal=parsed_goal,
            query_embedding=[[0.1] * 5],
            info={},
            top_k=1,
            mode="fine",
            memory_type="WorkingMemory",
        )

    assert pool_ids_seen, "expected at least one submit to the shared paths executor"
    assert len(set(pool_ids_seen)) == 1, (
        "the paths executor must be a single shared instance across calls; "
        f"saw distinct ids: {set(pool_ids_seen)}"
    )
    # Executor must NOT have been shut down by the with-block
    assert not original_paths_executor._shutdown, (
        "shared paths executor must remain open between requests; "
        "presence of shutdown indicates per-request lifetime and bug #1273 regression"
    )


def _searcher_method_ast(method_name: str) -> ast.FunctionDef:
    """Return the AST node of a Searcher method, resolved from the module
    source. Unlike ``inspect.getsource(getattr(Searcher, name))`` this is
    immune to decorators such as ``@timed`` (which does not use
    ``functools.wraps``, so the bound method's ``__code__`` points at the
    decorator's wrapper, not the real method body)."""
    tree = ast.parse(inspect.getsource(searcher_module))
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "Searcher":
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and item.name == method_name:
                    return item
    raise AssertionError(f"method {method_name} not found on Searcher")


def _is_as_completed_call(node: ast.AST) -> bool:
    return isinstance(node, ast.Call) and (
        (isinstance(node.func, ast.Name) and node.func.id == "as_completed")
        or (isinstance(node.func, ast.Attribute) and node.func.attr == "as_completed")
    )


def test_searcher_future_result_calls_use_timeout():
    """Regression for #1273: waiting on sub-task futures in the four affected
    methods must be time-bounded so a hung sub-task cannot block a request
    forever. A wait is bounded when either:
    - ``future.result(timeout=...)`` is passed a timeout directly, or
    - futures are collected via ``as_completed(..., timeout=...)`` — futures
      yielded by ``as_completed`` are already done, so their ``.result()``
      correctly takes no timeout.
    """
    assert hasattr(searcher_module, "SEARCH_FUTURE_RESULT_TIMEOUT"), (
        "expected module-level SEARCH_FUTURE_RESULT_TIMEOUT constant"
    )
    assert isinstance(searcher_module.SEARCH_FUTURE_RESULT_TIMEOUT, (int, float))
    assert searcher_module.SEARCH_FUTURE_RESULT_TIMEOUT > 0

    for method_name in [
        "_retrieve_paths",
        "_retrieve_from_long_term_and_user",
        "_retrieve_from_tool_memory",
        "_deduplicate_rawfile_results",
    ]:
        method_ast = _searcher_method_ast(method_name)
        result_calls = [
            node
            for node in ast.walk(method_ast)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "result"
        ]
        assert result_calls, f"{method_name}: expected at least one future .result() call"

        has_bounded_as_completed = any(
            _is_as_completed_call(node) and any(kw.arg == "timeout" for kw in node.keywords)
            for node in ast.walk(method_ast)
        )
        for call in result_calls:
            has_timeout_kwarg = any(kw.arg == "timeout" for kw in call.keywords)
            assert has_timeout_kwarg or has_bounded_as_completed, (
                f"{method_name}: unbounded future .result() call at line "
                f"{call.lineno} — pass timeout=SEARCH_FUTURE_RESULT_TIMEOUT or "
                f"iterate futures via as_completed(..., timeout=...)"
            )

    assert "SEARCH_FUTURE_RESULT_TIMEOUT" in inspect.getsource(searcher_module), (
        "SEARCH_FUTURE_RESULT_TIMEOUT constant must be applied in searcher.py"
    )


def test_searcher_close_shuts_down_all_executors():
    """Searcher.close() (and the context-manager protocol) must shut down all
    five shared executors so worker threads do not outlive the instance."""
    executor_attrs = [
        "_usage_executor",
        "_search_paths_executor",
        "_search_long_term_executor",
        "_search_tool_mem_executor",
        "_search_dedup_executor",
    ]

    s = _make_searcher()
    s.close()
    for attr in executor_attrs:
        assert getattr(s, attr)._shutdown, f"{attr} must be shut down after close()"
    # close() must be idempotent
    s.close()

    with _make_searcher() as s2:
        for attr in executor_attrs:
            assert not getattr(s2, attr)._shutdown
    for attr in executor_attrs:
        assert getattr(s2, attr)._shutdown, f"{attr} must be shut down on context exit"


def test_searcher_survives_slow_subtask(monkeypatch):
    """Regression for #1273: if a submitted sub-task exceeds
    SEARCH_FUTURE_RESULT_TIMEOUT, .search() must recover with a warning
    instead of raising or hanging."""
    # shrink timeout so the test runs fast
    monkeypatch.setattr(searcher_module, "SEARCH_FUTURE_RESULT_TIMEOUT", 0.1)

    s = _make_searcher()
    s.task_goal_parser = MagicMock()
    s.graph_retriever = MagicMock()
    s.reasoner = MagicMock()

    parsed_goal = MagicMock()
    parsed_goal.memories = []
    parsed_goal.rephrased_query = None
    s.task_goal_parser.parse.return_value = parsed_goal
    s.embedder.embed.return_value = [[0.1] * 5]

    def slow_retrieve(*_args, **_kwargs):
        time.sleep(0.5)  # 5x the timeout
        return [make_item("late", 0.1)[0]]

    s.graph_retriever.retrieve.side_effect = slow_retrieve
    s.reranker.rerank.return_value = []

    start = time.time()
    result = s.search(
        query="anything",
        top_k=1,
        info={"user_id": "u"},
        mode="fast",
        memory_type="WorkingMemory",
    )
    elapsed = time.time() - start

    # Must return (not raise), and quickly (well below the sleep of 0.5s).
    assert elapsed < 0.45, f"search took {elapsed:.3f}s, expected <0.45s once timeout={0.1}s fires"
    assert isinstance(result, list)
