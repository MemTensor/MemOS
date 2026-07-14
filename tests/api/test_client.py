import json
import sys
import types

from pathlib import Path
from typing import Any

import pytest


SRC_DIR = Path(__file__).resolve().parents[2] / "src" / "memos"


def _install_memos_package_stub() -> None:
    if "memos" not in sys.modules:
        memos_pkg = types.ModuleType("memos")
        memos_pkg.__path__ = [str(SRC_DIR)]
        sys.modules["memos"] = memos_pkg

    if "memos.api" not in sys.modules:
        api_pkg = types.ModuleType("memos.api")
        api_pkg.__path__ = [str(SRC_DIR / "api")]
        sys.modules["memos.api"] = api_pkg
        sys.modules["memos"].api = api_pkg


def _load_client_module() -> Any:
    _install_memos_package_stub()

    import memos.api.client as client_module

    return client_module


class DummyResponse:
    def __init__(self, payload: dict):
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self.payload


class DummyStreamResponse:
    def __init__(self, lines: list[str]):
        self.lines = lines
        self.closed = False
        self.json_called = False

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        self.json_called = True
        raise AssertionError("streaming responses must not be parsed as JSON")

    def iter_lines(self, decode_unicode: bool = False):
        assert decode_unicode is True
        yield from self.lines

    def close(self) -> None:
        self.closed = True


def _response_for(url: str) -> dict:
    if url.endswith("/get/message"):
        return {"code": 200, "message": "ok", "data": {"message_detail_list": []}}
    if url.endswith("/add/message"):
        return {
            "code": 200,
            "message": "ok",
            "data": {"success": True, "task_id": "task-1", "status": "completed"},
        }
    if url.endswith("/search/memory"):
        return {"code": 200, "message": "ok", "data": {"memory_detail_list": []}}
    if url.endswith("/get/memory"):
        return {"code": 200, "message": "ok", "data": {"memory_detail_list": []}}
    if url.endswith("/create/knowledgebase"):
        return {"code": 200, "message": "ok", "data": {"id": "kb-1"}}
    if url.endswith("/get/knowledgebase-file"):
        return {"code": 200, "message": "ok", "data": {"file_detail_list": []}}
    if url.endswith("/delete/memory"):
        return {"code": 200, "message": "ok", "data": {"success": True}}
    if url.endswith("/add/feedback"):
        return {
            "code": 200,
            "message": "ok",
            "data": {"success": True, "task_id": "task-1", "status": "running"},
        }
    if url.endswith("/chat"):
        return {"code": 200, "message": "ok", "data": {"response": "answer"}}
    if url.endswith("/add/knowledgebase-file"):
        return {"code": 200, "message": "ok", "data": []}
    if url.endswith("/update/memory"):
        return {"code": 200, "message": "ok", "data": {"success": True}}
    if url.endswith("/extract/memory"):
        return {
            "code": 200,
            "message": "ok",
            "data": {
                "success": True,
                "memory_detail_list": [],
                "preference_detail_list": [],
            },
        }
    if url.endswith("/rerank"):
        return {"code": 200, "message": "ok", "data": {"id": "rerank-1", "results": []}}
    if url.endswith("/bind/profile_template"):
        return {"code": 200, "message": "ok", "data": {"success": True}}
    if url.endswith("/edit/profile"):
        return {"code": 200, "message": "ok", "data": {"success": True}}
    if url.endswith("/delete/profile"):
        return {"code": 200, "message": "ok", "data": {"success": True}}
    raise AssertionError(f"Unexpected URL: {url}")


@pytest.fixture
def client_module() -> Any:
    return _load_client_module()


@pytest.fixture
def posted_requests(monkeypatch, client_module):
    calls: list[dict] = []

    def fake_post(url: str, **kwargs):
        calls.append({"url": url, **kwargs})
        return DummyResponse(_response_for(url))

    monkeypatch.setattr(client_module.requests, "post", fake_post)
    return calls


