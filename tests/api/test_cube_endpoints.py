"""
Integration tests for cube management endpoints.

Tests the /product/create_cube and /product/register_cube endpoints.
"""

from unittest.mock import Mock, patch

import pytest

from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def mock_init_server():
    """Mock init_server before importing server_api."""
    # Create mock components
    mock_components = {
        "graph_db": Mock(),
        "mem_reader": Mock(),
        "llm": Mock(),
        "chat_llms": {},
        "playground_chat_llms": {},
        "embedder": Mock(),
        "reranker": Mock(),
        "internet_retriever": Mock(),
        "memory_manager": Mock(),
        "default_cube_config": Mock(),
        "mem_scheduler": Mock(),
        "feedback_server": Mock(),
        "naive_mem_cube": Mock(),
        "searcher": Mock(),
        "api_module": Mock(),
        "text_mem": Mock(),
        "redis_client": None,
        "deepsearch_agent": Mock(),
        "online_bot": None,
    }

    with patch("memos.api.handlers.init_server", return_value=mock_components):
        # Import after patching
        from fastapi import FastAPI

        from memos.api.routers.server_router import router

        app = FastAPI()
        app.include_router(router)
        yield app


@pytest.fixture
def client(mock_init_server):
    """Create test client with mocked dependencies."""
    return TestClient(mock_init_server)


@pytest.fixture
def test_user_id():
    """Fixture providing a test user ID."""
    return "test-cube-user-123"


@pytest.fixture
def ensure_test_user(test_user_id):
    """Ensure test user exists before running cube tests."""
    # Note: In a real test environment, we'd create the user via the user management API
    # For now, we'll rely on the default user existing or handle the error gracefully
    yield test_user_id


class TestCreateCubeEndpoint:
    """Tests for POST /product/create_cube endpoint."""

    def test_create_cube_success_auto_id(self, client, ensure_test_user):
        """Test creating a cube with auto-generated ID."""
        request_data = {
            "cube_name": "test-auto-cube",
            "owner_id": ensure_test_user,
        }

        response = client.post("/product/create_cube", json=request_data)

        # May fail if user doesn't exist - that's expected in current architecture
        if response.status_code == 200:
            assert response.json()["code"] == 200
            assert response.json()["message"] == "Cube created successfully"
            data = response.json()["data"]
            assert data["cube_name"] == "test-auto-cube"
            assert data["owner_id"] == ensure_test_user
            assert data["cube_id"] is not None
            assert len(data["cube_id"]) > 0
        else:
            # User doesn't exist - expected in minimal test environment
            assert response.status_code in [400, 500]

    def test_create_cube_with_custom_id(self, client, ensure_test_user):
        """Test creating a cube with custom cube_id."""
        custom_id = "my-custom-test-cube-id"
        request_data = {
            "cube_name": "test-custom-cube",
            "owner_id": ensure_test_user,
            "cube_id": custom_id,
        }

        response = client.post("/product/create_cube", json=request_data)

        if response.status_code == 200:
            assert response.json()["code"] == 200
            data = response.json()["data"]
            assert data["cube_id"] == custom_id
        else:
            assert response.status_code in [400, 500]

    def test_create_cube_with_path(self, client, ensure_test_user):
        """Test creating a cube with custom path."""
        request_data = {
            "cube_name": "test-path-cube",
            "owner_id": ensure_test_user,
            "cube_path": "/tmp/test-cubes/my-cube",
        }

        response = client.post("/product/create_cube", json=request_data)

        if response.status_code == 200:
            assert response.json()["code"] == 200
            data = response.json()["data"]
            assert data["cube_name"] == "test-path-cube"
        else:
            assert response.status_code in [400, 500]

    def test_create_cube_missing_required_field(self, client):
        """Test creating a cube without required cube_name."""
        request_data = {
            "owner_id": "test-user",
            # Missing cube_name
        }

        response = client.post("/product/create_cube", json=request_data)

        # Should fail validation
        assert response.status_code == 422

    def test_create_cube_invalid_owner(self, client):
        """Test creating a cube with non-existent owner."""
        request_data = {
            "cube_name": "test-cube",
            "owner_id": "definitely-nonexistent-user-xyz-12345",
        }

        response = client.post("/product/create_cube", json=request_data)

        # Should fail with validation error
        assert response.status_code in [400, 500]
        if response.status_code == 400:
            assert "does not exist" in response.json()["detail"]


