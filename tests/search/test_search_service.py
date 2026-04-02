from memos.api.product_models import APISearchRequest
from memos.search import build_search_context


def test_build_search_context_without_session_id_does_not_inject_default_session():
    request = APISearchRequest(query="find memory", user_id="user_a")

    context = build_search_context(request)

    assert context.target_session_id is None
    assert context.search_priority is None
    assert context.info == {
        "user_id": "user_a",
        "chat_history": None,
    }


def test_build_search_context_with_session_id_keeps_soft_priority_and_info():
    request = APISearchRequest(query="find memory", user_id="user_a", session_id="session_42")

    context = build_search_context(request)

    assert context.target_session_id == "session_42"
    assert context.search_priority == {"session_id": "session_42"}
    assert context.info == {
        "user_id": "user_a",
        "chat_history": None,
        "session_id": "session_42",
    }
