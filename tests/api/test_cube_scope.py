from unittest.mock import Mock

from memos.api.handlers.add_handler import AddHandler
from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.handlers.feedback_handler import FeedbackHandler
from memos.api.handlers.search_handler import SearchHandler
from memos.api.product_models import APIADDRequest, APIFeedbackRequest, APISearchRequest


def _make_dependencies() -> HandlerDependencies:
    return HandlerDependencies(
        naive_mem_cube=Mock(),
        mem_reader=Mock(),
        mem_scheduler=Mock(),
        searcher=Mock(),
        reranker=Mock(),
        feedback_server=Mock(),
        deepsearch_agent=Mock(),
    )


def test_search_handler_prefers_mem_cube_id_over_user_id_fallback():
    handler = SearchHandler(_make_dependencies())
    request = APISearchRequest(query="where is it", user_id="user_a", mem_cube_id="cube_a")

    assert handler._resolve_cube_ids(request) == ["cube_a"]


def test_search_handler_deduplicates_readable_cube_ids():
    handler = SearchHandler(_make_dependencies())
    request = APISearchRequest(
        query="where is it",
        user_id="user_a",
        readable_cube_ids=["cube_a", "cube_a", "cube_b"],
    )

    assert handler._resolve_cube_ids(request) == ["cube_a", "cube_b"]


def test_add_handler_prefers_mem_cube_id_over_user_id_fallback():
    handler = AddHandler(_make_dependencies())
    request = APIADDRequest(user_id="user_a", mem_cube_id="cube_a", memory_content="remember this")

    assert handler._resolve_cube_ids(request) == ["cube_a"]


def test_feedback_handler_prefers_mem_cube_id_over_user_id_fallback():
    handler = FeedbackHandler(_make_dependencies())
    request = APIFeedbackRequest(
        user_id="user_a",
        mem_cube_id="cube_a",
        history=[],
        feedback_content="that memory is wrong",
    )

    assert handler._resolve_cube_ids(request) == ["cube_a"]
