import inspect

import pytest

from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.handlers.search_handler import SearchHandler
from memos.api.product_models import APISearchRequest
from memos.plugins.hook_context import HookContext
from memos.plugins.hook_defs import H
from memos.plugins.hooks import register_hook


pytestmark = pytest.mark.usefixtures("clean_hooks")


def _empty_search_results() -> dict:
    return {
        "text_mem": [],
        "act_mem": [],
        "para_mem": [],
        "pref_mem": [],
        "pref_note": "",
        "tool_mem": [],
        "skill_mem": [],
    }


class _CubeView:
    def __init__(self, results: dict):
        self.results = results
        self.request = None

    def search_memories(self, request):
        self.request = request
        return self.results


def _search_handler() -> tuple[SearchHandler, _CubeView]:
    handler = SearchHandler(
        HandlerDependencies(
            naive_mem_cube=object(),
            mem_scheduler=object(),
            searcher=object(),
            deepsearch_agent=object(),
        )
    )
    cube_view = _CubeView(_empty_search_results())
    handler._build_cube_view = lambda _search_req: cube_view
    return handler, cube_view


def test_search_success_hooks_run_in_order_with_distinct_stage_operations(monkeypatch):
    events = []
    result_hook_calls = []
    handler, cube_view = _search_handler()
    search_req = APISearchRequest(
        user_id="user",
        query="original query",
        session_id="session-1",
        readable_cube_ids=["cube-1", "cube-2", "cube-1"],
    )
    monkeypatch.setattr(
        "memos.api.handlers.search_handler.get_current_trace_id",
        lambda: "trace-1",
    )

    def replace_request(*, hook_context, request):
        events.append((H.SEARCH_BEFORE, hook_context))
        return request.model_copy(update={"query": "hooked query"})

    def record_results(hook_name):
        def callback(*, hook_context, **kwargs):
            events.append((hook_name, hook_context))
            result_hook_calls.append(kwargs)

        return callback

    def replace_response(*, hook_context, result, **_kwargs):
        events.append((H.SEARCH_AFTER, hook_context))
        return result.model_copy(update={"message": "hooked response"})

    result_hooks = [
        H.SEARCH_MEMORY_RESULTS,
        H.SEARCH_RESULTS_AFTER_THRESHOLD,
        H.SEARCH_RESULTS_AFTER_DEDUP,
        H.SEARCH_RESULTS_AFTER_RERANK,
        H.SEARCH_CONTEXT_RENDER,
    ]
    register_hook(H.SEARCH_BEFORE, replace_request)
    for hook_name in result_hooks:
        register_hook(hook_name, record_results(hook_name))
    register_hook(H.SEARCH_AFTER, replace_response)

    response = handler.handle_search_memories(search_req)

    assert [name for name, _context in events] == [
        H.SEARCH_BEFORE,
        *result_hooks,
        H.SEARCH_AFTER,
    ]
    contexts = [context for _name, context in events]
    assert contexts[-1] is contexts[0]
    assert len({context.operation_id for context in contexts}) == 6
    context = contexts[0]
    assert isinstance(context, HookContext)
    assert context.trace_id == "trace-1"
    assert context.user_id == "user"
    assert context.session_id == "session-1"
    assert context.cube_ids == ("cube-1", "cube-2")
    assert context.source == "api.search"
    assert context.attributes == {"mode": "fast"}
    assert context.operation_id
    for stage_context in contexts[1:-1]:
        assert stage_context.source == "api.search"
        assert stage_context.operation_id != context.operation_id
        assert stage_context.attributes == {"mode": "fast"}
        assert stage_context.attributes is not context.attributes
        for field in ("trace_id", "user_id", "session_id", "task_id", "cube_ids"):
            assert getattr(stage_context, field) == getattr(context, field)
    assert cube_view.request.query == "hooked query"
    assert all(call["handler"] is handler for call in result_hook_calls)
    assert all(call["search_req"] is cube_view.request for call in result_hook_calls)
    assert response.message == "hooked response"


