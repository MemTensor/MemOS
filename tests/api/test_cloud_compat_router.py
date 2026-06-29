"""
Integration tests for the cloud-compat router that restores the
/add/message, /search/memory, and /get/memory endpoints used by the
MemOS Cloud OpenClaw plugin (issue #1317).

These endpoints translate the cloud-plugin payload shape into the
internal APISearchRequest / APIADDRequest / GetMemoryRequest models
and delegate to the existing handlers.
"""

from unittest.mock import Mock, patch

import pytest

from fastapi.testclient import TestClient

from memos.api.product_models import (
    APIADDRequest,
    APISearchRequest,
    GetMemoryResponse,
    MemoryResponse,
    SearchResponse,
)


@pytest.fixture(scope="module")
def mock_init_server():
    """Mock init_server so we can import server_api without booting the full stack."""
    mock_components = {
        "graph_db": Mock(),
        "mem_reader": Mock(),
        "llm": Mock(),
        "embedder": Mock(),
        "reranker": Mock(),
        "internet_retriever": Mock(),
        "memory_manager": Mock(),
        "default_cube_config": Mock(),
        "mos_server": Mock(),
        "mem_scheduler": Mock(),
        "feedback_server": Mock(),
        "naive_mem_cube": Mock(),
        "searcher": Mock(),
        "api_module": Mock(),
        "vector_db": None,
        "pref_extractor": None,
        "pref_adder": None,
        "pref_retriever": None,
        "pref_mem": None,
        "online_bot": None,
        "chat_llms": Mock(),
        "redis_client": Mock(),
        "deepsearch_agent": Mock(),
    }

    with patch("memos.api.handlers.init_server", return_value=mock_components):
        from memos.api import server_api

        yield server_api.app


@pytest.fixture
def client(mock_init_server):
    return TestClient(mock_init_server)


@pytest.fixture
def mock_handlers():
    """Mock the underlying server-router handlers that the compat router reuses."""
    with (
        patch("memos.api.routers.server_router.search_handler") as mock_search,
        patch("memos.api.routers.server_router.add_handler") as mock_add,
        patch("memos.api.routers.server_router.handlers.memory_handler") as mock_memory,
    ):
        mock_search.handle_search_memories.return_value = SearchResponse(
            message="Search completed successfully",
            data={"text_mem": [], "act_mem": [], "para_mem": []},
        )
        mock_add.handle_add_memories.return_value = MemoryResponse(
            message="Memory added successfully", data=[]
        )
        mock_memory.handle_get_memories.return_value = GetMemoryResponse(
            message="Memories retrieved successfully", data={}
        )

        yield {
            "search": mock_search,
            "add": mock_add,
            "memory": mock_memory,
        }


