"""
Unit tests for product_router input/output format validation.

This module tests that the product_router endpoints correctly validate
input request formats and return properly formatted responses.
"""

from unittest.mock import Mock, patch

import pytest

from fastapi.testclient import TestClient

# Patch the MOS_PRODUCT_INSTANCE directly after import
# Patch MOS_PRODUCT_INSTANCE and MOSProduct so we can test the FastAPI router
# without initializing the full MemOS product stack.
import memos.api.routers.product_router as pr_module


_mock_mos_instance = Mock()
pr_module.MOS_PRODUCT_INSTANCE = _mock_mos_instance
pr_module.get_mos_product_instance = lambda: _mock_mos_instance
with patch("memos.mem_os.product.MOSProduct", return_value=_mock_mos_instance):
    from memos.api import product_api


@pytest.fixture(scope="module")
def mock_mos_product_instance():
    """Mock get_mos_product_instance for all tests."""
    # Ensure the mock is set
    pr_module.MOS_PRODUCT_INSTANCE = _mock_mos_instance
    pr_module.get_mos_product_instance = lambda: _mock_mos_instance
    yield product_api.app, _mock_mos_instance


@pytest.fixture
def client(mock_mos_product_instance):
    """Create test client for product_api."""
    app, _ = mock_mos_product_instance
    return TestClient(app)


@pytest.fixture
def mock_mos_product(mock_mos_product_instance):
    """Get the mocked MOSProduct instance."""
    _, mock_instance = mock_mos_product_instance
    # Ensure get_mos_product_instance returns this mock
    import memos.api.routers.product_router as pr_module

    pr_module.get_mos_product_instance = lambda: mock_instance
    pr_module.MOS_PRODUCT_INSTANCE = mock_instance
    return mock_instance


@pytest.fixture(autouse=True)
def setup_mock_mos_product(mock_mos_product):
    """Set up default return values for MOSProduct methods."""
    # Set up default return values for methods
    mock_mos_product.search.return_value = {"text_mem": [], "act_mem": [], "para_mem": []}
    mock_mos_product.add.return_value = None
    mock_mos_product.chat.return_value = ("test response", [])
    mock_mos_product.chat_with_references.return_value = iter(
        ['data: {"type": "content", "data": "test"}\n\n']
    )
    # Ensure get_all and get_subgraph return proper list format (MemoryResponse expects list)
    default_memory_result = [{"cube_id": "test_cube", "memories": []}]
    mock_mos_product.get_all.return_value = default_memory_result
    mock_mos_product.get_subgraph.return_value = default_memory_result
    mock_mos_product.get_suggestion_query.return_value = ["suggestion1", "suggestion2"]
    # Ensure get_mos_product_instance returns the mock
    import memos.api.routers.product_router as pr_module

    pr_module.get_mos_product_instance = lambda: mock_mos_product


class TestProductRouterSearch:
    """Test /search endpoint input/output format."""

    def test_search_valid_input_output(self, mock_mos_product, client):
        """Test search endpoint with valid input returns correct output format."""
        request_data = {
            "user_id": "test_user",
            "query": "test query",
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

        # Verify MOSProduct.search was called with correct parameters
        mock_mos_product.search.assert_called_once()
        call_kwargs = mock_mos_product.search.call_args[1]
        assert call_kwargs["user_id"] == "test_user"
        assert call_kwargs["query"] == "test query"

    def test_search_invalid_input_missing_user_id(self, mock_mos_product, client):
        """Test search endpoint with missing required field."""
        request_data = {
            "query": "test query",
        }

        response = client.post("/product/search", json=request_data)

        # Should return validation error
        assert response.status_code == 422

    def test_search_response_format(self, mock_mos_product, client):
        """Test search endpoint returns SearchResponse format."""
        mock_mos_product.search.return_value = {
            "text_mem": [{"cube_id": "test_cube", "memories": []}],
            "act_mem": [],
            "para_mem": [],
        }

        request_data = {
            "user_id": "test_user",
            "query": "test query",
        }

        response = client.post("/product/search", json=request_data)

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Search completed successfully"
        assert isinstance(data["data"], dict)
        assert "text_mem" in data["data"]


class TestProductRouterAdd:
    """Test /add endpoint input/output format."""

    def test_add_valid_input_output(self, mock_mos_product, client):
        """Test add endpoint with valid input returns correct output format."""
        request_data = {
            "user_id": "test_user",
            "memory_content": "test memory content",
            "mem_cube_id": "test_cube",
        }

        response = client.post("/product/add", json=request_data)

        assert response.status_code == 200
        data = response.json()

        # Validate response structure
        assert "code" in data
        assert "message" in data
        assert "data" in data
        assert data["code"] == 200
        assert data["data"] is None  # SimpleResponse has None data

        # Verify MOSProduct.add was called with correct parameters
        mock_mos_product.add.assert_called_once()
        call_kwargs = mock_mos_product.add.call_args[1]
        assert call_kwargs["user_id"] == "test_user"
        assert call_kwargs["memory_content"] == "test memory content"

    def test_add_invalid_input_missing_user_id(self, mock_mos_product, client):
        """Test add endpoint with missing required field."""
        request_data = {
            "memory_content": "test memory content",
        }

        response = client.post("/product/add", json=request_data)

        # Should return validation error
        assert response.status_code == 422

    def test_add_response_format(self, mock_mos_product, client):
        """Test add endpoint returns SimpleResponse format."""
        request_data = {
            "user_id": "test_user",
            "memory_content": "test memory content",
        }

        response = client.post("/product/add", json=request_data)

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Memory created successfully"
        assert data["data"] is None


class TestProductRouterChatComplete:
    """Test /chat/complete endpoint input/output format."""

    def test_chat_complete_valid_input_output(self, mock_mos_product, client):
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

        # Verify MOSProduct.chat was called with correct parameters
        mock_mos_product.chat.assert_called_once()
        call_kwargs = mock_mos_product.chat.call_args[1]
        assert call_kwargs["user_id"] == "test_user"
        assert call_kwargs["query"] == "test query"

    def test_chat_complete_invalid_input_missing_user_id(self, mock_mos_product, client):
        """Test chat/complete endpoint with missing required field."""
        request_data = {
            "query": "test query",
        }

        response = client.post("/product/chat/complete", json=request_data)

        # Should return validation error
        assert response.status_code == 422

    def test_chat_complete_response_format(self, mock_mos_product, client):
        """Test chat/complete endpoint returns correct format."""
        mock_mos_product.chat.return_value = ("test response", [{"id": "ref1"}])

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


class TestProductRouterChat:
    """Test /chat endpoint input/output format (SSE stream)."""

    def test_chat_valid_input_output(self, mock_mos_product, client):
        """Test chat endpoint with valid input returns SSE stream."""
        request_data = {
            "user_id": "test_user",
            "query": "test query",
            "mem_cube_id": "test_cube",
        }

        response = client.post("/product/chat", json=request_data)

        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]

        # Verify MOSProduct.chat_with_references was called
        mock_mos_product.chat_with_references.assert_called_once()
        call_kwargs = mock_mos_product.chat_with_references.call_args[1]
        assert call_kwargs["user_id"] == "test_user"
        assert call_kwargs["query"] == "test query"

    def test_chat_invalid_input_missing_user_id(self, mock_mos_product, client):
        """Test chat endpoint with missing required field."""
        request_data = {
            "query": "test query",
        }

        response = client.post("/product/chat", json=request_data)

        # Should return validation error
        assert response.status_code == 422