@pytest.fixture
def fetched_requests(monkeypatch, client_module):
    calls: list[dict] = []

    def fake_get(url: str, **kwargs):
        calls.append({"url": url, **kwargs})
        return DummyResponse(
            {
                "code": 200,
                "message": "ok",
                "data": {"id": "memory-1", "memory_type": "LongTermMemory"},
            }
        )

    monkeypatch.setattr(client_module.requests, "get", fake_get)
    return calls


@pytest.fixture
def client(client_module) -> Any:
    return client_module.MemOSClient(api_key="test-key", base_url="https://example.test/openmem/v1")


def _json_payload(call: dict) -> dict:
    return json.loads(call["data"])


def test_add_message_uses_snake_case_async_mode_and_memory_view(
    client: Any, posted_requests: list[dict]
) -> None:
    client.add_message(
        messages=[{"role": "user", "content": "hello"}],
        user_id="user-1",
        conversation_id="conversation-1",
        async_mode=False,
        allow_memory_view=["kb-1"],
    )

    payload = _json_payload(posted_requests[0])

    assert payload["async_mode"] is False
    assert "asyncMode" not in payload
    assert payload["allow_memory_view"] == ["kb-1"]


def test_search_memory_sends_updated_existing_request_fields(
    client: Any, posted_requests: list[dict]
) -> None:
    client.search_memory(
        query="hello",
        user_id=None,
        agent_id="agent-1",
        relativity=0.2,
        include_skill=True,
        skill_limit_number=4,
        include_memory_view=["kb-1"],
        context_format="json",
    )

    payload = _json_payload(posted_requests[0])

    assert payload["conversation_id"] is None
    assert payload["agent_id"] == "agent-1"
    assert payload["relativity"] == 0.2
    assert payload["include_skill"] is True
    assert payload["skill_limit_number"] == 4
    assert payload["include_memory_view"] == ["kb-1"]
    assert payload["context_format"] == "json"


def test_get_memory_can_scope_by_agent_and_include_updated_filters(
    client: Any, posted_requests: list[dict]
) -> None:
    memory_filter = {"and": [{"memory_type": "LongTermMemory"}]}

    client.get_memory(
        user_id=None,
        agent_id="agent-1",
        include_tool_memory=False,
        include_memory_view=["kb-1"],
        filter=memory_filter,
        page=2,
        size=20,
    )

    payload = _json_payload(posted_requests[0])

    assert payload["user_id"] is None
    assert payload["agent_id"] == "agent-1"
    assert payload["include_tool_memory"] is False
    assert payload["include_memory_view"] == ["kb-1"]
    assert payload["filter"] == memory_filter
    assert payload["page"] == 2
    assert payload["size"] == 20


def test_get_memory_rejects_multiple_subjects(client: Any) -> None:
    with pytest.raises(ValueError, match="exactly one of user_id or agent_id"):
        client.get_memory(user_id="user-1", agent_id="agent-1")


def test_get_knowledgebase_file_supports_listing_by_knowledgebase(
    client: Any, posted_requests: list[dict]
) -> None:
    client.get_knowledgebase_file(
        knowledgebase_id="kb-1",
        type="doc",
        page=2,
        page_size=50,
    )

    payload = _json_payload(posted_requests[0])

    assert payload == {
        "file_ids": None,
        "knowledgebase_id": "kb-1",
        "type": "doc",
        "page": 2,
        "page_size": 50,
    }


def test_delete_memory_keeps_legacy_memory_id_call_but_sends_current_contract(
    client: Any, posted_requests: list[dict]
) -> None:
    client.delete_memory(user_ids=["legacy-user"], memory_ids=["memory-1"])

    payload = _json_payload(posted_requests[0])

    assert payload == {"memory_ids": ["memory-1"]}


def test_delete_memory_supports_quick_delete_by_user_id(
    client: Any, posted_requests: list[dict]
) -> None:
    client.delete_memory(user_id="user-1")

    payload = _json_payload(posted_requests[0])

    assert payload == {"user_id": "user-1"}