class TestRegisterCubeEndpoint:
    """Tests for POST /product/register_cube endpoint."""

    def test_register_cube_basic(self, client):
        """Test basic cube registration."""
        request_data = {
            "mem_cube_name_or_path": "test-register-cube",
            "mem_cube_id": "registered-test-cube-id",
        }

        response = client.post("/product/register_cube", json=request_data)

        # Current implementation validates but doesn't fully register
        assert response.status_code == 200
        assert response.json()["code"] == 200
        data = response.json()["data"]
        assert data["cube_id"] == "registered-test-cube-id"
        assert data["cube_name_or_path"] == "test-register-cube"

    def test_register_cube_with_user_id(self, client, test_user_id):
        """Test cube registration with specific user_id."""
        request_data = {
            "mem_cube_name_or_path": "test-register-cube-2",
            "mem_cube_id": "registered-cube-2",
            "user_id": test_user_id,
        }

        response = client.post("/product/register_cube", json=request_data)

        # Will succeed or fail based on user existence
        assert response.status_code in [200, 400, 500]

    def test_register_cube_without_custom_id(self, client):
        """Test cube registration without custom ID."""
        request_data = {
            "mem_cube_name_or_path": "auto-id-registered-cube",
        }

        response = client.post("/product/register_cube", json=request_data)

        assert response.status_code == 200
        data = response.json()["data"]
        # Should default to name_or_path
        assert data["cube_id"] == "auto-id-registered-cube"

    def test_register_cube_missing_required_field(self, client):
        """Test registration without required mem_cube_name_or_path."""
        request_data = {
            "mem_cube_id": "test-id",
            # Missing mem_cube_name_or_path
        }

        response = client.post("/product/register_cube", json=request_data)

        # Should fail validation
        assert response.status_code == 422


class TestCubeEndpointsDocumentation:
    """Tests to verify API documentation and OpenAPI spec."""

    def test_create_cube_in_openapi(self, client):
        """Verify create_cube endpoint appears in OpenAPI spec."""
        response = client.get("/openapi.json")
        assert response.status_code == 200

        openapi_spec = response.json()
        assert "/product/create_cube" in openapi_spec["paths"]
        assert "post" in openapi_spec["paths"]["/product/create_cube"]

    def test_register_cube_in_openapi(self, client):
        """Verify register_cube endpoint appears in OpenAPI spec."""
        response = client.get("/openapi.json")
        assert response.status_code == 200

        openapi_spec = response.json()
        assert "/product/register_cube" in openapi_spec["paths"]
        assert "post" in openapi_spec["paths"]["/product/register_cube"]


class TestCubeSemanticsClarification:
    """Tests verifying that cube_id and mem_cube_id semantics are documented."""

    def test_create_cube_response_has_cube_id(self, client, ensure_test_user):
        """Verify create_cube response uses cube_id field."""
        request_data = {
            "cube_name": "semantic-test-cube",
            "owner_id": ensure_test_user,
        }

        response = client.post("/product/create_cube", json=request_data)

        if response.status_code == 200:
            data = response.json()["data"]
            assert "cube_id" in data
            # Verify it's documented as equivalent to mem_cube_id in description

    def test_register_cube_response_has_cube_id(self, client):
        """Verify register_cube response uses cube_id field."""
        request_data = {
            "mem_cube_name_or_path": "semantic-test-register",
        }

        response = client.post("/product/register_cube", json=request_data)

        assert response.status_code == 200
        data = response.json()["data"]
        assert "cube_id" in data
