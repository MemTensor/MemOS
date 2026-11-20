"""Borrowing one component must not suppress initialization of another."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.exceptions import ConfigurationError, MemOSError
from memos.mem_scheduler.base_scheduler import BaseScheduler


@pytest.fixture
def scheduler():
    scheduler = BaseScheduler({"use_redis_queue": False, "thread_pool_max_workers": 2})
    yield scheduler
    scheduler.close()


def test_borrowed_cube_builds_feedback_from_same_dependencies(scheduler, monkeypatch):
    default_factory = Mock(side_effect=AssertionError("must not create a default cube"))
    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", default_factory)
    text = SimpleNamespace(
        extractor_llm=Mock(),
        embedder=Mock(),
        graph_store=Mock(),
        memory_manager=Mock(),
        reranker=Mock(),
    )
    cube = SimpleNamespace(text_mem=text, close=Mock())
    scheduler.mem_reader = Mock()
    scheduler.searcher = Mock()
    scheduler.mem_cube = cube
    feedback = scheduler.feedback_server
    assert feedback is not None
    assert feedback is scheduler.feedback_server
    assert feedback.graph_store is text.graph_store
    assert feedback.memory_manager is text.memory_manager
    assert feedback.llm is text.extractor_llm
    assert feedback.embedder is text.embedder
    assert feedback.mem_reader is scheduler.mem_reader
    assert feedback.searcher is scheduler.searcher
    assert scheduler.mem_cube is cube and scheduler.components is None
    scheduler.close()
    cube.close.assert_not_called()
    text.graph_store.close.assert_not_called()
    default_factory.assert_not_called()


def test_missing_dependencies_fail_explicitly_and_can_be_supplied(scheduler):
    cube = SimpleNamespace(text_mem=SimpleNamespace())
    scheduler.mem_cubes = {"borrowed": cube}
    with pytest.raises(ConfigurationError, match="Feedback"):
        _ = scheduler.feedback_server
    assert scheduler.mem_cube is cube and scheduler.components is None
    external = Mock()
    scheduler.feedback_server = external
    assert scheduler.feedback_server is external
    scheduler.close()
    external.close.assert_not_called()


def test_borrowed_feedback_survives_owned_cube_initialization(scheduler, monkeypatch):
    external = Mock()
    owned = {"naive_mem_cube": Mock(), "feedback_server": Mock(), "graph_db": Mock()}
    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", lambda: owned)
    scheduler.feedback_server = external
    assert scheduler.mem_cube is owned["naive_mem_cube"]
    assert scheduler.feedback_server is external
    scheduler.close()
    owned["graph_db"].close.assert_called_once()
    external.close.assert_not_called()


def test_changing_cube_discards_only_automatically_assembled_feedback(scheduler, monkeypatch):
    first, second = Mock(), Mock()
    first_feedback, second_feedback = Mock(), Mock()
    scheduler.mem_cube = first
    factory = Mock(side_effect=[first_feedback, second_feedback])
    monkeypatch.setattr(scheduler, "_feedback_for_borrowed_cube", factory)
    assert scheduler.feedback_server is first_feedback
    scheduler.mem_cube = first
    assert scheduler.feedback_server is first_feedback
    scheduler.mem_cube = second
    assert scheduler.feedback_server is second_feedback
    explicit = Mock()
    scheduler.feedback_server = explicit
    scheduler.mem_cube = first
    assert scheduler.feedback_server is explicit


def test_failed_borrowed_assembly_can_retry(scheduler, monkeypatch):
    scheduler.mem_cube = Mock()
    feedback = Mock()
    factory = Mock(side_effect=[ConfigurationError("missing dependency"), feedback])
    monkeypatch.setattr(scheduler, "_feedback_for_borrowed_cube", factory)
    with pytest.raises(ConfigurationError):
        _ = scheduler.feedback_server
    assert scheduler._feedback_server is None
    assert scheduler.feedback_server is feedback


def test_close_prevents_late_borrowed_feedback_publication(scheduler, monkeypatch):
    scheduler.mem_cube = Mock()
    entered, release = Event(), Event()

    def assemble():
        entered.set()
        assert release.wait(3)
        return Mock()

    monkeypatch.setattr(scheduler, "_feedback_for_borrowed_cube", assemble)
    with ThreadPoolExecutor(2) as pool:
        creation = pool.submit(lambda: scheduler.feedback_server)
        assert entered.wait(3)
        closing = pool.submit(scheduler.close)
        try:
            assert scheduler._close_state.closing.wait(3)
        finally:
            release.set()
        with pytest.raises(MemOSError):
            creation.result(timeout=3)
        closing.result(timeout=3)
    assert scheduler._feedback_server is None