def test_chat_sends_updated_existing_request_fields(
    client: Any, posted_requests: list[dict]
) -> None:
    client.chat(
        user_id="user-1",
        conversation_id="conversation-1",
        query="hello",
        stream=True,
        allow_knowledgebase_ids=["kb-1"],
        include_tool_memory=True,
        tool_memory_limit_number=3,
        relativity=0.1,
    )

    payload = _json_payload(posted_requests[0])

    assert payload["stream"] is True
    assert payload["allow_knowledgebase_ids"] == ["kb-1"]
    assert payload["include_tool_memory"] is True
    assert payload["tool_memory_limit_number"] == 3
    assert payload["relativity"] == 0.1
    assert payload["add_message_on_answer"] is True


def test_add_knowledgebase_file_form_sends_type_and_closes_files(
    client: Any, posted_requests: list[dict], tmp_path
) -> None:
    file_path = tmp_path / "note.txt"
    file_path.write_text("hello", encoding="utf-8")

    client.add_knowledgebase_file_form(
        knowledgebase_id="kb-1",
        files=[str(file_path)],
        type="doc",
    )

    call = posted_requests[0]
    uploaded_file = call["files"][0][1][1]

    assert call["params"] == {"knowledgebase_id": "kb-1", "type": "doc"}
    assert uploaded_file.closed


def test_update_memory_sends_selected_fields(client: Any, posted_requests: list[dict]) -> None:
    response = client.update_memory(
        memory_id="memory-1",
        content="new content",
        title="new title",
        status="activated",
    )

    payload = _json_payload(posted_requests[0])

    assert posted_requests[0]["url"].endswith("/update/memory")
    assert payload == {
        "memory_id": "memory-1",
        "content": "new content",
        "title": "new title",
        "status": "activated",
    }
    assert response["data"]["success"] is True


def test_update_memory_requires_a_change(client: Any) -> None:
    with pytest.raises(ValueError, match="content, title or status is required"):
        client.update_memory(memory_id="memory-1")


def test_extract_memory_sends_messages_and_options(
    client: Any, posted_requests: list[dict]
) -> None:
    messages = [{"role": "user", "content": "I like tea", "chat_time": "2026-07-06"}]

    client.extract_memory(
        messages=messages,
        extraction_types=["memory", "preference"],
        model="extract-model",
    )

    payload = _json_payload(posted_requests[0])

    assert posted_requests[0]["url"].endswith("/extract/memory")
    assert payload == {
        "messages": messages,
        "extraction_types": ["memory", "preference"],
        "model": "extract-model",
    }


def test_rerank_sends_query_documents_and_options(client: Any, posted_requests: list[dict]) -> None:
    client.rerank(
        query="memory query",
        documents=["doc a", "doc b"],
        model="rerank-model",
        top_n=1,
    )

    payload = _json_payload(posted_requests[0])

    assert posted_requests[0]["url"].endswith("/rerank")
    assert payload == {
        "query": "memory query",
        "documents": ["doc a", "doc b"],
        "model": "rerank-model",
        "top_n": 1,
    }


def test_rerank_rejects_non_positive_top_n(client: Any) -> None:
    with pytest.raises(ValueError, match="top_n must be greater than 0"):
        client.rerank(query="memory query", documents=["doc a"], top_n=0)


def test_bind_profile_template_sends_bind_list(client: Any, posted_requests: list[dict]) -> None:
    bind_list = [{"profile_template_id": "profile-template-1", "user_id": "user-1"}]

    client.bind_profile_template(bind_list=bind_list)

    payload = _json_payload(posted_requests[0])

    assert posted_requests[0]["url"].endswith("/bind/profile_template")
    assert payload == {"bind_list": bind_list}


def test_edit_profile_sends_metadata_and_remove_fields(
    client: Any, posted_requests: list[dict]
) -> None:
    metadata = {"basic": {"city": "Hangzhou"}}

    client.edit_profile(
        profile_template_id="profile-template-1",
        user_id="user-1",
        metadata=metadata,
        remove_fields=["basic.job"],
    )

    payload = _json_payload(posted_requests[0])

    assert posted_requests[0]["url"].endswith("/edit/profile")
    assert payload == {
        "user_id": "user-1",
        "agent_id": None,
        "profile_template_id": "profile-template-1",
        "metadata": metadata,
        "remove_fields": ["basic.job"],
    }


