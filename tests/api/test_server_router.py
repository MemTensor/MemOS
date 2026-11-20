"""
Unit tests for server_router input/output format validation.

This module tests that the server_router endpoints correctly validate
input request formats and return properly formatted responses.
"""

from unittest.mock import Mock, patch

import pytest

from fastapi.testclient import TestClient

from memos.api.product_models import (
    APIADDRequest,
    APIChatCompleteRequest,
    APISearchRequest,
    MemoryResponse,
    SearchResponse,
    SuggestionResponse,
)


# Patch init_server so we can import server_api without starting the full MemOS stack,
# and keep sklearn and other core dependencies untouched for other tests.
@pytest.fixture(scope="module")
def mock_init_server():
    """Mock init_server before importing server_api."""
    # Create mock components
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
        # Import after patching
        from memos.api import server_api

        yield server_api.app


@pytest.fixture
def client(mock_init_server):
    """Create test client for server_api."""
    return TestClient(mock_init_server)


@pytest.fixture
def mock_handlers():
    """Mock all handlers used by server_router."""
    with (
        patch("memos.api.routers.server_router.search_handler") as mock_search,
        patch("memos.api.routers.server_router.add_handler") as mock_add,
        patch("memos.api.routers.server_router.chat_handler") as mock_chat,
        patch("memos.api.routers.server_router.handlers.suggestion_handler") as mock_suggestion,
        patch("memos.api.routers.server_router.handlers.memory_handler") as mock_memory,
    ):
        # Set up default return values
        mock_search.handle_search_memories.return_value = SearchResponse(
            message="Search completed successfully",
            data={"text_mem": [], "act_mem": [], "para_mem": []},
        )

        mock_add.handle_add_memories.return_value = MemoryResponse(
            message="Memory added successfully", data=[]
        )

        mock_chat.handle_chat_complete.return_value = {
            "message": "Chat completed successfully",
            "data": {"response": "test response", "references": []},
        }

        mock_suggestion.handle_get_suggestion_queries.return_value = SuggestionResponse(
            message="Suggestions retrieved successfully", data={"query": ["suggestion1"]}
        )

        mock_memory.handle_get_all_memories.return_value = MemoryResponse(
            message="Memories retrieved successfully", data=[]
        )

        mock_memory.handle_get_subgraph.return_value = MemoryResponse(
            message="Memories retrieved successfully", data=[]
        )

        yield {
            "search": mock_search,
            "add": mock_add,
            "chat": mock_chat,
            "suggestion": mock_suggestion,
            "memory": mock_memory,
        }


class TestServerRouterSearch:
    """Test /search endpoint input/output format."""

    def test_search_valid_input_output(self, mock_handlers, client):
        """Test search endpoint with valid input returns correct output format."""
        request_data = {
            "query": "test query",
            "user_id": "test_user",
            "mem_cube_id": "test_cube",
            "top_k": 10,
        }

        response = client.post("/product/search", json=request_data)

        assert response.status_code == 200
        data = response.json()

        # Validate response structure
        assert "code" in data
        assert "message" in data
        assert "data" in data
        assert data["code"] == 200
        assert isinstance(data["data"], dict)

        # Verify handler was called with correct request type
        mock_handlers["search"].handle_search_memories.assert_called_once()
        call_args = mock_handlers["search"].handle_search_memories.call_args[0][0]
        assert isinstance(call_args, APISearchRequest)
        assert call_args.query == "test query"
        assert call_args.user_id == "test_user"

    def test_search_invalid_input_missing_query(self, mock_handlers, client):
        """Test search endpoint with missing required field."""
        request_data = {
            "user_id": "test_user",
        }

        response = client.post("/product/search", json=request_data)

        # Should return validation error
        assert response.status_code == 422

    def test_search_response_format(self, mock_handlers, client):
        """Test search endpoint returns SearchResponse format."""
        mock_handlers["search"].handle_search_memories.return_value = SearchResponse(
            message="Search completed successfully",
            data={
                "text_mem": [{"cube_id": "test_cube", "memories": []}],
                "act_mem": [],
                "para_mem": [],
            },
        )

        request_data = {
            "query": "test query",
            "user_id": "test_user_id",
            "mem_cube_id": "test_cube",
        }

        response = client.post("/product/search", json=request_data)

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Search completed successfully"
        assert isinstance(data["data"], dict)
        assert "text_mem" in data["data"]


class TestServerRouterAdd:
    """Test /add endpoint input/output format."""

    def test_add_valid_input_output(self, mock_handlers, client):
        """Test add endpoint with valid input returns correct output format."""
        request_data = {
            "mem_cube_id": "test_cube",
            "user_id": "test_user",
            "memory_content": "test memory content",
        }

        response = client.post("/product/add", json=request_data)

        assert response.status_code == 200
        data = response.json()

        # Validate response structure
        assert "code" in data
        assert "message" in data
        assert "data" in data
        assert data["code"] == 200
        assert isinstance(data["data"], list)

        # Verify handler was called with correct request type
        mock_handlers["add"].handle_add_memories.assert_called_once()
        call_args = mock_handlers["add"].handle_add_memories.call_args[0][0]
        assert isinstance(call_args, APIADDRequest)
        assert call_args.mem_cube_id == "test_cube"
        assert call_args.user_id == "test_user"

    def test_add_response_format(self, mock_handlers, client):
        """Test add endpoint returns MemoryResponse format."""
        mock_handlers["add"].handle_add_memories.return_value = MemoryResponse(
            message="Memory added successfully",
            data=[{"cube_id": "test_cube", "memories": []}],
        )

        request_data = {
            "mem_cube_id": "test_cube",
            "memory_content": "test memory content",
        }

        response = client.post("/product/add", json=request_data)

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Memory added successfully"
        assert isinstance(data["data"], list)