@pytest.mark.parametrize(
    "hook_name",
    [
        H.SEARCH_MEMORY_RESULTS,
        H.SEARCH_RESULTS_AFTER_THRESHOLD,
        H.SEARCH_RESULTS_AFTER_DEDUP,
        H.SEARCH_RESULTS_AFTER_RERANK,
        H.SEARCH_CONTEXT_RENDER,
    ],
)
def test_search_result_hooks_replace_memories_in_response(hook_name):
    handler, _cube_view = _search_handler()
    memory = {
        "id": "plugin-memory",
        "memory": "Remember tea",
        "metadata": {"relativity": 1.0, "memory_type": "LongTermMemory"},
    }

    def replace_memories(*, results, **_kwargs):
        return {**results, "text_mem": [{"cube_id": "cube-1", "memories": [memory]}]}

    register_hook(hook_name, replace_memories)

    response = handler.handle_search_memories(
        APISearchRequest(user_id="user", query="drink", dedup="no")
    )

    assert response.data["text_mem"][0]["memories"] == [memory]


@pytest.mark.parametrize("failed_stage", ["threshold", "dedup", "rerank"])
def test_search_post_processing_failure_identifies_the_failed_operation(monkeypatch, failed_stage):
    error = RuntimeError("post processing failed")
    events = []
    handler, _cube_view = _search_handler()
    search_req = APISearchRequest(user_id="user", query="query", dedup="sim")
    observed_contexts = []
    register_hook(
        H.SEARCH_BEFORE, lambda **kwargs: observed_contexts.append(kwargs["hook_context"])
    )
    for name in (
        H.SEARCH_MEMORY_RESULTS,
        H.SEARCH_RESULTS_AFTER_THRESHOLD,
        H.SEARCH_RESULTS_AFTER_DEDUP,
        H.SEARCH_RESULTS_AFTER_RERANK,
    ):
        register_hook(name, lambda **kwargs: observed_contexts.append(kwargs["hook_context"]))
    monkeypatch.setattr(
        "memos.api.handlers.search_handler.get_current_trace_id",
        lambda: "trace-1",
    )

    def fail_post_processing(*_args, **_kwargs):
        raise error

    def record_failure(**kwargs):
        events.append((H.SEARCH_POST_PROCESS_FAILED, kwargs))

    if failed_stage == "threshold":
        handler._apply_relativity_threshold = fail_post_processing
    elif failed_stage == "dedup":
        handler._dedup_text_memories = fail_post_processing
    else:
        monkeypatch.setattr(
            "memos.api.handlers.search_handler.rerank_knowledge_mem", fail_post_processing
        )
    register_hook(H.SEARCH_POST_PROCESS_FAILED, record_failure)
    register_hook(H.SEARCH_CONTEXT_RENDER, lambda **_kwargs: events.append(("render", {})))
    register_hook(H.SEARCH_AFTER, lambda **_kwargs: events.append(("after", {})))

    with pytest.raises(RuntimeError, match="post processing failed") as exc_info:
        handler.handle_search_memories(search_req)

    assert exc_info.value is error
    assert [name for name, _kwargs in events] == [H.SEARCH_POST_PROCESS_FAILED]
    failure = events[0][1]
    assert failure["error"] is error
    assert failure["handler"] is handler
    assert failure["search_req"].query == "query"
    context = failure["hook_context"]
    assert context.trace_id == "trace-1"
    assert context.user_id == "user"
    assert context.source == "api.search"
    assert context.attributes == {"mode": "fast"}
    assert context.operation_id not in {prior.operation_id for prior in observed_contexts}


def test_search_handler_does_not_accept_hook_context():
    assert list(inspect.signature(SearchHandler.handle_search_memories).parameters) == [
        "self",
        "search_req",
    ]


def test_search_stage_operations_stay_isolated_between_searches_in_one_trace(monkeypatch):
    handler, _cube_view = _search_handler()
    monkeypatch.setattr(
        "memos.api.handlers.search_handler.get_current_trace_id", lambda: "one-trace"
    )
    contexts = []
    for name in (
        H.SEARCH_BEFORE,
        H.SEARCH_RESULTS_AFTER_THRESHOLD,
        H.SEARCH_RESULTS_AFTER_DEDUP,
        H.SEARCH_RESULTS_AFTER_RERANK,
    ):
        register_hook(name, lambda **kwargs: contexts.append(kwargs["hook_context"]))
    for query in ("first", "second"):
        handler.handle_search_memories(APISearchRequest(user_id="user", query=query))
    assert len({context.operation_id for context in contexts}) == 8
    assert all(context.attributes == {"mode": "fast"} for context in contexts)