class TestSearchMemoryCloudCompat:
    """`POST /search/memory` is the cloud plugin's recall entry point."""

    def test_endpoint_is_registered(self, mock_handlers, client):
        request_body = {
            "query": "hello",
            "user_id": "test_user",
        }
        response = client.post("/search/memory", json=request_body)
        assert response.status_code != 404, (
            "/search/memory must be registered for the cloud plugin to work; "
            f"got {response.status_code}"
        )

    def test_returns_search_response_envelope(self, mock_handlers, client):
        response = client.post(
            "/search/memory",
            json={"query": "hello", "user_id": "test_user"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["code"] == 200
        assert "message" in data
        assert "data" in data

    def test_cloud_plugin_payload_is_mapped_to_internal_request(self, mock_handlers, client):
        """The cloud plugin sends conversation_id / memory_limit_number /
        knowledgebase_ids; verify these are mapped to the internal model."""
        response = client.post(
            "/search/memory",
            json={
                "query": "hello world",
                "user_id": "test_user",
                "conversation_id": "session-abc",
                "memory_limit_number": 7,
                "include_preference": True,
                "preference_limit_number": 4,
                "include_tool_memory": False,
                "tool_memory_limit_number": 3,
                "knowledgebase_ids": ["kb-1", "kb-2"],
                "source": "openclaw",
                "relativity": 0.6,
            },
        )
        assert response.status_code == 200

        mock_handlers["search"].handle_search_memories.assert_called_once()
        call_args = mock_handlers["search"].handle_search_memories.call_args[0][0]
        assert isinstance(call_args, APISearchRequest)
        assert call_args.query == "hello world"
        assert call_args.user_id == "test_user"
        assert call_args.session_id == "session-abc"
        assert call_args.top_k == 7
        assert call_args.include_preference is True
        assert call_args.pref_top_k == 4
        assert call_args.search_tool_memory is False
        assert call_args.tool_mem_top_k == 3
        assert call_args.readable_cube_ids == ["kb-1", "kb-2"]
        assert call_args.source == "openclaw"
        assert call_args.relativity == 0.6

    def test_missing_query_returns_422(self, mock_handlers, client):
        response = client.post(
            "/search/memory",
            json={"user_id": "test_user"},
        )
        assert response.status_code == 422


class TestAddMessageCloudCompat:
    """`POST /add/message` is the cloud plugin's write-back entry point."""

    def test_endpoint_is_registered(self, mock_handlers, client):
        response = client.post(
            "/add/message",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "user_id": "test_user",
                "conversation_id": "session-abc",
            },
        )
        assert response.status_code != 404

    def test_returns_memory_response_envelope(self, mock_handlers, client):
        response = client.post(
            "/add/message",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "user_id": "test_user",
                "conversation_id": "session-abc",
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["code"] == 200
        assert "message" in data
        assert isinstance(data["data"], list)

    def test_cloud_plugin_payload_is_mapped_to_internal_request(self, mock_handlers, client):
        response = client.post(
            "/add/message",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "user_id": "test_user",
                "conversation_id": "session-abc",
                "info": {"custom_key": "custom_value"},
                "source": "openclaw",
                "app_id": "app-1",
                "agent_id": "agent-1",
                "asyncMode": True,
                "tags": ["openclaw", "dev"],
                "allow_public": False,
                "allow_knowledgebase_ids": ["kb-write-1"],
            },
        )
        assert response.status_code == 200

        mock_handlers["add"].handle_add_memories.assert_called_once()
        call_args = mock_handlers["add"].handle_add_memories.call_args[0][0]
        assert isinstance(call_args, APIADDRequest)
        assert call_args.user_id == "test_user"
        assert call_args.session_id == "session-abc"
        assert call_args.messages == [{"role": "user", "content": "hi"}]
        assert call_args.custom_tags == ["openclaw", "dev"]
        assert call_args.writable_cube_ids == ["kb-write-1"]
        assert call_args.async_mode == "async"
        # The plugin's source / app_id / agent_id / allow_public should be
        # merged into the info payload so downstream handlers can read them.
        assert call_args.info["custom_key"] == "custom_value"
        assert call_args.info["source"] == "openclaw"
        assert call_args.info["app_id"] == "app-1"
        assert call_args.info["agent_id"] == "agent-1"
        assert call_args.info["allow_public"] is False

    def test_async_mode_false_maps_to_sync(self, mock_handlers, client):
        response = client.post(
            "/add/message",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "user_id": "test_user",
                "conversation_id": "session-abc",
                "asyncMode": False,
            },
        )
        assert response.status_code == 200
        call_args = mock_handlers["add"].handle_add_memories.call_args[0][0]
        assert call_args.async_mode == "sync"

    def test_snake_case_async_mode_is_also_supported(self, mock_handlers, client):
        response = client.post(
            "/add/message",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "user_id": "test_user",
                "conversation_id": "session-abc",
                "async_mode": "sync",
            },
        )
        assert response.status_code == 200
        call_args = mock_handlers["add"].handle_add_memories.call_args[0][0]
        assert call_args.async_mode == "sync"


class TestGetMemoryCloudCompat:
    """`POST /get/memory` is used by the cloud plugin and Python SDK."""

    def test_endpoint_is_registered(self, mock_handlers, client):
        response = client.post(
            "/get/memory",
            json={"user_id": "test_user", "include_preference": True, "page": 1, "size": 10},
        )
        assert response.status_code != 404

    def test_returns_envelope(self, mock_handlers, client):
        response = client.post(
            "/get/memory",
            json={"user_id": "test_user", "include_preference": True, "page": 1, "size": 10},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["code"] == 200
        assert "message" in data
        assert "data" in data
        mock_handlers["memory"].handle_get_memories.assert_called_once()