def test_edit_profile_requires_metadata_or_remove_fields(client: Any) -> None:
    with pytest.raises(ValueError, match="metadata or remove_fields is required"):
        client.edit_profile(profile_template_id="profile-template-1", user_id="user-1")


def test_delete_profile_sends_profile_template_and_subject(
    client: Any, posted_requests: list[dict]
) -> None:
    client.delete_profile(profile_template_id="profile-template-1", agent_id="agent-1")

    payload = _json_payload(posted_requests[0])

    assert posted_requests[0]["url"].endswith("/delete/profile")
    assert payload == {
        "user_id": None,
        "agent_id": "agent-1",
        "profile_template_id": "profile-template-1",
    }


def test_profile_subject_requires_exactly_one_user_or_agent(client: Any) -> None:
    with pytest.raises(ValueError, match="exactly one of user_id or agent_id is required"):
        client.delete_profile(profile_template_id="profile-template-1")

    with pytest.raises(ValueError, match="exactly one of user_id or agent_id is required"):
        client.delete_profile(
            profile_template_id="profile-template-1",
            user_id="user-1",
            agent_id="agent-1",
        )


def test_task_status_response_parses_current_object_shape(client_module: Any) -> None:
    response = client_module.MemOSGetTaskStatusResponse(
        code=200,
        message="ok",
        data={
            "task_id": "task-1",
            "status": "running",
            "memory_views": {"added": 1},
        },
    )

    assert response.data.task_id == "task-1"
    assert response.data.status == "running"
    assert response.data.memory_views == {"added": 1}


def test_search_response_keeps_all_current_memory_view_lists(client_module: Any) -> None:
    response = client_module.MemOSSearchResponse(
        code=200,
        message="ok",
        data={
            "memory_detail_list": [],
            "skill_detail_list": [{"id": "skill-1"}],
            "profile_detail_list": [{"id": "profile-1"}],
            "event_detail_list": [{"id": "event-1"}],
        },
    )

    assert response.data.skill_detail_list[0].id == "skill-1"
    assert response.data.profile_detail_list[0].id == "profile-1"
    assert response.data.event_detail_list[0].id == "event-1"


def test_get_memory_response_keeps_views_and_pagination(client_module: Any) -> None:
    response = client_module.MemOSGetMemoryResponse(
        code=200,
        message="ok",
        data={
            "memory_detail_list": [],
            "tool_memory_detail_list": [{"id": "tool-1"}],
            "profile_detail_list": [{"id": "profile-1"}],
            "event_detail_list": [{"id": "event-1"}],
            "skill_detail_list": [{"id": "skill-1"}],
            "total": 21,
            "size": 10,
            "current": 2,
            "pages": 3,
        },
    )

    assert response.data.tool_memory_detail_list[0].id == "tool-1"
    assert response.data.profile_detail_list[0].id == "profile-1"
    assert response.data.event_detail_list[0].id == "event-1"
    assert response.data.skill_detail_list[0].id == "skill-1"
    assert response.data.total == 21
    assert response.data.size == 10
    assert response.data.current == 2
    assert response.data.pages == 3


def test_get_knowledgebase_file_response_keeps_pagination(client_module: Any) -> None:
    response = client_module.MemOSGetKnowledgebaseFileResponse(
        code=200,
        message="ok",
        data={
            "file_detail_list": [],
            "total": 8,
            "page": 2,
            "page_size": 5,
        },
    )

    assert response.data.total == 8
    assert response.data.page == 2
    assert response.data.page_size == 5


def test_get_message_requires_conversation_id(client: Any, posted_requests: list[dict]) -> None:
    with pytest.raises(ValueError, match="conversation_id is required"):
        client.get_message(user_id="user-1")

    assert posted_requests == []


def test_get_message_uses_playground_default_limits(
    client: Any, posted_requests: list[dict]
) -> None:
    client.get_message(user_id="user-1", conversation_id="conversation-1")

    payload = _json_payload(posted_requests[0])

    assert payload["conversation_limit_number"] is None
    assert payload["message_limit_number"] is None