class TestServerRouterChatComplete:
    """Test /chat/complete endpoint input/output format."""

    def test_chat_complete_valid_input_output(self, mock_handlers, client):
        """Test chat/complete endpoint with valid input returns correct output format."""
        request_data = {
            "user_id": "test_user",
            "query": "test query",
            "mem_cube_id": "test_cube",
        }

        response = client.post("/product/chat/complete", json=request_data)

        assert response.status_code == 200
        data = response.json()

        # Validate response structure
        assert "message" in data
        assert "data" in data
        assert isinstance(data["data"], dict)
        assert "response" in data["data"]
        assert "references" in data["data"]

        # Verify handler was called with correct request type
        mock_handlers["chat"].handle_chat_complete.assert_called_once()
        call_args = mock_handlers["chat"].handle_chat_complete.call_args[0][0]
        assert isinstance(call_args, APIChatCompleteRequest)
        assert call_args.user_id == "test_user"
        assert call_args.query == "test query"

    def test_chat_complete_invalid_input_missing_user_id(self, mock_handlers, client):
        """Test chat/complete endpoint with missing required field."""
        request_data = {
            "query": "test query",
        }

        response = client.post("/product/chat/complete", json=request_data)

        # Should return validation error
        assert response.status_code == 422

    def test_chat_complete_response_format(self, mock_handlers, client):
        """Test chat/complete endpoint returns correct format."""
        mock_handlers["chat"].handle_chat_complete.return_value = {
            "message": "Chat completed successfully",
            "data": {"response": "test response", "references": [{"id": "ref1"}]},
        }

        request_data = {
            "user_id": "test_user",
            "query": "test query",
        }

        response = client.post("/product/chat/complete", json=request_data)

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Chat completed successfully"
        assert isinstance(data["data"]["response"], str)
        assert isinstance(data["data"]["references"], list)


class TestServerRouterSuggestions:
    """Test /suggestions endpoint input/output format."""

    def test_suggestions_valid_input_output(self, mock_handlers, client):
        """Test suggestions endpoint with valid input returns correct output format."""
        request_data = {
            "user_id": "test_user",
            "mem_cube_id": "test_cube",
            "language": "zh",
        }

        response = client.post("/product/suggestions", json=request_data)

        assert response.status_code == 200
        data = response.json()

        # Validate response structure
        assert "code" in data
        assert "message" in data
        assert "data" in data
        assert data["code"] == 200

        # Verify handler was called
        mock_handlers["suggestion"].handle_get_suggestion_queries.assert_called_once()

    def test_suggestions_invalid_input_missing_user_id(self, mock_handlers, client):
        """Test suggestions endpoint with missing required field."""
        request_data = {
            "mem_cube_id": "test_cube",
        }

        response = client.post("/product/suggestions", json=request_data)

        # Should return validation error
        assert response.status_code == 422

    def test_suggestions_response_format(self, mock_handlers, client):
        """Test suggestions endpoint returns SuggestionResponse format."""
        mock_handlers["suggestion"].handle_get_suggestion_queries.return_value = SuggestionResponse(
            message="Suggestions retrieved successfully",
            data={"query": ["suggestion1", "suggestion2"]},
        )

        request_data = {
            "user_id": "test_user",
            "mem_cube_id": "test_cube",
            "language": "en",
        }

        response = client.post("/product/suggestions", json=request_data)

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Suggestions retrieved successfully"
        assert isinstance(data["data"], dict)
        assert "query" in data["data"]


class TestServerRouterGetAll:
    """Test /get_all endpoint input/output format."""

    def test_get_all_valid_input_output(self, mock_handlers, client):
        """Test get_all endpoint with valid input returns correct output format."""
        request_data = {
            "user_id": "test_user",
            "memory_type": "text_mem",
        }

        response = client.post("/product/get_all", json=request_data)

        assert response.status_code == 200
        data = response.json()

        # Validate response structure
        assert "code" in data
        assert "message" in data
        assert "data" in data
        assert data["code"] == 200
        assert isinstance(data["data"], list)

    def test_get_all_with_search_query(self, mock_handlers, client):
        """Test get_all endpoint with search_query uses subgraph handler."""
        request_data = {
            "user_id": "test_user",
            "memory_type": "text_mem",
            "search_query": "test query",
        }

        response = client.post("/product/get_all", json=request_data)

        assert response.status_code == 200
        # Verify subgraph handler was called
        mock_handlers["memory"].handle_get_subgraph.assert_called_once()

    def test_get_all_invalid_input_missing_user_id(self, mock_handlers, client):
        """Test get_all endpoint with missing required field."""
        request_data = {
            "memory_type": "text_mem",
        }

        response = client.post("/product/get_all", json=request_data)

        # Should return validation error
        assert response.status_code == 422

    def test_get_all_response_format(self, mock_handlers, client):
        """Test get_all endpoint returns MemoryResponse format."""
        mock_handlers["memory"].handle_get_all_memories.return_value = MemoryResponse(
            message="Memories retrieved successfully",
            data=[{"cube_id": "test_cube", "memories": []}],
        )

        request_data = {
            "user_id": "test_user",
            "memory_type": "text_mem",
        }

        response = client.post("/product/get_all", json=request_data)

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Memories retrieved successfully"
        assert isinstance(data["data"], list)