class TestProductRouterSuggestions:
    """Test /suggestions endpoint input/output format."""

    def test_suggestions_valid_input_output(self, mock_mos_product, client):
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
        assert isinstance(data["data"], dict)
        assert "query" in data["data"]

        # Verify MOSProduct.get_suggestion_query was called
        mock_mos_product.get_suggestion_query.assert_called_once()
        call_kwargs = mock_mos_product.get_suggestion_query.call_args[1]
        assert call_kwargs["user_id"] == "test_user"

    def test_suggestions_invalid_input_missing_user_id(self, mock_mos_product, client):
        """Test suggestions endpoint with missing required field."""
        request_data = {
            "mem_cube_id": "test_cube",
        }

        response = client.post("/product/suggestions", json=request_data)

        # Should return validation error
        assert response.status_code == 422

    def test_suggestions_response_format(self, mock_mos_product, client):
        """Test suggestions endpoint returns SuggestionResponse format."""
        mock_mos_product.get_suggestion_query.return_value = [
            "suggestion1",
            "suggestion2",
            "suggestion3",
        ]

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
        assert isinstance(data["data"]["query"], list)


class TestProductRouterGetAll:
    """Test /get_all endpoint input/output format."""

    def test_get_all_valid_input_output(self, mock_mos_product, client):
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

        # Verify MOSProduct.get_all was called
        mock_mos_product.get_all.assert_called_once()
        call_kwargs = mock_mos_product.get_all.call_args[1]
        assert call_kwargs["user_id"] == "test_user"
        assert call_kwargs["memory_type"] == "text_mem"

    def test_get_all_with_search_query(self, mock_mos_product, client):
        """Test get_all endpoint with search_query uses get_subgraph."""
        # Reset mock call counts
        mock_mos_product.get_all.reset_mock()
        mock_mos_product.get_subgraph.reset_mock()

        request_data = {
            "user_id": "test_user",
            "memory_type": "text_mem",
            "search_query": "test query",
        }

        response = client.post("/product/get_all", json=request_data)

        assert response.status_code == 200
        # Verify get_subgraph was called instead of get_all
        mock_mos_product.get_subgraph.assert_called_once()
        mock_mos_product.get_all.assert_not_called()

    def test_get_all_invalid_input_missing_user_id(self, mock_mos_product, client):
        """Test get_all endpoint with missing required field."""
        request_data = {
            "memory_type": "text_mem",
        }

        response = client.post("/product/get_all", json=request_data)

        # Should return validation error
        assert response.status_code == 422

    def test_get_all_response_format(self, mock_mos_product, client):
        """Test get_all endpoint returns MemoryResponse format."""
        mock_mos_product.get_all.return_value = [{"cube_id": "test_cube", "memories": []}]

        request_data = {
            "user_id": "test_user",
            "memory_type": "text_mem",
        }

        response = client.post("/product/get_all", json=request_data)

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Memories retrieved successfully"
        assert isinstance(data["data"], list)
        assert len(data["data"]) > 0