def test_add_message_allows_agent_only_and_generated_conversation(
    client: Any, posted_requests: list[dict]
) -> None:
    client.add_message(
        messages=[{"role": "user", "content": "hello"}],
        user_id=None,
        agent_id="agent-1",
        conversation_id=None,
    )

    payload = _json_payload(posted_requests[0])

    assert payload["user_id"] is None
    assert payload["agent_id"] == "agent-1"
    assert payload["conversation_id"] is None


def test_search_memory_allows_agent_only(client: Any, posted_requests: list[dict]) -> None:
    client.search_memory(query="hello", user_id=None, agent_id="agent-1")

    payload = _json_payload(posted_requests[0])

    assert payload["user_id"] is None
    assert payload["agent_id"] == "agent-1"


def test_search_memory_rejects_multiple_subjects(client: Any, posted_requests: list[dict]) -> None:
    with pytest.raises(ValueError, match="exactly one of user_id or agent_id"):
        client.search_memory(query="hello", user_id="user-1", agent_id="agent-1")

    assert posted_requests == []


def test_create_knowledgebase_allows_empty_description(
    client: Any, posted_requests: list[dict]
) -> None:
    client.create_knowledgebase(knowledgebase_name="Knowledge Base")

    payload = _json_payload(posted_requests[0])

    assert payload == {
        "knowledgebase_name": "Knowledge Base",
        "knowledgebase_description": None,
    }


def test_add_feedback_allows_generated_conversation(
    client: Any, posted_requests: list[dict]
) -> None:
    client.add_feedback(user_id="user-1", feedback_content="helpful")

    payload = _json_payload(posted_requests[0])

    assert payload["conversation_id"] is None
    assert payload["feedback_content"] == "helpful"


def test_chat_uses_playground_sampling_defaults(client: Any, posted_requests: list[dict]) -> None:
    client.chat(user_id="user-1", conversation_id="conversation-1", query="hello")

    payload = _json_payload(posted_requests[0])

    assert payload["temperature"] == 0.7
    assert payload["top_p"] == 0.95


def test_get_memory_rejects_size_above_playground_limit(
    client: Any, posted_requests: list[dict]
) -> None:
    with pytest.raises(ValueError, match="size must be less than or equal to 50"):
        client.get_memory(user_id="user-1", size=51)

    assert posted_requests == []


def test_get_memory_by_id_uses_detail_get_endpoint(
    client: Any, fetched_requests: list[dict]
) -> None:
    response = client.get_memory_by_id("memory-1")

    assert fetched_requests == [
        {
            "url": "https://example.test/openmem/v1/get/memory/memory-1",
            "headers": client.headers,
            "timeout": 30,
        }
    ]
    assert response == {
        "code": 200,
        "message": "ok",
        "data": {"id": "memory-1", "memory_type": "LongTermMemory"},
    }


def test_get_memory_by_id_requires_memid(client: Any, fetched_requests: list[dict]) -> None:
    with pytest.raises(ValueError, match="memid is required"):
        client.get_memory_by_id("")

    assert fetched_requests == []


def test_chat_stream_yields_sse_data_and_closes_response(monkeypatch, client_module: Any) -> None:
    calls: list[dict] = []
    stream_response = DummyStreamResponse(
        [
            "event: message",
            'data: {"response":"first"}',
            "",
            "data: [DONE]",
        ]
    )

    def fake_post(url: str, **kwargs):
        calls.append({"url": url, **kwargs})
        return stream_response

    monkeypatch.setattr(client_module.requests, "post", fake_post)
    client = client_module.MemOSClient(
        api_key="test-key", base_url="https://example.test/openmem/v1"
    )

    chunks = list(
        client.chat(
            user_id="user-1",
            conversation_id="conversation-1",
            query="hello",
            stream=True,
        )
    )

    assert calls[0]["stream"] is True
    assert chunks == ['{"response":"first"}', "[DONE]"]
    assert stream_response.json_called is False
    assert stream_response.closed is True