@pytest.fixture
def project_mock_client(mock_init_server, monkeypatch):
    import sys

    monkeypatch.setenv("MEMOS_PROJECT_MEMORY_MOCK", "1")
    monkeypatch.delenv("MEMOS_PROJECT_MEMORY_DSN", raising=False)
    monkeypatch.delenv("MEMOS_PROJECT_MEMORY_TENANT_ID", raising=False)
    monkeypatch.setitem(sys.modules, "psycopg2.pool", None)
    with TestClient(mock_init_server) as http:
        yield http
    assert not hasattr(mock_init_server.state, "project_retrieval")


def test_project_mock_search_to_detail_and_original_message(project_mock_client):
    http = project_mock_client
    body = {
        "user_id": "tester",
        "space_ids": ["mock-space"],
        "query": "项目采用什么数据库？",
        "include_memory_view": ["project", "trajectory"],
        "session_id": "mock-session",
    }
    result = http.post("/product/search", json=body)
    assert result.status_code == 200
    data = result.json()["data"]
    (topic,) = data["topic_detail_list"]
    (turn,) = data["trajectory_detail_list"]
    assert topic["id"] == "mock-topic" and turn["conversation_id"] == "mock-session"
    for kind in ("decision", "experience"):
        flat = http.post(
            "/product/search",
            json={
                **body,
                "include_memory_view": ["project"],
                "project_result_format": "item",
                "project_item_types": [kind],
            },
        ).json()["data"]
        (row,) = flat["project_item_list"]
        assert row["id"] == f"mock-{kind}" and row["topic_id"] == topic["id"]
        (detail,) = http.get("/product/get_memory/" + row["id"]).json()["data"]["project_item_list"]
        assert detail["content"] == row["content"]
    meta = http.get("/product/get_memory/" + turn["id"], params={"view": "metadata"}).json()["data"]
    assert meta["cache_policy"] == "immutable" and "content" not in meta
    msgs = http.post("/product/get_message", json={"conversation_id": turn["conversation_id"]})
    assert turn["message_ids"] == [
        m["message_id"] for m in msgs.json()["data"]["message_detail_list"]
    ]
    assert data["channels"] == ["project", "trajectory"]


def test_project_mock_scope_filter_and_page(project_mock_client):
    http = project_mock_client
    body = {
        "user_id": "tester",
        "space_ids": "mock-space",
        "query": "test",
        "include_memory_view": ["project"],
    }
    assert http.post("/product/search", json={**body, "space_ids": ["unknown"]}).status_code == 404
    assert http.post("/product/search", json={**body, "space_ids": None}).status_code == 422
    assert http.post("/product/search", json={**body, "domains": ["unknown"]}).status_code == 400
    detail = http.get("/product/get_memory/mock-experience", params={"space_id": "unknown"})
    assert detail.status_code == 404
    listing = {"space_id": "mock-space", "size": 1}
    data = http.post("/product/get_memory", json=listing).json()["data"]
    assert data["total"] == 1 and data["topic_detail_list"][0]["id"] == "mock-topic"
    page = http.post("/product/get_memory", json={**listing, "page": 2}).json()["data"]
    assert page["total"] == 1 and page["topic_detail_list"] == []
    unmatched = http.post(
        "/product/get_memory", json={**listing, "filter": {"related_id": "unknown"}}
    )
    assert unmatched.json()["data"]["total"] == 0


def test_project_mock_is_explicit_and_never_opens_the_project_database(
    mock_init_server, monkeypatch
):
    import sys

    monkeypatch.delenv("MEMOS_PROJECT_MEMORY_MOCK", raising=False)
    monkeypatch.delenv("MEMOS_PROJECT_MEMORY_DSN", raising=False)
    with TestClient(mock_init_server) as http:
        assert http.post("/product/get_memory", json={"space_id": "mock-space"}).status_code == 500
    monkeypatch.setenv("MEMOS_PROJECT_MEMORY_MOCK", "1")
    monkeypatch.setenv("MEMOS_PROJECT_MEMORY_DSN", "postgresql://unused.invalid/db")
    monkeypatch.setitem(sys.modules, "psycopg2.pool", None)
    with TestClient(mock_init_server) as http:
        assert http.post("/product/get_memory", json={"space_id": "mock-space"}).status_code == 200
