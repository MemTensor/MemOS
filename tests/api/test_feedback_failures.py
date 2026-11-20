"""Feedback failures stay failures for HTTP consumers and direct cube users."""

import inspect

from unittest.mock import Mock

import pytest

from fastapi import HTTPException
from test_server_router import client as _client
from test_server_router import mock_init_server as _mock_init_server

from memos.api.handlers.add_handler import AddHandler
from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.handlers.feedback_handler import FeedbackHandler
from memos.api.product_models import APIADDRequest, APIFeedbackRequest
from memos.exceptions import GraphDBError, MemOSError
from memos.multi_mem_cube.composite_cube import CompositeCubeView
from memos.multi_mem_cube.single_cube import SingleCubeView


client, mock_init_server = _client, _mock_init_server


@pytest.fixture
def components():
    dependencies = HandlerDependencies(
        naive_mem_cube=Mock(),
        mem_reader=Mock(),
        mem_scheduler=Mock(),
        feedback_server=Mock(),
        searcher=Mock(),
        reranker=Mock(),
    )
    view = SingleCubeView(
        cube_id="cube",
        naive_mem_cube=dependencies.naive_mem_cube,
        mem_reader=dependencies.mem_reader,
        mem_scheduler=dependencies.mem_scheduler,
        logger=Mock(),
        feedback_server=dependencies.feedback_server,
        searcher=None,
    )
    view.add_memories = Mock(return_value=[])
    return dependencies, view


@pytest.mark.parametrize("mode", ["sync", "async"])
@pytest.mark.parametrize("entry", ["add", "feedback"])
def test_failed_feedback_returns_safe_error_without_ordinary_add(components, mode, entry):
    dependencies, view = components
    error = (
        GraphDBError("private driver diagnostic")
        if mode == "sync"
        else OSError("private queue diagnostic")
    )
    dependencies.feedback_server.process_feedback.side_effect = error
    dependencies.mem_scheduler.submit_messages.side_effect = error
    handler = AddHandler(dependencies) if entry == "add" else FeedbackHandler(dependencies)
    handler._build_cube_view = Mock(return_value=view)
    request = (
        APIADDRequest(
            user_id="u",
            is_feedback=True,
            async_mode=mode,
            messages=[{"role": "user", "content": "feedback"}],
        )
        if entry == "add"
        else APIFeedbackRequest(
            user_id="u", history=[], feedback_content="feedback", async_mode=mode
        )
    )
    call = (
        inspect.unwrap(AddHandler.handle_add_memories)
        if entry == "add"
        else FeedbackHandler.handle_feedback_memories
    )
    with pytest.raises(HTTPException) as caught:
        call(handler, request)
    assert caught.value.status_code == 500
    assert caught.value.detail == "Feedback processing failed"
    assert caught.value.__cause__ is error
    view.add_memories.assert_not_called()


def test_direct_cube_submission_failure_is_visible(components):
    dependencies, view = components
    error = MemOSError("queue rejected")
    dependencies.mem_scheduler.submit_messages.side_effect = error
    with pytest.raises(MemOSError) as caught:
        view.feedback_memories(
            APIFeedbackRequest(
                user_id="u", history=[], feedback_content="feedback", async_mode="async"
            )
        )
    assert caught.value is error


@pytest.mark.parametrize("mode", ["sync", "async"])
def test_composite_preserves_full_feedback_results(components, mode):
    _, view = components
    first = {"answer": "one", "answer_status": "generated", "record": {"add": ["a"], "update": []}}
    second = {"answer": "two", "answer_status": "generated", "record": {"add": [], "update": ["b"]}}
    view.feedback_server.process_feedback.side_effect = [first, second]
    composite = CompositeCubeView(cube_views=[view, view], logger=Mock())
    result = composite.feedback_memories(
        APIFeedbackRequest(user_id="u", history=[], feedback_content="feedback", async_mode=mode)
    )
    assert result == ([first, second] if mode == "sync" else [])


@pytest.mark.parametrize("entry", ["add", "feedback"])
@pytest.mark.parametrize("mode", ["sync", "async"])
@pytest.mark.parametrize("failed", [False, True])
def test_real_routes_accept_only_successful_feedback(
    client, monkeypatch, components, entry, mode, failed
):
    from memos.api.routers import server_router

    dependencies, view = components
    record = {
        "answer": "",
        "answer_status": "not_requested",
        "record": {"add": ["stored"], "update": []},
    }
    dependencies.feedback_server.process_feedback.return_value = record
    if failed:
        dependencies.feedback_server.process_feedback.side_effect = GraphDBError(
            "private diagnostic"
        )
        dependencies.mem_scheduler.submit_messages.side_effect = OSError("private diagnostic")
    handler = AddHandler(dependencies) if entry == "add" else FeedbackHandler(dependencies)
    handler._build_cube_view = Mock(return_value=view)
    monkeypatch.setattr(server_router, entry + "_handler", handler)
    payload = {"user_id": "u", "async_mode": mode}
    if entry == "add":
        payload.update(is_feedback=True, messages=[{"role": "user", "content": "feedback"}])
    else:
        payload.update(history=[], feedback_content="feedback")
    response = client.post("/product/" + entry, json=payload)
    assert response.status_code == (500 if failed else 200)
    assert response.json()["code"] == response.status_code
    if failed:
        assert response.json()["message"] == "Feedback processing failed"
        assert "private" not in response.text
    else:
        assert response.json()["data"] == ([[]] if mode == "async" else [record])
    view.add_memories.assert_not_called()


@pytest.mark.parametrize(
    "info", [None, {"application": "agent"}, {"memory_type": "ignored", "application": "agent"}]
)
def test_ordinary_add_and_info_filter_are_unchanged(components, info):
    dependencies, view = components
    handler = AddHandler(dependencies)
    handler._build_cube_view = Mock(return_value=view)
    request = APIADDRequest(
        user_id="u", messages=[{"role": "user", "content": "ordinary"}], info=info
    )
    view.add_memories.return_value = [{"id": "ordinary-memory"}]
    result = inspect.unwrap(AddHandler.handle_add_memories)(handler, request)
    assert result.data == [{"id": "ordinary-memory"}]
    assert request.info == (None if info is None else {"application": "agent"})
    dependencies.feedback_server.process_feedback.assert_not_called()
